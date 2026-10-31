import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryEntry, generateRelayIdentity } from "@souieba/core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT,
  NotesStore,
  RelayStateStore,
  accessFor,
  canonicalDir,
  contactFrom,
  emptyProject,
  emptyState,
  migrateRelayState,
  resolveProject,
  resolveTargets,
} from "../src/index.ts";

const at = (iso: string) => new Date(iso);

describe("v2 のプロジェクト: 状態の移行", () => {
  it("v1 の access・policy は既定のプロジェクトになる", () => {
    const dir = mkdtempSync(join(tmpdir(), "souieba-migrate-"));
    writeFileSync(
      join(dir, "relay-state.json"),
      JSON.stringify({
        v: 1,
        contacts: {},
        pendingNames: {},
        groups: {},
        access: { agents: { sb_x: "allow" }, groups: { g1: "deny" } },
        policy: { text: "趣味の話はよい", updatedAt: "2026-10-01T00:00:00.000Z" },
        notifiedRequests: [],
        lastToldSender: null,
      }),
    );
    const s = new RelayStateStore(dir).load();
    expect(s.v).toBe(2);
    expect(s.projects[DEFAULT_PROJECT]!.access).toEqual({ agents: { sb_x: "allow" }, groups: { g1: "deny" } });
    expect(s.projects[DEFAULT_PROJECT]!.policy?.text).toBe("趣味の話はよい");
    expect("access" in s).toBe(false);
    expect("policy" in s).toBe(false);
  });

  it("既定のプロジェクトがなければ足す。知らない版は読まない", () => {
    expect(migrateRelayState({ v: 2, projects: {} })!.projects[DEFAULT_PROJECT]).toBeTruthy();
    expect(migrateRelayState({ v: 9 })).toBeNull();
  });
});

describe("v2 のプロジェクト: ディレクトリから決める", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "souieba-proj-")));
  const repo = join(root, "repo");
  const wt = join(root, "repo-wt");
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  writeFileSync(join(repo, "f"), "x");
  const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, stdio: "ignore" });
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  git(repo, "worktree", "add", "-q", wt);
  mkdirSync(join(wt, "src", "deep"), { recursive: true });
  symlinkSync(repo, join(root, "link"));

  const state = emptyState();
  state.projects.研究 = emptyProject("研究", "2026-10-30T00:00:00.000Z", [repo]);
  state.projects.深い = emptyProject("深い", "2026-10-30T00:00:00.000Z", [join(repo, "src", "deep")]);

  it("worktree は元のリポジトリの中の同じ場所になる", () => {
    expect(canonicalDir(wt)).toBe(repo);
    expect(canonicalDir(join(wt, "src"))).toBe(join(repo, "src"));
    expect(canonicalDir(join(root, "link"))).toBe(repo);
  });

  it("最も長く一致するディレクトリのプロジェクト。なければ既定", () => {
    expect(resolveProject(state, { cwd: join(repo, "src"), env: {} }).project).toBe("研究");
    expect(resolveProject(state, { cwd: join(wt, "src", "deep"), env: {} }).project).toBe("深い");
    expect(resolveProject(state, { cwd: join(root, "link", "src"), env: {} }).project).toBe("研究");
    expect(resolveProject(state, { cwd: root, env: {} }).project).toBe(DEFAULT_PROJECT);
    // 名前の前方一致（repo と repo-wt）は同じディレクトリとみなさない
    expect(resolveProject({ ...state, projects: { ...state.projects, x: emptyProject("x", "", [join(root, "rep")]) } }, { cwd: repo, env: {} }).project).toBe("研究");
    // ディレクトリのない会話
    expect(resolveProject(state, { cwd: null, env: {} }).project).toBe(DEFAULT_PROJECT);
  });

  it("SOUIEBA_PROJECT で上書きできる。ないプロジェクトなら断る（打ち間違いで既定に入らないように）", () => {
    expect(resolveProject(state, { cwd: root, env: { SOUIEBA_PROJECT: "研究" } })).toMatchObject({ project: "研究", via: "env" });
    expect(() => resolveProject(state, { cwd: root, env: { SOUIEBA_PROJECT: "けんきゅう" } })).toThrow("ありません");
  });

  it("共有先はプロジェクトの設定だけで決まる（既定を引き継がない）", () => {
    const s = structuredClone(state);
    const id = generateRelayIdentity();
    s.contacts[id.agentId] = contactFrom(directoryEntry(id), "ボブ", at("2026-10-30T00:00:00Z"));
    s.projects[DEFAULT_PROJECT]!.access.agents[id.agentId] = "allow";
    expect(accessFor(s, id.agentId).allowed).toBe(true);
    expect(accessFor(s, id.agentId, "研究").allowed).toBe(false);
    expect(resolveTargets(s, [], new Set([id.agentId]), "研究").denied).toEqual([id.agentId]);
    expect(() => resolveTargets(s, [], new Set(), "ない")).toThrow();
  });
});

describe("v2 のプロジェクト: メモ", () => {
  const store = () => new NotesStore("agt", mkdtempSync(join(tmpdir(), "souieba-pnotes-")));

  it("（時間帯, プロジェクト）ごとに分け、投稿済み・スキップもそれぞれに持つ", () => {
    const s = store();
    s.add("主人はAPIを設計していた", at("2026-10-05T12:10:00Z"));
    s.add("主人はパーサを書いていた", at("2026-10-05T12:20:00Z"), "研究");
    s.add("主人は昼食をとった", at("2026-10-05T12:30:00Z"), DEFAULT_PROJECT);
    const p = s.pending(at("2026-10-05T13:20:00Z"));
    expect(p.map((x) => [x.project, x.notes.length])).toEqual([
      [DEFAULT_PROJECT, 2],
      ["研究", 1],
    ]);
    s.mark("2026-10-05T12:00:00Z", "published", "研究");
    expect(s.pending(at("2026-10-05T13:20:00Z")).map((x) => x.project)).toEqual([DEFAULT_PROJECT]);
    // project のない記録（入れる前のもの）は既定
    s.mark("2026-10-05T12:00:00Z", "skipped");
    expect(s.pending(at("2026-10-05T13:20:00Z"))).toEqual([]);
  });

  it("まだ送っていないメモだけを付け替える", () => {
    const s = store();
    s.add("主人はパーサを書いていた", at("2026-10-05T12:20:00Z"), "研究");
    s.add("主人は評価を回していた", at("2026-10-05T13:20:00Z"), "研究");
    s.mark("2026-10-05T12:00:00Z", "published", "研究");
    expect(s.move(DEFAULT_PROJECT, { from: "研究" }, at("2026-10-05T14:00:00Z"))).toBe(1);
    expect(s.all().map((n) => n.project)).toEqual(["研究", DEFAULT_PROJECT]);
  });
});
