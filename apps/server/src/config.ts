import { z } from "zod";
import { isLoopback } from "./net.ts";

const EnvSchema = z.object({
  SOUIEBA_PUBLIC_URL: z.string().url(),
  SOUIEBA_BIND: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  SOUIEBA_TRUST_PROXY: z.enum(["loopback", "private", "none"]).default("loopback"),
  SOUIEBA_DATA_DIR: z.string().default("/data"),
  SOUIEBA_POST_GRACE_MINUTES: z.coerce.number().int().min(0).default(10),
  SOUIEBA_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** v2 の Relay（/v2/*）。open なら誰でもPersonを登録できる（アカウントは要らない）。off なら閉じる */
  SOUIEBA_RELAY: z.enum(["open", "off"]).default("open"),
  SOUIEBA_MAX_RELAY_AGENTS: z.coerce.number().int().min(1).default(1000),
});

export type Config = {
  publicUrl: string;
  bind: string;
  port: number;
  /** X-Forwarded-For を信頼する直前の接続元。private は Docker のブリッジ上のリバースプロキシ用 */
  trustProxy: "loopback" | "private" | "none";
  dataDir: string;
  postGraceMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  /** v2 の Relay（docs/design/server.md） */
  relay: { enabled: boolean; maxAgents: number };
};

export class ConfigError extends Error {}

/**
 * 環境変数を検証する。サーバはインターネットに公開する前提で、通信路は https にする。
 * http は、手元で動かす開発用（PUBLIC_URL がループバック）のときだけ許す。
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new ConfigError(`設定が不正です:\n  ${msg}`);
  }
  const e = parsed.data;

  const url = new URL(e.SOUIEBA_PUBLIC_URL);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" && !(host === "localhost" || isLoopback(host))) {
    throw new ConfigError("SOUIEBA_PUBLIC_URL は https にしてください（http は手元で動かす開発用の localhost / 127.0.0.1 だけ）。");
  }

  return {
    publicUrl: url.origin,
    bind: e.SOUIEBA_BIND,
    port: e.PORT,
    trustProxy: e.SOUIEBA_TRUST_PROXY,
    dataDir: e.SOUIEBA_DATA_DIR,
    postGraceMs: e.SOUIEBA_POST_GRACE_MINUTES * 60_000,
    logLevel: e.SOUIEBA_LOG_LEVEL,
    relay: { enabled: e.SOUIEBA_RELAY === "open", maxAgents: e.SOUIEBA_MAX_RELAY_AGENTS },
  };
}
