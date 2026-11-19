export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** メモと近況を扱う最古の期間（Tell の対象期間と同じ48時間） */
export const MAX_POST_AGE_MS = 48 * HOUR_MS;

/** 投稿の時間帯の長さの既定（1時間）。CLI の設定 post-interval で変えられる */
export const DEFAULT_POST_INTERVAL_MS = HOUR_MS;

/** 投稿の間隔（分）として使えるか。5分以上24時間以下で、1日を割り切る（時間帯が日をまたいでずれないように） */
export function isValidPostIntervalMinutes(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= 5 && minutes <= 1440 && 1440 % minutes === 0;
}

/** `date` を含む時間帯の開始時刻（時間帯は、エポックからの intervalMs ごとの区切り） */
export function floorTo(date: Date, intervalMs: number): Date {
  return new Date(Math.floor(date.getTime() / intervalMs) * intervalMs);
}

/** `now` を含む時間帯（"current"）か、その直前の時間帯（"previous"）。長さは既定で1時間 */
export function periodOf(
  now: Date,
  which: "current" | "previous",
  intervalMs: number = DEFAULT_POST_INTERVAL_MS,
): { periodStart: string; periodEnd: string } {
  const start = floorTo(now, intervalMs).getTime() - (which === "previous" ? intervalMs : 0);
  return { periodStart: new Date(start).toISOString(), periodEnd: new Date(start + intervalMs).toISOString() };
}
