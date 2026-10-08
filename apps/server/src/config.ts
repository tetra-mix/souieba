import { z } from "zod";
import { isLoopback } from "./net.ts";

const EnvSchema = z.object({
  SOUIEBA_PUBLIC_URL: z.string().url(),
  SOUIEBA_BIND: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  SOUIEBA_TRUST_PROXY: z.enum(["loopback", "private", "none"]).default("loopback"),
  SOUIEBA_INSTANCE_NAME: z.string().min(1).default("Souieba"),
  SOUIEBA_DATA_DIR: z.string().default("/data"),
  SOUIEBA_INVITE_BY: z.enum(["member", "admin"]).default("member"),
  SOUIEBA_GROUP_CREATE_BY: z.enum(["member", "admin"]).default("member"),
  SOUIEBA_POST_GRACE_MINUTES: z.coerce.number().int().min(0).default(10),
  SOUIEBA_POST_RETENTION_DAYS: z.coerce.number().int().min(3).default(30),
  SOUIEBA_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = {
  publicUrl: string;
  bind: string;
  port: number;
  /** X-Forwarded-For を信頼する直前の接続元。private は Docker のブリッジ上のリバースプロキシ用 */
  trustProxy: "loopback" | "private" | "none";
  instanceName: string;
  dataDir: string;
  /** グループへの招待: member ならメンバー全員、admin なら owner だけ */
  inviteBy: "member" | "admin";
  groupCreateBy: "member" | "admin";
  postGraceMs: number;
  postRetentionMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
};

export class ConfigError extends Error {}

/**
 * 環境変数を検証する。サーバはインターネットに公開する前提で、通信路は https にする。
 * http は、手元で動かす開発用（PUBLIC_URL がループバック）のときだけ許す。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
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
    instanceName: e.SOUIEBA_INSTANCE_NAME,
    dataDir: e.SOUIEBA_DATA_DIR,
    inviteBy: e.SOUIEBA_INVITE_BY,
    groupCreateBy: e.SOUIEBA_GROUP_CREATE_BY,
    postGraceMs: e.SOUIEBA_POST_GRACE_MINUTES * 60_000,
    postRetentionMs: e.SOUIEBA_POST_RETENTION_DAYS * 86_400_000,
    logLevel: e.SOUIEBA_LOG_LEVEL,
  };
}
