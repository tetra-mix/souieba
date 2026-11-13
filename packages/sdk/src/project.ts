/**
 * 作業しているディレクトリから、プロジェクトを決める（docs/v2-projects.md §3）。
 * - ディレクトリは realpath にしてから比べる（シンボリックリンクで別の名前になっても同じに扱う）
 * - git の worktree は、元のリポジトリの場所に置き換えて比べる（`git rev-parse --git-common-dir` の親）。
 *   別の場所に作った worktree（../repo-feature など）でも、元のリポジトリと同じプロジェクトになる
 * - 結び付けたディレクトリのうち、最も長く一致するものを持つプロジェクトを選ぶ。なければ default
 * - 環境変数 SOUIEBA_PROJECT で明示的に選べる
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readStateJson, writeSecretJson } from "./config.ts";
import type { NoteVia } from "./notes.ts";
import { withFileLock } from "./notes.ts";
import { DEFAULT_PROJECT, type RelayState, RelayStateError, findProject } from "./relay-state.ts";

/** git に聞く。git がない・リポジトリでないときは null */
function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * ディレクトリを、比べるときの形にする。realpath にし、git の worktree の中なら、元のリポジトリの中の同じ場所にする。
 * ディレクトリがなければ例外
 */
export function canonicalDir(dir: string): string {
  const real = realpathSync(resolve(dir));
  const top = git(real, ["rev-parse", "--show-toplevel"]);
  const common = git(real, ["rev-parse", "--git-common-dir"]);
  if (!top || !common) return real;
  const commonAbs = realpathSync(isAbsolute(common) ? common : join(real, common));
  // 元のリポジトリの .git でなければ（bare リポジトリなど）、置き換えない
  if (!commonAbs.endsWith(`${sep}.git`)) return real;
  const mainRoot = dirname(commonAbs);
  const topReal = realpathSync(top);
  if (topReal === mainRoot) return real;
  const rel = relative(topReal, real);
  return rel ? join(mainRoot, rel) : mainRoot;
}

/** canonical（canonicalDir の結果）が、結び付けたディレクトリ d の中か */
function within(canonical: string, d: string): boolean {
  if (canonical === d) return true;
  return canonical.startsWith(d.endsWith(sep) ? d : `${d}${sep}`);
}

/** canonical に最も長く一致するディレクトリを持つプロジェクト（なければ default） */
export function matchProject(state: RelayState, canonical: string): { project: string; dir: string | null } {
  let best: { project: string; dir: string | null } = { project: DEFAULT_PROJECT, dir: null };
  for (const p of Object.values(state.projects)) {
    if (p.name === DEFAULT_PROJECT) continue;
    for (const d of p.dirs) {
      if (within(canonical, d) && (best.dir === null || d.length > best.dir.length)) best = { project: p.name, dir: d };
    }
  }
  return best;
}

export type ProjectChoice = { project: string; via: "env" | "dir" | "default"; dir: string | null };

/**
 * メモを書くときのプロジェクトを決める。SOUIEBA_PROJECT があればそれ（ないプロジェクトなら例外。
 * 打ち間違いで、より広い default に入らないように）。なければ作業ディレクトリ（cwd）から
 */
export function resolveProject(state: RelayState, opts: { cwd?: string | null; env?: NodeJS.ProcessEnv } = {}): ProjectChoice {
  const forced = (opts.env ?? process.env).SOUIEBA_PROJECT?.trim();
  if (forced) {
    const p = findProject(state, forced);
    if (!p) throw new RelayStateError(`SOUIEBA_PROJECT のプロジェクト「${forced}」はありません（souieba relay project list で確かめられます）`);
    return { project: p.name, via: "env", dir: null };
  }
  if (!opts.cwd) return { project: DEFAULT_PROJECT, via: "default", dir: null };
  let canonical: string;
  try {
    canonical = canonicalDir(opts.cwd);
  } catch {
    return { project: DEFAULT_PROJECT, via: "default", dir: null };
  }
  const m = matchProject(state, canonical);
  return m.dir ? { project: m.project, via: "dir", dir: m.dir } : { project: DEFAULT_PROJECT, via: "default", dir: null };
}

// ---- メモのプロジェクトの決め方（2.1.0。docs/v2-projects.md §3） ----

/** メモを書くときに分かっていること。どれも、なければ省く */
export type NoteContext = {
  /** souieba note を実行したディレクトリ（CLI。エージェントのシェルが実際に動いている場所） */
  cwd?: string | null;
  /** MCP の initialize で分かったクライアントの名前（clientInfo.name） */
  client?: string | null;
  /** この会話に主人が指定したプロジェクト（会話ごとの指定。主人の言葉があったときだけ） */
  pin?: string | null;
  /** フックが知らせた、この会話の作業ディレクトリ（Claude Code などのフックの cwd） */
  sessionCwd?: string | null;
  /** MCP クライアントの roots（roots/list。file:// のパス） */
  roots?: string[];
  /** エージェントの推定（note の --project-guess / project） */
  guess?: string | null;
  env?: NodeJS.ProcessEnv;
};

export type NoteProjectChoice = {
  /** hold のときは null（どのプロジェクトにも入れない） */
  project: string | null;
  via: NoteVia;
  dir?: string | null;
  /** 推定を受け付けなかったとき、その理由 */
  rejectedGuess?: { project: string; reason: "unknown" | "not_accepted" };
};

function dirMatch(state: RelayState, dir: string | null | undefined): { project: string; dir: string } | null {
  if (!dir) return null;
  let canonical: string;
  try {
    canonical = canonicalDir(dir);
  } catch {
    return null;
  }
  const m = matchProject(state, canonical);
  return m.dir ? { project: m.project, dir: m.dir } : null;
}

