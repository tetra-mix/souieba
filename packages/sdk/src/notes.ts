import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { HOUR_MS, MAX_POST_AGE_MS, floorToHour, sanitizeContent, scanSecrets } from "@souieba/core";
import { readStateJson, souiebaHome, writeSecretJson } from "./config.ts";

export type Note = { ts: string; text: string };

export type PendingPeriod = {
  periodStart: string;
  periodEnd: string;
  notes: Note[];
};

type PeriodsFile = { done: Record<string, "published" | "skipped"> };

export class SecretInNoteError extends Error {
  constructor(readonly rules: string[]) {
    super(`秘密情報の可能性があるため記録しませんでした（${rules.join(", ")}）`);
  }
}

/** 1件のメモの上限。要約の材料なので短くてよい */
export const MAX_NOTE_LENGTH = 200;

/** これより古いロックは、持ち主が落ちたものとみなして壊す */
export const NOTES_LOCK_STALE_MS = 5_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 20;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * notes.jsonl のそばにロックファイルを作り、別プロセスの追記と書き換えがぶつからないようにする。
 * 同期 API のまま使えるよう、待ちは Atomics.wait で行う。
 */
function withLock<T>(lockPath: string, fn: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx", 0o600));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > NOTES_LOCK_STALE_MS) {
        // 別の名前に移してから消す。移せなかったら他のプロセスが先に壊したので取り直す
        const stale = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
        renameSync(lockPath, stale);
        unlinkSync(stale);
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() > deadline) throw new Error(`メモのロックを取れませんでした（${lockPath}）`);
    sleepSync(LOCK_RETRY_MS);
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // 壊されていた場合は何もしない
    }
  }
}

/** 同じディレクトリの一時ファイルに書いてから置き換える。途中で落ちても元のファイルは壊れない */
function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 作られていなければよい
    }
    throw e;
  }
}

/**
 * エージェントが会話中に残す「主人について知ったこと」のメモ。
 * 定期実行（cron）は会話履歴のない新しいセッションで動くことがあるため、
 * 投稿の材料は会話の中でローカルに書き溜めておく。サーバには送らない。
 */
export class NotesStore {
  private readonly notesPath: string;
  private readonly periodsPath: string;
  private readonly lockPath: string;

  constructor(agentKey: string, dir = join(souiebaHome(), "agents", agentKey)) {
    this.notesPath = join(dir, "notes.jsonl");
    this.lockPath = join(dir, "notes.lock");
    this.periodsPath = join(dir, "periods.json");
  }

  add(text: string, now: Date): Note {
    const clean = sanitizeContent(text).slice(0, MAX_NOTE_LENGTH);
    if (!clean) throw new Error("メモが空です");
    const findings = [...scanSecrets(text), ...scanSecrets(clean)];
    if (findings.length > 0) throw new SecretInNoteError([...new Set(findings.map((f) => f.rule))]);
    const note = { ts: now.toISOString(), text: clean };
    withLock(this.lockPath, () => appendFileSync(this.notesPath, `${JSON.stringify(note)}\n`, { mode: 0o600 }));
    return note;
  }

  all(): Note[] {
    if (!existsSync(this.notesPath)) return [];
    return readFileSync(this.notesPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Note];
        } catch {
          return [];
        }
      });
  }

  notesIn(periodStart: string): Note[] {
    const start = Date.parse(periodStart);
    return this.all().filter((n) => {
      const t = Date.parse(n.ts);
      return t >= start && t < start + HOUR_MS;
    });
  }

  /** メモがあり、まだ投稿もスキップもしていない、確定済みの時間帯（古い順） */
  pending(now: Date): PendingPeriod[] {
    const done = this.readPeriods().done;
    const currentStart = floorToHour(now).getTime();
    // サーバは48時間より古い期間を受け付けないので、少し余裕を持たせる
    const oldest = now.getTime() - MAX_POST_AGE_MS + 10 * 60_000;
    const byPeriod = new Map<number, Note[]>();
    for (const n of this.all()) {
      const start = floorToHour(new Date(n.ts)).getTime();
      if (start >= currentStart || start < oldest) continue;
      const key = new Date(start).toISOString();
      if (done[key]) continue;
      byPeriod.set(start, [...(byPeriod.get(start) ?? []), n]);
    }
    return [...byPeriod.entries()]
      .sort(([a], [b]) => a - b)
      .map(([start, notes]) => ({
        periodStart: new Date(start).toISOString(),
        periodEnd: new Date(start + HOUR_MS).toISOString(),
        notes,
      }));
  }

  mark(periodStart: string, state: "published" | "skipped"): void {
    withLock(this.lockPath, () => {
      const p = this.readPeriods();
      p.done[new Date(periodStart).toISOString()] = state;
      writeSecretJson(this.periodsPath, p);
    });
  }

  /** 48時間より古いメモと記録を消す */
  prune(now: Date): void {
    const cutoff = now.getTime() - MAX_POST_AGE_MS - HOUR_MS;
    withLock(this.lockPath, () => {
      // 読んでから書き換えるまでの間に追記されたメモを落とさないよう、ロックの中で読む
      if (existsSync(this.notesPath)) {
        const keep = this.all().filter((n) => Date.parse(n.ts) >= cutoff);
        writeFileAtomic(this.notesPath, keep.map((n) => `${JSON.stringify(n)}\n`).join(""));
      }
      const p = this.readPeriods();
      for (const k of Object.keys(p.done)) if (Date.parse(k) < cutoff) delete p.done[k];
      if (existsSync(this.periodsPath)) writeSecretJson(this.periodsPath, p);
    });
  }

  private readPeriods(): PeriodsFile {
    return readStateJson<PeriodsFile>(this.periodsPath) ?? { done: {} };
  }
}
