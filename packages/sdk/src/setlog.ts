import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CreatePostInput,
  DEFAULT_SESSION_GAP_MS,
  type SessionState,
  type TellCandidate,
  advanceSession,
  canTell,
  periodOf,
} from "@souieba/core";
import { souiebaHome, writeSecretJson } from "./config.ts";
import type { SetLogTransport } from "./transport.ts";

export type SetLogOptions = {
  transport: SetLogTransport;
  /** Session 状態の保存先。省略時は ~/.souieba/state/<stateKey>.json */
  statePath?: string;
  stateKey?: string;
  sessionGapMs?: number;
  maxTellsPerSession?: number;
  now?: () => Date;
  onError?: (op: string, err: unknown) => void;
};

/**
 * Agent 実装から使う高水準 API。SetLog の内部構造（受信箱・予約・Session）を意識させない。
 * ネットワーク障害で会話を止めないよう、Tell 系は失敗しても null を返す。
 */
export class SetLog {
  private readonly transport: SetLogTransport;
  private readonly statePath: string;
  private readonly gapMs: number;
  private readonly maxTells: number;
  private readonly now: () => Date;
  private readonly onError: (op: string, err: unknown) => void;
  private state: SessionState | null;

  constructor(opts: SetLogOptions) {
    this.transport = opts.transport;
    this.statePath = opts.statePath ?? join(souiebaHome(), "state", `${opts.stateKey ?? "default"}.json`);
    this.gapMs = opts.sessionGapMs ?? DEFAULT_SESSION_GAP_MS;
    this.maxTells = opts.maxTellsPerSession ?? 1;
    this.now = opts.now ?? (() => new Date());
    this.onError = opts.onError ?? (() => {});
    this.state = existsSync(this.statePath) ? (JSON.parse(readFileSync(this.statePath, "utf8")) as SessionState) : null;
  }

  get session(): SessionState | null {
    return this.state;
  }

  /** ユーザーの発話ごとに呼ぶ */
  beginTurn(): { sessionId: string; isNewSession: boolean } {
    const { state, isNewSession } = advanceSession(this.state, this.now(), this.gapMs);
    this.state = state;
    this.persist();
    return { sessionId: state.sessionId, isNewSession };
  }

  publish(input: Omit<CreatePostInput, "periodStart" | "periodEnd"> & { period?: "current" | "previous" }) {
    const { period = "previous", ...rest } = input;
    return this.transport.publish({ ...periodOf(this.now(), period), ...rest });
  }

  sync() {
    return this.transport.sync();
  }

  /**
   * この Session でまだ Tell していなければ、同期してから候補を1件予約する。
   * 何も伝えるものがない・通信できない場合は null。
   */
  async pickTellCandidate(): Promise<TellCandidate | null> {
    if (!this.state || !canTell(this.state, this.maxTells)) return null;
    try {
      await this.transport.sync();
      return await this.transport.claimTell();
    } catch (err) {
      this.onError("pickTellCandidate", err);
      return null;
    }
  }

  async markAsTold(postId: string): Promise<boolean> {
    try {
      await this.transport.markAsTold(postId);
      if (this.state) {
        this.state = { ...this.state, tellsInSession: this.state.tellsInSession + 1 };
        this.persist();
      }
      return true;
    } catch (err) {
      this.onError("markAsTold", err);
      return false;
    }
  }

  async release(postId: string): Promise<void> {
    try {
      await this.transport.release(postId);
    } catch (err) {
      // 予約はリース切れで自然に解放されるので、失敗しても致命的ではない
      this.onError("release", err);
    }
  }

  private persist() {
    writeSecretJson(this.statePath, this.state);
  }
}
