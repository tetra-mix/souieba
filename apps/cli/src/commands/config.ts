import { isValidPostIntervalMinutes } from "@souieba/core";
import { POST_INTERVAL_MESSAGE, configPath, loadClientConfig, saveClientConfig } from "@souieba/sdk";
import { usageOf } from "./catalog.ts";
import type { CommandContext } from "./context.ts";

/** CLI の設定項目。名前（config set の第1引数）→ config.json の項目と、値の種類 */
const SETTINGS = {
  "session-gap": { field: "sessionGapMinutes", kind: "minutes" },
  "tell-interval": { field: "tellIntervalMinutes", kind: "minutes" },
  "post-interval": { field: "postIntervalMinutes", kind: "post-interval" },
  "update-check": { field: "updateCheck", kind: "on-off" },
} as const;

export function configCommand({ sub, rest }: CommandContext): void {
  const cfg = loadClientConfig();
  if (!sub || sub === "show") {
    console.log(JSON.stringify({ client: cfg.client ?? {} }, null, 2));
    return;
  }
  if (sub !== "set" && sub !== "unset") throw new Error([usageOf("config"), usageOf("config set"), usageOf("config unset")].join("\n"));
  const key = rest[0];
  const setting = key !== undefined && Object.hasOwn(SETTINGS, key) ? SETTINGS[key as keyof typeof SETTINGS] : undefined;
  if (!key || !setting) throw new Error(`設定項目は ${Object.keys(SETTINGS).join(" / ")} です`);
  cfg.client ??= {};
  if (sub === "unset") {
    delete cfg.client[setting.field];
    saveClientConfig(cfg);
    console.log(`${key} を既定に戻しました`);
    return;
  }
  const value = rest[1];
  if (value === undefined) throw new Error(usageOf("config set"));
  if (setting.kind === "on-off") {
    if (value !== "on" && value !== "off") throw new Error(`${key} は on または off で指定してください`);
    cfg.client.updateCheck = value === "on";
  } else {
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes < 0) throw new Error(`${key} は0以上の分数で指定してください`);
    if (setting.kind === "post-interval" && !isValidPostIntervalMinutes(minutes)) throw new Error(POST_INTERVAL_MESSAGE);
    cfg.client[setting.field] = minutes;
  }
  saveClientConfig(cfg);
  console.log(`${key} を ${value} に設定しました（${configPath()}）`);
}
