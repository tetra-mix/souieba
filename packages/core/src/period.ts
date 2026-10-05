export const HOUR_MS = 60 * 60 * 1000;

/** 投稿を受け付ける最古の期間（Tell の対象期間と同じ48時間） */
export const MAX_POST_AGE_MS = 48 * HOUR_MS;

/** 時計のずれを許容する幅 */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export function floorToHour(date: Date): Date {
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
}

/** `now` を含む1時間（"current"）か、その直前の1時間（"previous"） */
export function periodOf(now: Date, which: "current" | "previous"): { periodStart: string; periodEnd: string } {
  const start = floorToHour(now).getTime() - (which === "previous" ? HOUR_MS : 0);
  return { periodStart: new Date(start).toISOString(), periodEnd: new Date(start + HOUR_MS).toISOString() };
}

export type PeriodError = "invalid_date" | "not_hour_aligned" | "not_one_hour" | "in_future" | "too_old";

export function validatePeriod(periodStart: string, periodEnd: string, now: Date): PeriodError | null {
  const start = Date.parse(periodStart);
  const end = Date.parse(periodEnd);
  if (Number.isNaN(start) || Number.isNaN(end)) return "invalid_date";
  if (start % HOUR_MS !== 0) return "not_hour_aligned";
  if (end - start !== HOUR_MS) return "not_one_hour";
  // 進行中の時間帯（デモ用の --period current）は許可し、それより先は拒否する
  if (start > now.getTime() + CLOCK_SKEW_MS) return "in_future";
  if (start < now.getTime() - MAX_POST_AGE_MS) return "too_old";
  return null;
}
