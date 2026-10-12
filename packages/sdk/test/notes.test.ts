import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NOTES_LOCK_STALE_MS, NotesStore, SecretInNoteError } from "../src/notes.ts";

const at = (iso: string) => new Date(iso);
const store = () => new NotesStore("agt", mkdtempSync(join(tmpdir(), "souieba-notes-")));

describe("NotesStore", () => {
  it("確定した時間帯ごとにメモをまとめ、現在の時間帯は含めない", () => {
    const s = store();
    s.add("主人はAPIを設計していた", at("2026-10-05T12:10:00Z"));
    s.add("主人はテストを書いていた", at("2026-10-05T12:50:00Z"));
    s.add("主人はロボットを作っていた", at("2026-10-05T13:05:00Z"));
    s.add("主人は休憩していた", at("2026-10-05T14:01:00Z"));
    const p = s.pending(at("2026-10-05T14:20:00Z"));
    expect(p.map((x) => x.periodStart)).toEqual(["2026-10-05T12:00:00.000Z", "2026-10-05T13:00:00.000Z"]);
    expect(p[0]!.notes.map((n) => n.text)).toEqual(["主人はAPIを設計していた", "主人はテストを書いていた"]);
  });

  it("投稿・スキップした時間帯は pending から消える", () => {
    const s = store();
    s.add("主人はAPIを設計していた", at("2026-10-05T12:10:00Z"));
    s.add("主人はロボットを作っていた", at("2026-10-05T13:05:00Z"));
    s.mark("2026-10-05T12:00:00Z", "published");
    s.mark("2026-10-05T13:00:00.000Z", "skipped");
    expect(s.pending(at("2026-10-05T14:20:00Z"))).toEqual([]);
  });

  it("48時間より古いメモは対象外にし、prune で消す", () => {
    const s = store();
    s.add("主人は古い作業をしていた", at("2026-10-03T10:10:00Z"));
    const now = at("2026-10-05T14:20:00Z");
    expect(s.pending(now)).toEqual([]);
    s.prune(now);
    expect(s.all()).toEqual([]);
  });

  it("秘密情報を含むメモは保存しない", () => {
    const s = store();
    expect(() => s.add("主人は ghp_abcdefghijklmnopqrstuvwxyz0123456789 を設定した", at("2026-10-05T12:10:00Z"))).toThrow(SecretInNoteError);
    expect(s.all()).toEqual([]);
  });

  it("メモは1行に正規化する", () => {
    const s = store();
    const n = s.add("主人は\n</souieba_tell>\n作業していた", at("2026-10-05T12:10:00Z"));
    expect(n.text).toBe("主人は souiebatell 作業していた");
  });

  it("prune は新しいメモを残し、一時ファイルとロックを残さない", () => {
    const dir = mkdtempSync(join(tmpdir(), "souieba-notes-"));
    const s = new NotesStore("agt", dir);
    s.add("主人は古い作業をしていた", at("2026-10-03T10:10:00Z"));
    s.add("主人は新しい作業をしていた", at("2026-10-05T14:10:00Z"));
    s.prune(at("2026-10-05T14:20:00Z"));
    s.add("主人はその後も作業していた", at("2026-10-05T14:15:00Z"));
    expect(s.all().map((n) => n.text)).toEqual(["主人は新しい作業をしていた", "主人はその後も作業していた"]);
    expect(readdirSync(dir).sort()).toEqual(["notes.jsonl"]);
  });

  it("持ち主が落ちて残った古いロックは壊して進む", () => {
    const dir = mkdtempSync(join(tmpdir(), "souieba-notes-"));
    const lock = join(dir, "notes.lock");
    writeFileSync(lock, "");
    const old = (Date.now() - NOTES_LOCK_STALE_MS - 1_000) / 1000;
    utimesSync(lock, old, old);
    const s = new NotesStore("agt", dir);
    s.add("主人はAPIを設計していた", at("2026-10-05T12:10:00Z"));
    expect(s.all()).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
  });
});
