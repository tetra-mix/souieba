import { isIP } from "node:net";
import { z } from "zod";
import { type Cidr, isPrivateOrLoopback, parseCidr } from "./net.ts";

const bool = z.enum(["0", "1"]).transform((v) => v === "1");

const EnvSchema = z.object({
  SOUIEBA_EXPOSURE: z.enum(["vpn", "public"]).default("vpn"),
  SOUIEBA_PUBLIC_URL: z.string().url(),
  SOUIEBA_BIND: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  SOUIEBA_ALLOWED_CIDRS: z.string().default(""),
  SOUIEBA_ALLOW_HTTP: bool.default("0"),
  SOUIEBA_TRUST_PROXY: z.enum(["loopback", "private", "none"]).default("loopback"),
  SOUIEBA_INSTANCE_NAME: z.string().min(1).default("Souieba"),
  SOUIEBA_DATA_DIR: z.string().default("/data"),
  SOUIEBA_INVITE_BY: z.enum(["member", "admin"]).default("member"),
  SOUIEBA_GROUP_CREATE_BY: z.enum(["member", "admin"]).default("member"),
  SOUIEBA_POST_GRACE_MINUTES: z.coerce.number().int().min(0).default(10),
  SOUIEBA_POST_RETENTION_DAYS: z.coerce.number().int().min(3).default(14),
  SOUIEBA_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = {
  /** vpn: VPN 内だけで待ち受ける（既定） / public: インターネットに公開する */
  exposure: "vpn" | "public";
  publicUrl: string;
  bind: string;
  port: number;
  allowedCidrs: Cidr[];
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

const WILDCARD = new Set(["0.0.0.0", "::", "[::]", ""]);

/**
 * 環境変数を検証する。
 * vpn モードでは、誤ってインターネットに公開してしまう設定を起動前に拒否する。
 * public モードでは公開を許す代わりに、https と、信頼するプロキシの明示を求める。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new ConfigError(`設定が不正です:\n  ${msg}`);
  }
  const e = parsed.data;

  const allowedCidrs = e.SOUIEBA_ALLOWED_CIDRS.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((c) => {
      const r = parseCidr(c);
      if (!r) throw new ConfigError(`SOUIEBA_ALLOWED_CIDRS の値が不正です: ${c}`);
      return r;
    });

  const url = new URL(e.SOUIEBA_PUBLIC_URL);

  if (e.SOUIEBA_EXPOSURE === "public") {
    if (url.protocol !== "https:") throw new ConfigError("SOUIEBA_EXPOSURE=public では SOUIEBA_PUBLIC_URL を https にしてください。");
    if (e.SOUIEBA_ALLOW_HTTP) throw new ConfigError("SOUIEBA_EXPOSURE=public では SOUIEBA_ALLOW_HTTP は使えません。");
    if (!env.SOUIEBA_TRUST_PROXY) {
      throw new ConfigError(
        "SOUIEBA_EXPOSURE=public では SOUIEBA_TRUST_PROXY を明示してください（リバースプロキシが同じホストなら loopback、Docker のブリッジ上なら private）。",
      );
    }
  } else if (WILDCARD.has(e.SOUIEBA_BIND) && allowedCidrs.length === 0) {
    throw new ConfigError(
      `SOUIEBA_BIND=${e.SOUIEBA_BIND} はすべてのインターフェースで待ち受けます。` +
        "VPN の IP を指定するか、SOUIEBA_ALLOWED_CIDRS で送信元を制限してください。",
    );
  }
  if (
    e.SOUIEBA_EXPOSURE === "vpn" &&
    !WILDCARD.has(e.SOUIEBA_BIND) &&
    isIP(e.SOUIEBA_BIND) &&
    !isPrivateOrLoopback(e.SOUIEBA_BIND)
  ) {
    throw new ConfigError(
      `SOUIEBA_BIND=${e.SOUIEBA_BIND} はグローバル IP です。インターネットに公開する場合は SOUIEBA_EXPOSURE=public を設定してください。`,
    );
  }
  if (url.protocol !== "https:" && !e.SOUIEBA_ALLOW_HTTP) {
    throw new ConfigError("SOUIEBA_PUBLIC_URL が https ではありません。VPN が通信路を暗号化している場合だけ SOUIEBA_ALLOW_HTTP=1 を設定してください。");
  }

  return {
    exposure: e.SOUIEBA_EXPOSURE,
    publicUrl: url.origin,
    bind: e.SOUIEBA_BIND,
    port: e.PORT,
    allowedCidrs,
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
