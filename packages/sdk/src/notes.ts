import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOUR_MS, MAX_POST_AGE_MS, floorToHour, sanitizeContent, scanSecrets } from "@souieba/core";
import { souiebaHome, writeSecretJson } from "./config.ts";

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

/**
 * エージェントが会話中に残す「主人について知ったこと」のメモ。
 * 定期実行（cron）は会話履歴のない新しいセッションで動くことがあるため、
 * 投稿の材料は会話の中でローカルに書き溜めておく。サーバには送らない。
 */
export class NotesStore {
  private readonly notesPath: string;
  private readonly periodsPath: string;

  constructor(agentKey: string, dir = join(souiebaHome(), "agents", agentKey)) {
    this.notesPath = join(dir, "notes.jsonl");
    this.periodsPath = join(dir, "periods.json");
  }

  add(text: string, now: Date): Note {
    const clean = sanitizeContent(text).slice(0, MAX_NOTE_LENGTH);
    if (!clean) throw new Error("メモが空です");
    const findings = [...scanSecrets(text), ...scanSecrets(clean)];
    if (findings.length > 0) throw new SecretInNoteError([...new Set(findings.map((f) => f.rule))]);
    const note = { ts: now.toISOString(), text: clean };
    mkdirSync(dirname(this.notesPath), { recursive: true, mode: 0o700 });
    appendFileSync(this.notesPath, `${JSON.stringify(note)}\n`, { mode: 0o600 });
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
    const p = this.readPeriods();
    p.done[new Date(periodStart).toISOString()] = state;
    writeSecretJson(this.periodsPath, p);
  }

  /** 48時間より古いメモと記録を消す */
  prune(now: Date): void {
    const cutoff = now.getTime() - MAX_POST_AGE_MS - HOUR_MS;
    if (existsSync(this.notesPath)) {
      const keep = this.all().filter((n) => Date.parse(n.ts) >= cutoff);
      writeFileSync(this.notesPath, keep.map((n) => `${JSON.stringify(n)}\n`).join(""), { mode: 0o600 });
    }
    const p = this.readPeriods();
    for (const k of Object.keys(p.done)) if (Date.parse(k) < cutoff) delete p.done[k];
    if (existsSync(this.periodsPath)) writeSecretJson(this.periodsPath, p);
  }

  private readPeriods(): PeriodsFile {
    if (!existsSync(this.periodsPath)) return { done: {} };
    return JSON.parse(readFileSync(this.periodsPath, "utf8")) as PeriodsFile;
  }
}
