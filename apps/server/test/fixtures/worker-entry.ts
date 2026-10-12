/**
 * worker.test.ts 用の入口。本番の Worker（src/worker.ts）に、テストだけで使う口を足す。
 * Durable Object の行を数える（削除が行として消えたか確かめる）・時刻を指定して保存期間の削除を走らせる。
 * 本番の wrangler.toml の入口は src/worker.ts のままで、ここはデプロイしない。
 */
import { createDb } from "../../src/db/index.ts";
import { runRetention } from "../../src/retention.ts";
import worker, { SouiebaInstance as Base, type WorkerEnv } from "../../src/worker.ts";

const TABLES = ["posts", "post_recipients", "deliveries"] as const;

type RowCounts = Record<(typeof TABLES)[number], number>;

export class SouiebaInstance extends Base {
  rowCounts(): RowCounts {
    const n = (t: string) => this.ctx.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${t}`).one().n;
    return Object.fromEntries(TABLES.map((t) => [t, n(t)])) as RowCounts;
  }

  retentionAt(now: string, retentionMs: number) {
    return runRetention(createDb(this.ctx.storage), new Date(now), retentionMs);
  }
}

type Stub = { rowCounts(): Promise<RowCounts>; retentionAt(now: string, retentionMs: number): Promise<ReturnType<typeof runRetention>> };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const stub = env.INSTANCE.get(env.INSTANCE.idFromName("default")) as unknown as Stub;
    if (url.pathname === "/__test/rows") return Response.json(await stub.rowCounts());
    if (url.pathname === "/__test/retention") {
      return Response.json(await stub.retentionAt(url.searchParams.get("now")!, Number(url.searchParams.get("retentionMs"))));
    }
    return worker.fetch(req, env);
  },
  scheduled: worker.scheduled,
} satisfies ExportedHandler<WorkerEnv>;
