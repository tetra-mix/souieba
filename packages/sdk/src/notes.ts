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

/** project がないメモ（v1 の Agent・プロジェクトを入れる前のメモ）は既定のプロジェクト */
export type Note = { ts: string; text: string; project?: string };

/** プロジェクトの既定の名前（relay-state の DEFAULT_PROJECT と同じ） */
const DEFAULT = "default";

export const noteProject = (n: Note): string => n.project ?? DEFAULT;

/** 投稿待ちの（時間帯, プロジェクト）。v1 の Agent では project はいつも default */
export type PendingPeriod = {
  periodStart: string;
  periodEnd: string;
  project: string;
  notes: Note[];
};

/** 投稿済み・スキップの記録のキー。default はプロジェクトを入れる前と同じ（時間帯の開始時刻だけ） */
function periodKey(periodStart: string | number, project: string): string {
  const iso = new Date(periodStart).toISOString();
  return project === DEFAULT ? iso : `${iso}#${project}`;
}

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
export function withFileLock<T>(lockPath: string, fn: () => T): T {
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

  /** project を渡したとき（v2 の Agent）は、メモに記録する */
  add(text: string, now: Date, project?: string): Note {
    const clean = sanitizeContent(text).slice(0, MAX_NOTE_LENGTH);
    if (!clean) throw new Error("メモが空です");
    const findings = [...scanSecrets(text), ...scanSecrets(clean)];
    if (findings.length > 0) throw new SecretInNoteError([...new Set(findings.map((f) => f.rule))]);
    const note: Note = { ts: now.toISOString(), text: clean, ...(project ? { project } : {}) };
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

  /**
   * メモがあり、まだ投稿もスキップもしていない、確定済みの（時間帯, プロジェクト）。古い時間帯から、同じ時間帯では default を先に
   */
  pending(now: Date): PendingPeriod[] {
    const done = this.readPeriods().done;
    const byKey = new Map<string, { start: number; project: string; notes: Note[] }>();
    for (const n of this.all()) {
      const start = this.openPeriod(n, now);
      if (start === null) continue;
      const project = noteProject(n);
      const key = periodKey(start, project);
      if (done[key]) continue;
      const e = byKey.get(key) ?? { start, project, notes: [] };
      e.notes.push(n);
      byKey.set(key, e);
    }
    return [...byKey.values()]
      .sort((a, b) => a.start - b.start || Number(b.project === DEFAULT) - Number(a.project === DEFAULT) || a.project.localeCompare(b.project))
      .map(({ start, project, notes }) => ({
        periodStart: new Date(start).toISOString(),
        periodEnd: new Date(start + HOUR_MS).toISOString(),
        project,
        notes,
      }));
  }

  /** メモの時間帯が、確定済みで投稿できる古さなら、その開始時刻 */
  private openPeriod(n: Note, now: Date): number | null {
    const start = floorToHour(new Date(n.ts)).getTime();
    // サーバは48時間より古い期間を受け付けないので、少し余裕を持たせる
    const oldest = now.getTime() - MAX_POST_AGE_MS + 10 * 60_000;
    return start >= floorToHour(now).getTime() || start < oldest ? null : start;
  }

  mark(periodStart: string, state: "published" | "skipped", project: string = DEFAULT): void {
    withFileLock(this.lockPath, () => {
      const p = this.readPeriods();
      p.done[periodKey(periodStart, project)] = state;
      writeSecretJson(this.periodsPath, p);
    });
  }

  /** その（時間帯, プロジェクト）をもう投稿・スキップしたか */
  isDone(periodStart: string, project: string = DEFAULT): boolean {
    return !!this.readPeriods().done[periodKey(periodStart, project)];
  }

  /**
   * まだ投稿もスキップもしていないメモを、別のプロジェクトに付け替える（souieba note move）。
   * from・periodStart で絞れる（どちらもなければ、まだ送っていないメモ全部）。現在の時間帯のメモも対象。付け替えた件数を返す
   */
  move(to: string, opts: { from?: string; periodStart?: string }, now: Date): number {
    const want = opts.periodStart ? floorToHour(new Date(opts.periodStart)).getTime() : null;
    return withFileLock(this.lockPath, () => {
      const done = this.readPeriods().done;
      const notes = this.all();
      let moved = 0;
      for (const n of notes) {
        const start = floorToHour(new Date(n.ts)).getTime();
        if (start < now.getTime() - MAX_POST_AGE_MS) continue;
        if (want !== null && start !== want) continue;
        if (opts.from !== undefined && noteProject(n) !== opts.from) continue;
        if (noteProject(n) === to || done[periodKey(start, noteProject(n))]) continue;
        n.project = to;
        moved++;
      }
      if (moved > 0) this.rewrite(notes);
      return moved;
    });
  }

  /** プロジェクトの名前を変えたときに、メモと（時間帯, プロジェクト）の記録を付け替える */
  renameProject(from: string, to: string): void {
    withFileLock(this.lockPath, () => {
      const notes = this.all();
      let changed = false;
      for (const n of notes) {
        if (noteProject(n) === from) {
          n.project = to;
          changed = true;
        }
      }
      if (changed) this.rewrite(notes);
      const p = this.readPeriods();
      const suffix = `#${from}`;
      const keys = Object.keys(p.done).filter((k) => k.endsWith(suffix));
      for (const k of keys) {
        p.done[periodKey(k.slice(0, -suffix.length), to)] = p.done[k]!;
        delete p.done[k];
      }
      if (keys.length > 0) writeSecretJson(this.periodsPath, p);
    });
  }

  /** 途中で落ちても元のファイルが残るよう、一時ファイルに書いてから置き換える */
  private rewrite(notes: Note[]): void {
    const tmp = `${this.notesPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, notes.map((n) => `${JSON.stringify(n)}\n`).join(""), { mode: 0o600 });
    renameSync(tmp, this.notesPath);
  }

  /** 48時間より古いメモと記録を消す。消すものがなければ書き直さない */
  prune(now: Date): void {
    const cutoff = now.getTime() - MAX_POST_AGE_MS - HOUR_MS;
    withFileLock(this.lockPath, () => {
      const lines = this.lines();
      const keep = this.all().filter((n) => Date.parse(n.ts) >= cutoff);
      if (keep.length !== lines.length) this.rewrite(keep);
      const p = this.readPeriods();
      const old = Object.keys(p.done).filter((k) => Date.parse(k.split("#")[0]!) < cutoff);
      for (const k of old) delete p.done[k];
      if (old.length > 0) writeSecretJson(this.periodsPath, p);
    });
  }

  private readPeriods(): PeriodsFile {
    return readStateJson<PeriodsFile>(this.periodsPath) ?? { done: {} };
  }
}
