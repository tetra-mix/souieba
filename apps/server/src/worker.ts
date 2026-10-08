/**
 * Cloudflare Workers の入口。1つのインスタンス = Durable Object 1個（SQLite）。
 * Worker は検査とレート制限だけを行い、Durable Object の中で app.ts（セルフホストと同じアプリ）を動かす。
 * 設計: docs/cloudflare-workers-plan.md
 */
import { DurableObject } from "cloudflare:workers";
import { createApp } from "./app.ts";
import { type Config, loadConfig } from "./config.ts";
import { type DB, createDb, migrate } from "./db/index.ts";
import { clientIp, edgeGuard } from "./edge.ts";
import { runRetention } from "./retention.ts";

type RateLimit = { limit(options: { key: string }): Promise<{ success: boolean }> };

export type WorkerEnv = {
  INSTANCE: DurableObjectNamespace<SouiebaInstance>;
  /** Workers の Rate Limiting。wrangler.toml の [[ratelimits]] で設定する（なければ使わない） */
  RATE_LIMITER?: RateLimit;
} & Record<string, unknown>;

/** 将来インスタンスを分けるときは、ここで名前を引き分ける（今は1つだけ） */
const INSTANCE_NAME = "default";

function workerConfig(env: WorkerEnv): Config {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") vars[k] = v;
  return loadConfig({
    ...vars,
    // https は Cloudflare が終端し、送信元は CF-Connecting-IP で分かるので、X-Forwarded-For は使わない
    SOUIEBA_TRUST_PROXY: "none",
    // サーバ上でコマンドを実行できないので、管理は admin API で行う
    SOUIEBA_ADMIN_API: "on",
  });
}

export class SouiebaInstance extends DurableObject<WorkerEnv> {
  private readonly db: DB;
  private readonly config: Config;
  private readonly app: ReturnType<typeof createApp>;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.db = createDb(ctx.storage);
    this.config = workerConfig(env);
    // マイグレーションが終わるまで、リクエストを受け付けない
    ctx.blockConcurrencyWhile(async () => migrate(this.db));
    this.app = createApp({ db: this.db, config: this.config, remoteAddr: (c) => clientIp(c.req.raw) });
  }

  override fetch(req: Request): Response | Promise<Response> {
    return this.app.fetch(req);
  }

  retention() {
    return runRetention(this.db, new Date(), this.config.postRetentionMs);
  }
}

const instance = (env: WorkerEnv) => env.INSTANCE.get(env.INSTANCE.idFromName(INSTANCE_NAME));

export default {
  async fetch(req, env) {
    const blocked = edgeGuard(req);
    if (blocked) return blocked;
    if (env.RATE_LIMITER) {
      const { success } = await env.RATE_LIMITER.limit({ key: clientIp(req) });
      if (!success) {
        return Response.json({ error: { code: "rate_limited", message: "リクエストが多すぎます" } }, { status: 429 });
      }
    }
    return instance(env).fetch(req);
  },

  async scheduled(_controller, env) {
    const r = await instance(env).retention();
    console.log(JSON.stringify({ level: "info", msg: "retention", ...r }));
  },
} satisfies ExportedHandler<WorkerEnv>;
