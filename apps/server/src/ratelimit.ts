/** メモリ上の固定ウィンドウ方式。1インスタンス・少人数の前提なのでこれで十分 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** 許可されたら true */
  take(key: string, now: number): boolean {
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 10_000) this.sweep(now);
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

  private sweep(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
