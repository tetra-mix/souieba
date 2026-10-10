import { randomUUID } from "node:crypto";

export type SessionState = {
  sessionId: string;
  lastMessageAt: string;
  tellsInSession: number;
};

export const DEFAULT_SESSION_GAP_MS = 10 * 60 * 1000;

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

export function canTell(state: SessionState, maxPerSession = 1): boolean {
  return state.tellsInSession < maxPerSession;
}
