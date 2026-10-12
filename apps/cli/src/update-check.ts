/**
 * npm に新しい版の CLI が出ていないかを確かめる。tell の結果に添えて、エージェントから主人に更新を勧めてもらう。
 * 発言ごとに npm へ問い合わせないよう、結果は ~/.souieba/update-check.json に1日覚え、同じ版を知らせるのも1日に1回にする。
 * SOUIEBA_NO_UPDATE_CHECK を設定すると確かめない（テストや、外に通信したくない環境のため）。
 */
import { join } from "node:path";
import { compareVersions } from "@souieba/core";
import { readStateJson, souiebaHome, writeSecretJson } from "@souieba/sdk";
import { CLI_VERSION } from "./version.ts";

const CHECK_INTERVAL_MS = 24 * 3_600_000;
const NOTIFY_INTERVAL_MS = 24 * 3_600_000;
const FETCH_TIMEOUT_MS = 2_000;

type UpdateCache = { checkedAt?: string; latest?: string | null; notifiedVersion?: string; notifiedAt?: string };

const cachePath = () => join(souiebaHome(), "update-check.json");
const registryUrl = () => process.env.SOUIEBA_UPDATE_URL ?? "https://registry.npmjs.org/souieba/latest";

function readCache(): UpdateCache {
  return readStateJson<UpdateCache>(cachePath()) ?? {};
}

async function fetchLatest(): Promise<string | null> {
  try {
    const res = await fetch(registryUrl(), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const v = ((await res.json()) as { version?: unknown }).version;
    return typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** npm にある最新の版。1日以内に確かめていれば覚えている値を返す。force なら必ず問い合わせる（doctor 用） */
export async function latestVersion(now: Date, opts: { force?: boolean } = {}): Promise<string | null> {
  if (process.env.SOUIEBA_NO_UPDATE_CHECK) return null;
  const cache = readCache();
  const fresh = cache.checkedAt && now.getTime() - Date.parse(cache.checkedAt) < CHECK_INTERVAL_MS;
  if (fresh && !opts.force) return cache.latest ?? null;
  // 問い合わせに失敗しても checkedAt は進める（通信できないあいだ、発言ごとに待たないため）。覚えていた版はそのまま使う
  const latest = (await fetchLatest()) ?? cache.latest ?? null;
  writeSecretJson(cachePath(), { ...readCache(), checkedAt: now.toISOString(), latest });
  return latest;
}

/** この CLI より新しい版があれば、その版 */
export function newerThanCurrent(latest: string | null): string | null {
  return latest && compareVersions(latest, CLI_VERSION) > 0 ? latest : null;
}

/**
 * tell で主人に知らせる新しい版。まだ知らせていないか、前に知らせてから1日たっていれば返して、知らせたことを記録する。
 * canRecord が false を返したら（tell の期限を過ぎたら）記録せずに null を返す（知らせないまま知らせた扱いにしないため）
 */
export async function updateToNotify(now: Date, canRecord: () => boolean = () => true): Promise<string | null> {
  const v = newerThanCurrent(await latestVersion(now));
  if (!v || !canRecord()) return null;
  const cache = readCache();
  if (cache.notifiedVersion === v && cache.notifiedAt && now.getTime() - Date.parse(cache.notifiedAt) < NOTIFY_INTERVAL_MS) return null;
  writeSecretJson(cachePath(), { ...cache, notifiedVersion: v, notifiedAt: now.toISOString() });
  return v;
}

/** 更新を勧める文面（エージェントが主人に伝える） */
export function updateAdvice(latest: string): string {
  return `Souieba の CLI に新しいバージョン ${latest} が出ています（今は ${CLI_VERSION}）。npm i -g souieba@latest で CLI を、npx skills update でスキルを更新してください`;
}
