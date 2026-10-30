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
