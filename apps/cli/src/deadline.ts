/**
 * 複数の処理を、まとめて1つの期限で打ち切るための小さな道具。
 * 期限を過ぎたか失敗した処理は fallback を返す（元の処理は止めないが、結果は使わない）。
 */
export class Deadline {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly expired: Promise<void>;

  constructor(ms: number) {
    this.expired = new Promise((resolve) => {
      this.timer = setTimeout(resolve, ms);
      // 期限のタイマーだけでプロセスを生かしておかない
      this.timer.unref?.();
    });
  }

  within<T, F>(p: Promise<T>, fallback: F): Promise<T | F> {
    return Promise.race([p.catch(() => fallback), this.expired.then(() => fallback)]);
  }

  clear(): void {
    clearTimeout(this.timer);
  }
}
