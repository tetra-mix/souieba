export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** メモと近況を扱う最古の期間（Tell の対象期間と同じ48時間） */
export const MAX_POST_AGE_MS = 48 * HOUR_MS;

export function floorToHour(date: Date): Date {
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
}

/** `now` を含む1時間（"current"）か、その直前の1時間（"previous"） */
export function periodOf(now: Date, which: "current" | "previous"): { periodStart: string; periodEnd: string } {
  const start = floorToHour(now).getTime() - (which === "previous" ? HOUR_MS : 0);
  return { periodStart: new Date(start).toISOString(), periodEnd: new Date(start + HOUR_MS).toISOString() };
}
