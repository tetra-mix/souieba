import { MIN_TELL_CONTENT_LENGTH } from "./sanitize.ts";

export const TELL_WINDOW_MS = 48 * 60 * 60 * 1000;

export type TellRow = {
  postId: string;
  ownerId: string;
  periodStart: string;
  createdAt: string;
  content: string;
};

/** 上位から選ぶときの重み（1位 0.6 / 2位 0.3 / 3位 0.1） */
const WEIGHTS = [0.6, 0.3, 0.1];

/**
 * Tell する1件を選ぶ。行は SQL 側で「未 TOLD・予約なし・削除なし・公開済み・
 * 現在も Friend」に絞り込まれている前提。
 */
export function selectTellCandidate<T extends TellRow>(
  rows: T[],
  opts: { now: Date; lastToldOwnerId: string | null; random?: () => number },
): T | null {
  const random = opts.random ?? Math.random;
  const minCreated = opts.now.getTime() - TELL_WINDOW_MS;

  const fresh = rows.filter(
    (r) => Date.parse(r.createdAt) >= minCreated && r.content.length >= MIN_TELL_CONTENT_LENGTH,
  );

  // 同じ Owner・同じ時間帯について複数 Agent が書いた投稿は、最新の1件だけ残す
  const byPeriod = new Map<string, T>();
  for (const r of fresh) {
    const key = `${r.ownerId}\u0000${r.periodStart}`;
    const cur = byPeriod.get(key);
    if (!cur || cur.createdAt < r.createdAt) byPeriod.set(key, r);
  }
  let pool = [...byPeriod.values()];
  if (pool.length === 0) return null;

  // 直前に伝えた Owner は、他に候補があれば避ける（ソフト制約）
  if (opts.lastToldOwnerId) {
    const others = pool.filter((r) => r.ownerId !== opts.lastToldOwnerId);
    if (others.length > 0) pool = others;
  }

  pool.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const top = pool.slice(0, WEIGHTS.length);
  const weights = WEIGHTS.slice(0, top.length);
  const total = weights.reduce((s, w) => s + w, 0);
  let x = random() * total;
  for (let i = 0; i < top.length; i++) {
    x -= weights[i]!;
    if (x < 0) return top[i]!;
  }
  return top[top.length - 1]!;
}