/** 推定を受け付けるプロジェクトか（acceptInference が false なら受け付けない） */
export function acceptsInference(state: RelayState, name: string): boolean {
  const p = findProject(state, name);
  return !!p && p.acceptInference !== false;
}

/**
 * メモのプロジェクトを決める。先に当てはまったものを使う:
 * 1. 主人の規則: SOUIEBA_PROJECT（環境変数）・ディレクトリ（souieba note を実行した場所）・MCP クライアント
 * 2. 会話ごとの指定（pin。主人が「この会話は仕事」と言ったとき）
 * 3. 作業場所: フックが知らせた会話の作業ディレクトリ・MCP の roots（主人が結び付けたディレクトリと照らす）
 * 4. エージェントの推定（そのプロジェクトが acceptInference のときだけ。「推定」の印が付く）
 * 5. どれでもなければ unresolved の設定（default: 既定のプロジェクト / hold: 保留）
 * どの手順で決めたかを via で返す（メモに記録する）
 */
export function resolveNoteProject(state: RelayState, ctx: NoteContext = {}): NoteProjectChoice {
  const forced = (ctx.env ?? process.env).SOUIEBA_PROJECT?.trim();
  if (forced) {
    const p = findProject(state, forced);
    if (!p) throw new RelayStateError(`SOUIEBA_PROJECT のプロジェクト「${forced}」はありません（souieba relay project list で確かめられます）`);
    return { project: p.name, via: "env" };
  }
  const d = dirMatch(state, ctx.cwd);
  if (d) return { project: d.project, via: "rule-dir", dir: d.dir };
  const client = ctx.client?.trim();
  if (client) {
    const pr = state.clients?.[client];
    if (pr && state.projects[pr]) return { project: pr, via: "rule-client" };
  }
  if (ctx.pin) {
    const p = findProject(state, ctx.pin);
    if (p) return { project: p.name, via: "pin" };
  }
  const sc = dirMatch(state, ctx.sessionCwd);
  if (sc) return { project: sc.project, via: "cwd", dir: sc.dir };
  for (const r of ctx.roots ?? []) {
    const m = dirMatch(state, r);
    if (m) return { project: m.project, via: "roots", dir: m.dir };
  }
  let rejectedGuess: NoteProjectChoice["rejectedGuess"];
  const guess = ctx.guess?.trim();
  if (guess) {
    const p = findProject(state, guess);
    if (p && p.acceptInference !== false) return { project: p.name, via: "inferred" };
    rejectedGuess = { project: guess, reason: p ? "not_accepted" : "unknown" };
  }
  return state.unresolved === "hold" ? { project: null, via: "hold", rejectedGuess } : { project: DEFAULT_PROJECT, via: "default", rejectedGuess };
}

// ---- 会話ごとの指定（pin）と、フックが知らせた会話の作業ディレクトリ ----

/** 会話ごとの記録を残す期間。会話が終わっても消す手がかりがないので、期限で消す */
export const SESSION_RECORD_TTL_MS = 24 * 3_600_000;

type SessionFile = { v: 1; sessions: Record<string, { pin?: string; pinnedAt?: string; cwd?: string; seenAt: string }> };

const SESSION_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isSessionKey(k: unknown): k is string {
  return typeof k === "string" && SESSION_KEY_RE.test(k);
}

/**
 * 会話（Claude Code などのフックの session_id）ごとの、主人の指定と作業ディレクトリ。人の状態ディレクトリに置く。
 * MCP は会話ごとに別のプロセスなので、ここは使わずプロセスの中に持つ
 */
export class SessionStore {
  readonly path: string;

  constructor(dir: string) {
    this.path = join(dir, "sessions.json");
  }

  private load(now: Date): SessionFile {
    const f = readStateJson<SessionFile>(this.path);
    const file: SessionFile = f && f.v === 1 && f.sessions ? f : { v: 1, sessions: {} };
    const cutoff = new Date(now.getTime() - SESSION_RECORD_TTL_MS).toISOString();
    for (const [k, v] of Object.entries(file.sessions)) if (!v || v.seenAt < cutoff) delete file.sessions[k];
    return file;
  }

  private update(now: Date, fn: (f: SessionFile) => void): void {
    withFileLock(`${this.path}.lock`, () => {
      const f = this.load(now);
      fn(f);
      writeSecretJson(this.path, f);
    });
  }

  get(key: string, now: Date): { pin?: string; cwd?: string } | null {
    if (!isSessionKey(key)) return null;
    const v = this.load(now).sessions[key];
    return v ? { pin: v.pin, cwd: v.cwd } : null;
  }

  /** フックから: その会話の作業ディレクトリを覚える */
  touch(key: string, cwd: string | null, now: Date): void {
    if (!isSessionKey(key)) return;
    this.update(now, (f) => {
      const cur = f.sessions[key] ?? { seenAt: now.toISOString() };
      f.sessions[key] = { ...cur, ...(cwd ? { cwd } : {}), seenAt: now.toISOString() };
    });
  }

  /** project が null なら指定を外す */
  pin(key: string, project: string | null, now: Date): void {
    if (!isSessionKey(key)) throw new RelayStateError("会話の ID の形式が不正です");
    this.update(now, (f) => {
      const cur = f.sessions[key] ?? { seenAt: now.toISOString() };
      const { pin: _, pinnedAt: __, ...rest } = cur;
      f.sessions[key] = project ? { ...rest, pin: project, pinnedAt: now.toISOString(), seenAt: now.toISOString() } : { ...rest, seenAt: now.toISOString() };
    });
  }
}
