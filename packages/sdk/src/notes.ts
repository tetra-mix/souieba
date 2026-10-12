import { randomUUID } from "node:crypto";
import {
  appendFileSync,
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

/** ロックを待つ間隔と、持ち主が落ちたとみなして奪うまでの時間 */
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 5_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * ロックファイルを作れた1つのプロセスだけが fn を実行する（note と compose が同時に動いても行を失わないように）。
 * 持ち主が落ちて残ったロックは、LOCK_STALE_MS たったら奪う。
 */
function withFileLock<T>(lockPath: string, fn: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
      } catch {
        // 待っている間に消えた。すぐに取り直す
      }
      sleepSync(LOCK_RETRY_MS);
      continue;
    }
    try {
      return fn();
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch {
        // 古いとみなされて奪われていた
      }
    }
  }
}

/** 1件のメモの上限。要約の材料なので短くてよい */
export const MAX_NOTE_LENGTH = 200;

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
    this.periodsPath = join(dir, "periods.json");
    this.lockPath = join(dir, "notes.lock");
  }

  add(text: string, now: Date): Note {
    const clean = sanitizeContent(text).slice(0, MAX_NOTE_LENGTH);
    if (!clean) throw new Error("メモが空です");
    const findings = [...scanSecrets(text), ...scanSecrets(clean)];
    if (findings.length > 0) throw new SecretInNoteError([...new Set(findings.map((f) => f.rule))]);
    const note = { ts: now.toISOString(), text: clean };
    withFileLock(this.lockPath, () => appendFileSync(this.notesPath, `${JSON.stringify(note)}\n`, { mode: 0o600 }));
    return note;
  }

  all(): Note[] {
    return this.lines().flatMap((line) => {
        try {
        return [JSON.parse(line) as Note];
      } catch {
        return [];
      }
    });
  }

  private lines(): string[] {
    if (!existsSync(this.notesPath)) return [];
    return readFileSync(this.notesPath, "utf8").split("\n").filter(Boolean);
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
    withFileLock(this.lockPath, () => {
      const p = this.readPeriods();
      p.done[new Date(periodStart).toISOString()] = state;
      writeSecretJson(this.periodsPath, p);
    });
  }

  /** 48時間より古いメモと記録を消す。消すものがなければ書き直さない */
  prune(now: Date): void {
    const cutoff = now.getTime() - MAX_POST_AGE_MS - HOUR_MS;
    withFileLock(this.lockPath, () => {
      const lines = this.lines();
      const keep = this.all().filter((n) => Date.parse(n.ts) >= cutoff);
      if (keep.length !== lines.length) {
        // 途中で落ちても元のファイルが残るよう、一時ファイルに書いてから置き換える
        const tmp = `${this.notesPath}.${process.pid}.${randomUUID()}.tmp`;
        writeFileSync(tmp, keep.map((n) => `${JSON.stringify(n)}\n`).join(""), { mode: 0o600 });
        renameSync(tmp, this.notesPath);
      }
      const p = this.readPeriods();
      const old = Object.keys(p.done).filter((k) => Date.parse(k) < cutoff);
      for (const k of old) delete p.done[k];
      if (old.length > 0) writeSecretJson(this.periodsPath, p);
    });
  }

  private readPeriods(): PeriodsFile {
    return readStateJson<PeriodsFile>(this.periodsPath) ?? { done: {} };
  }
}
