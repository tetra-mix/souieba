/** 覚えておくキーの上限。超えたら古いものから忘れる（多数の送信元からの要求でメモリを使い切らないように） */
export const MAX_KEYS = 10_000;

/** メモリ上の固定ウィンドウ方式。1インスタンス・少人数の前提なのでこれで十分 */
export class RateLimiter {
  /** Map は挿入順なので、数え始めるたびに入れ直すと、先頭ほど早く期限が切れる */
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = MAX_KEYS,
  ) {}

  /** 許可されたら true */
  take(key: string, now: number): boolean {
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) {
      this.hits.delete(key);
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      this.prune(now);
      return true;
    }
    cur.count++;
    return cur.count <= this.limit;
  }

  /** 上限に達しているか（数えずに確かめる） */
  blocked(key: string, now: number): boolean {
    const cur = this.hits.get(key);
    return !!cur && cur.resetAt > now && cur.count >= this.limit;
  }

  get size(): number {
    return this.hits.size;
  }

  /** 期限の切れたものと、上限を超えた分を先頭から消す。期限の切れていないものに当たったら止まる */
  private prune(now: number) {
    for (const [k, v] of this.hits) {
      if (v.resetAt > now && this.hits.size <= this.maxKeys) break;
      this.hits.delete(k);
    }
  }
}
