import { configPath, loadClientConfig, saveClientConfig } from "@souieba/sdk";
import type { CommandContext } from "./context.ts";

export function configCommand({ sub, rest }: CommandContext): void {
  const cfg = loadClientConfig();
  if (!sub || sub === "show") {
    console.log(JSON.stringify({ client: cfg.client ?? {} }, null, 2));
    return;
  }
  if (sub !== "set" && sub !== "unset") throw new Error("souieba config [show] | config set <session-gap|tell-interval|update-check> <値> | config unset <項目>");
  const key = rest[0];
  if (!key || !["session-gap", "tell-interval", "update-check"].includes(key)) {
    throw new Error("設定項目は session-gap / tell-interval / update-check です");
  }
  cfg.client ??= {};
  const field = key === "session-gap" ? "sessionGapMinutes" : key === "tell-interval" ? "tellIntervalMinutes" : "updateCheck";
  if (sub === "unset") {
    delete cfg.client[field];
    saveClientConfig(cfg);
    console.log(`${key} を既定に戻しました`);
    return;
  }
  const value = rest[1];
  if (value === undefined) throw new Error(`souieba config set ${key} <値>`);
  if (field === "updateCheck") {
    if (value !== "on" && value !== "off") throw new Error("update-check は on または off で指定してください");
    cfg.client.updateCheck = value === "on";
  } else {
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes < 0) throw new Error(`${key} は0以上の分数で指定してください`);
    cfg.client[field] = minutes;
  }
  saveClientConfig(cfg);
  console.log(`${key} を ${value} に設定しました（${configPath()}）`);
}
