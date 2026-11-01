import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePerson } from "@souieba/core";
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
  SessionStore,
  migrateAgentState,
  migrateRelayState,
  resolveNoteProject,
  resolveProject,
  resolveTargets,
} from "../src/index.ts";

import { AGENT_STATE_200 } from "./fixtures/agent-state-2.0.0.ts";

const at = (iso: string) => new Date(iso);

describe("v2 のプロジェクト: 2.0.0 の Agent ごとの状態から、人ごとの状態へ移す", () => {
  it("仕事のプロジェクト（ディレクトリ・空の共有先）・グループ・方針・任せた範囲を移し、連絡先は一覧にする", () => {
    const m = migrateAgentState(AGENT_STATE_200, at("2026-11-01T00:00:00Z"))!;
    expect(m.state.v).toBe(3);
    expect(m.state.projects.仕事).toMatchObject({
      name: "仕事",
      dirs: ["/Users/ryouma/Documents/vivixy/jme", "/Users/ryouma/Documents/spajam/spajam"],
      access: { people: {}, groups: {} },
      policy: null,
    });
    expect(m.state.projects[DEFAULT_PROJECT]!.access).toEqual({ people: {}, groups: { friends: "allow" } });
    expect(m.state.projects[DEFAULT_PROJECT]!.policy?.text).toBe("趣味の話はよい");
    expect(m.state.groups.friends).toMatchObject({ name: "友達", members: [] });
    expect(m.state.contacts).toEqual({});
    expect(m.state.delegations).toEqual([AGENT_STATE_200.delegations[0]]);
    expect(m.oldContacts.map((c) => c.name)).toEqual(["ボブ", "キャロル"]);
    expect(m.dropped.join("\n")).toContain("友達");
    expect(m.state.unresolved).toBe("default");
    // 移したあとは、人ごとの状態として読める
    const dir = mkdtempSync(join(tmpdir(), "souieba-migrate-"));
    new RelayStateStore(dir).save(m.state);
    expect(new RelayStateStore(dir).load().projects.仕事!.dirs).toHaveLength(2);
  });

  it("v1（プロジェクトがなかったころ）の状態も移せる。知らない版は読まない", () => {
    const m = migrateAgentState({ v: 1, access: { agents: { sb_x: "allow" }, groups: {} }, policy: { text: "趣味", updatedAt: "2026-10-01T00:00:00.000Z" } }, at("2026-11-01T00:00:00Z"))!;
    expect(m.state.projects[DEFAULT_PROJECT]!.policy?.text).toBe("趣味");
    expect(m.state.projects[DEFAULT_PROJECT]!.access.people).toEqual({});
    expect(migrateAgentState({ v: 9 }, new Date())).toBeNull();
    // 人ごとの状態は v3 だけを読む（2.0.0 の Agent の状態を、そのまま人の状態として読まない）
    expect(migrateRelayState({ v: 2, projects: {} })).toBeNull();
    expect(migrateRelayState({ v: 3, projects: {} })!.projects[DEFAULT_PROJECT]).toBeTruthy();
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
    const id = generatePerson();
    s.contacts[id.personId] = contactFrom(id.personId, id.person.pub, [], [], "ボブ", at("2026-10-30T00:00:00Z"));
    s.projects[DEFAULT_PROJECT]!.access.people[id.personId] = "allow";
    expect(accessFor(s, id.personId).allowed).toBe(true);
    expect(accessFor(s, id.personId, "研究").allowed).toBe(false);
    expect(resolveTargets(s, [], new Set([id.personId]), "研究").denied).toEqual([id.personId]);
    expect(() => resolveTargets(s, [], new Set(), "ない")).toThrow();
  });
});

