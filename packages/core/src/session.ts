import { randomUUID } from "node:crypto";

export type SessionState = {
  sessionId: string;
  lastMessageAt: string;
  tellsInSession: number;
  /** 最後に Tell した時刻。この Session でまだなら undefined */
  lastToldAt?: string;
};

export const DEFAULT_SESSION_GAP_MS = 10 * 60 * 1000;

/** 同じ Session の途中でも、前の Tell からこれだけたてば次の1件を伝える */
export const DEFAULT_TELL_INTERVAL_MS = 10 * 60 * 1000;

/** ユーザー発話のたびに呼ぶ。前回から gap 以上空いていれば新しい Session にする */
export function advanceSession(
  prev: SessionState | null,
  now: Date,
  gapMs: number = DEFAULT_SESSION_GAP_MS,
): { state: SessionState; isNewSession: boolean } {
  const isNewSession = prev === null || now.getTime() - Date.parse(prev.lastMessageAt) >= gapMs;
  const state: SessionState = isNewSession
    ? { sessionId: randomUUID(), lastMessageAt: now.toISOString(), tellsInSession: 0 }
    : { ...prev, lastMessageAt: now.toISOString() };
  return { state, isNewSession };
}

/**
 * この Session で伝えた数が上限に届いていなければ伝える。
 * 届いていても、前の Tell から intervalMs たっていれば、続けて作業している途中でも次の1件を伝える。
 */
export function canTell(
  state: SessionState,
  maxPerSession = 1,
  now: Date = new Date(),
  intervalMs: number = DEFAULT_TELL_INTERVAL_MS,
): boolean {
  if (state.tellsInSession < maxPerSession) return true;
  return state.lastToldAt !== undefined && now.getTime() - Date.parse(state.lastToldAt) >= intervalMs;
}