describe("v2 のプロジェクト: メモのプロジェクトの決め方（2.1.0）", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "souieba-prec-")));
  const work = join(root, "work");
  const hobby = join(root, "hobby");
  const other = join(root, "other");
  for (const d of [work, hobby, other]) mkdirSync(d, { recursive: true });
  const base = () => {
    const s = emptyState();
    s.projects.仕事 = { ...emptyProject("仕事", "2026-10-30T00:00:00.000Z", [work]), acceptInference: false, description: "会社の開発" };
    s.projects.趣味 = { ...emptyProject("趣味", "2026-10-30T00:00:00.000Z", [hobby]), description: "趣味の工作" };
    s.projects.読書 = emptyProject("読書", "2026-10-30T00:00:00.000Z");
    s.clients = { "claude-ai": "読書" };
    return s;
  };
  const env = {};

  it("ディレクトリの規則 > クライアントの規則 > 会話の指定 > 作業場所 > 推定 > 既定", () => {
    const s = base();
    const all = { cwd: work, client: "claude-ai", pin: "趣味", sessionCwd: hobby, roots: [hobby], guess: "趣味", env };
    expect(resolveNoteProject(s, all)).toMatchObject({ project: "仕事", via: "rule-dir" });
    expect(resolveNoteProject(s, { ...all, cwd: other })).toMatchObject({ project: "読書", via: "rule-client" });
    expect(resolveNoteProject(s, { ...all, cwd: other, client: "cursor" })).toMatchObject({ project: "趣味", via: "pin" });
    expect(resolveNoteProject(s, { ...all, cwd: other, client: null, pin: null, sessionCwd: work })).toMatchObject({ project: "仕事", via: "cwd" });
    expect(resolveNoteProject(s, { ...all, cwd: null, client: null, pin: null, sessionCwd: null, roots: [other, work] })).toMatchObject({ project: "仕事", via: "roots" });
    expect(resolveNoteProject(s, { guess: "趣味", env })).toMatchObject({ project: "趣味", via: "inferred" });
    expect(resolveNoteProject(s, { env })).toMatchObject({ project: DEFAULT_PROJECT, via: "default" });
  });

  it("推定は acceptInference が false のプロジェクトには入れない。ないプロジェクトも断る", () => {
    const s = base();
    expect(resolveNoteProject(s, { guess: "仕事", env })).toMatchObject({ project: DEFAULT_PROJECT, via: "default", rejectedGuess: { project: "仕事", reason: "not_accepted" } });
    expect(resolveNoteProject(s, { guess: "ない", env })).toMatchObject({ via: "default", rejectedGuess: { reason: "unknown" } });
    // 会話の指定なら、推定を断るプロジェクトにも入る（主人の言葉なので）
    expect(resolveNoteProject(s, { pin: "仕事", env })).toMatchObject({ project: "仕事", via: "pin" });
  });

  it("unresolved が hold なら、決まらないメモは保留にする", () => {
    const s = { ...base(), unresolved: "hold" as const };
    expect(resolveNoteProject(s, { env })).toEqual({ project: null, via: "hold", rejectedGuess: undefined });
    expect(resolveNoteProject(s, { guess: "仕事", env })).toMatchObject({ project: null, via: "hold" });
  });

  it("会話の指定と作業ディレクトリは、会話の ID ごとに覚え、期限で消える", () => {
    const store = new SessionStore(mkdtempSync(join(tmpdir(), "souieba-sess-")));
    store.touch("sess-1", work, at("2026-11-01T00:00:00Z"));
    store.pin("sess-1", "趣味", at("2026-11-01T00:01:00Z"));
    expect(store.get("sess-1", at("2026-11-01T01:00:00Z"))).toEqual({ pin: "趣味", cwd: work });
    expect(store.get("sess-2", at("2026-11-01T01:00:00Z"))).toBeNull();
    store.pin("sess-1", null, at("2026-11-01T01:00:00Z"));
    expect(store.get("sess-1", at("2026-11-01T01:00:00Z"))).toEqual({ pin: undefined, cwd: work });
    expect(store.get("sess-1", at("2026-11-03T00:00:00Z"))).toBeNull();
    expect(() => store.pin("bad key!", "趣味", new Date())).toThrow();
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

  it("保留のメモは投稿の材料にせず、主人が振り分けると via: owner になる。推定のメモも確かめられる", () => {
    const s = store();
    s.add("主人は何かを調べていた", at("2026-10-05T12:10:00Z"), undefined, "hold");
    s.add("主人は工作をしていた", at("2026-10-05T12:20:00Z"), "趣味", "inferred");
    expect(s.pending(at("2026-10-05T13:20:00Z")).map((x) => x.project)).toEqual(["趣味"]);
    expect(s.review(at("2026-10-05T13:20:00Z")).map((n) => n.via)).toEqual(["hold", "inferred"]);
    // 保留のメモは held を付けたときだけ動かす
    expect(s.move(DEFAULT_PROJECT, {}, at("2026-10-05T13:20:00Z"))).toBe(1);
    expect(s.move("仕事", { held: true }, at("2026-10-05T13:20:00Z"))).toBe(1);
    expect(s.all().map((n) => [n.project, n.via])).toEqual([
      ["仕事", "owner"],
      [DEFAULT_PROJECT, "owner"],
    ]);
    expect(s.review(at("2026-10-05T13:20:00Z"))).toEqual([]);
  });

  it("推定で入れたメモを同じプロジェクトに移すと、主人が確かめたことになる", () => {
    const s = store();
    s.add("主人は工作をしていた", at("2026-10-05T12:20:00Z"), "趣味", "inferred");
    expect(s.move("趣味", { ts: "2026-10-05T12:20:00.000Z" }, at("2026-10-05T13:20:00Z"))).toBe(1);
    expect(s.all()[0]).toMatchObject({ project: "趣味", via: "owner" });
  });
});
