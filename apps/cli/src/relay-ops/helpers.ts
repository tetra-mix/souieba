import { DAY_MS, HOUR_MS } from "@souieba/core";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { type Contact, DEFAULT_PROJECT, type DelegationScope, type LocalGroup, type Project, type RelayState, allowedSet, canonicalDir, findContact, findGroup, findProject } from "@souieba/sdk";

export type Change = {
  /** 主人に見せる、変更の内容 */
  summary: string;
  /** 共有の範囲を広げるか（広げるなら主人の承認が要る） */
  widens: boolean;
  /** 実行して、結果の文を返す */
  apply: () => Promise<string>;
  /** 広げる操作のとき、主人がこのすべてをエージェントに任せていれば、確認なしで実行してよい（ないなら任せられない） */
  scopes?: DelegationScope[];
  /** 主人が直接（TUI か、端末での y/N）しか実行できない操作。--yes・MCP の confirm・任せた範囲では実行しない */
  ownerOnly?: boolean;
};

/** 任せる期限の選び方（TUI・CLI 共通） */
export const DELEGATION_TERMS = { "24h": 24 * HOUR_MS, "7d": 7 * DAY_MS, forever: null } as const;
export type DelegationTerm = keyof typeof DELEGATION_TERMS;

export function parseTerm(v: string | undefined): DelegationTerm {
  const t = (v ?? "24h").trim();
  if (t === "無期限" || t === "none") return "forever";
  if (t in DELEGATION_TERMS) return t as DelegationTerm;
  throw new OpError("期限は 24h・7d・forever のどれかにしてください");
}

export const termLabel = (t: DelegationTerm) => (t === "24h" ? "24時間" : t === "7d" ? "7日間" : "期限なし（取り消すまで）");

export class OpError extends Error {}

export const short = (id: string) => `${id.slice(0, 10)}…`;

export function who(state: RelayState, id: string): string {
  const c = state.contacts[id];
  return c ? `${c.name}（${short(id)}）` : id;
}

export function requireContact(state: RelayState, ref: string | undefined): Contact {
  if (!ref) throw new OpError("相手（呼び名か ID）を指定してください");
  const c = findContact(state, ref);
  if (!c) throw new OpError(`連絡先に「${ref}」がありません（souieba relay contacts で確認できます）`);
  return c;
}

export function requireProject(state: RelayState, ref: string | undefined): Project {
  const p = findProject(state, ref ?? DEFAULT_PROJECT);
  if (!p) throw new OpError(`プロジェクト「${ref}」はありません（souieba relay project list で確かめられます）`);
  return p;
}

/** 任せる範囲の説明（主人に見せる） */
export function describeScope(state: RelayState, sc: DelegationScope): string {
  switch (sc.kind) {
    case "audience":
      return `プロジェクト「${projectLabel(sc.project)}」の共有先（連絡先やグループの許可 / 禁止 / 設定なし）を変えること`;
    case "policy":
      return `プロジェクト「${projectLabel(sc.project)}」の共有方針を書き換えること`;
    case "dirs":
      return `プロジェクト「${projectLabel(sc.project)}」のディレクトリを付け外しすること`;
    case "members":
      return `グループ「${state.groups[sc.group]?.name ?? sc.group}」のメンバーを出し入れすること`;
    case "accept":
      return "届いた接続要求を承認すること（承認しても、共有するには別に許可が要ります）";
  }
}

/** CLI の引数（audience|policy|dirs [--project] / members <グループ> / accept）から、任せる範囲を作る */
export function parseScope(state: RelayState, kind: string | undefined, arg: string | undefined, project: string | undefined): DelegationScope {
  if (kind === "audience" || kind === "policy" || kind === "dirs") {
    const pr = requireProject(state, project).name;
    if (kind === "dirs" && pr === DEFAULT_PROJECT) throw new OpError("既定のプロジェクトにはディレクトリがないので、dirs は任せられません");
    return { kind, project: pr };
  }
  if (kind === "members") return { kind, group: requireGroup(state, arg).id };
  if (kind === "accept") return { kind };
  throw new OpError("任せる範囲は audience・policy・dirs（--project <名前>）・members <グループ>・accept のどれかです");
}

/** 画面や文面に出すプロジェクトの名前 */
export const projectLabel = (name: string) => (name === DEFAULT_PROJECT ? "既定" : name);

/** 変更の説明の頭に付ける、どのプロジェクトの設定か（プロジェクトを作っていなければ付けない） */
export function scope(state: RelayState, name: string): string {
  if (name === DEFAULT_PROJECT && Object.keys(state.projects).length === 1) return "";
  return name === DEFAULT_PROJECT ? "既定のプロジェクトで、" : `プロジェクト「${name}」で、`;
}

/** 引数のディレクトリを、比べるときの形（realpath・worktree は元のリポジトリ）にする */
export function dirArg(dir: string): string {
  try {
    return canonicalDir(resolve(dir));
  } catch {
    throw new OpError(`ディレクトリ「${dir}」が見つかりません`);
  }
}

export function requireGroup(state: RelayState, ref: string | undefined): LocalGroup {
  const g = ref ? findGroup(state, ref) : undefined;
  if (!g) throw new OpError(`グループ「${(ref ?? "").replace(/^group:/, "")}」はありません`);
  return g;
}

/** 保留（どのプロジェクトにも入らない）を比べるときの名前。プロジェクトの名前にはならない */
export const HOLD = "\u0000hold";

/** 接続を解除・ブロックした相手を、連絡先・グループ・アクセス権限から外す */
export function forget(s: RelayState, id: string): void {
  delete s.contacts[id];
  delete s.pendingNames[id];
  for (const p of Object.values(s.projects)) delete p.access.people[id];
  for (const g of Object.values(s.groups)) g.members = g.members.filter((m) => m !== id);
}

/**
 * 比べる組（変える前のプロジェクト, 変えたあとのプロジェクト, 見出し）。
 * 共有の設定を変える操作では、同じプロジェクトの前後。ディレクトリの付け外しでは、そのディレクトリが入るプロジェクトの前後
 */
export type Shift = { before: string; after: string; label: string };

/** 共有してよい相手の変化の説明（増えた人・減った人）。Policy が変わって、届く相手がいれば、それも広げる扱い */
export function describeDiff(before: RelayState, after: RelayState, shifts: Shift[]): { widens: boolean; note: string } {
  const names = (ids: string[]) => ids.map((id) => after.contacts[id]?.name ?? before.contacts[id]?.name ?? short(id)).join("、");
  const parts: string[] = [];
  let widens = false;
  for (const sh of shifts) {
    const b = before.projects[sh.before] ? allowedSet(before, sh.before) : new Set<string>();
    const a = after.projects[sh.after] ? allowedSet(after, sh.after) : new Set<string>();
    const added = [...a].filter((id) => !b.has(id));
    const removed = [...b].filter((id) => !a.has(id));
    const tag = sh.label ? `（${sh.label}）` : "";
    if (added.length) parts.push(`共有する相手が増えます${tag}: ${names(added)}`);
    if (removed.length) parts.push(`共有しなくなる相手${tag}: ${names(removed)}`);
    if (added.length) widens = true;
    if (sh.before !== sh.after && a.size > 0 && before.projects[sh.before]?.policy?.text !== after.projects[sh.after]?.policy?.text) {
      parts.push(`共有方針が変わります${tag}`);
      widens = true;
    }
  }
  return { widens, note: parts.length ? `（${parts.join("。")}）` : "" };
}

/** 共有の設定を変える操作で比べる組（どのプロジェクトも、同じプロジェクトの前後）。プロジェクトが1つなら見出しは付けない */
export function sameProjects(before: RelayState): Shift[] {
  const names = Object.keys(before.projects);
  return names.map((n) => ({ before: n, after: n, label: names.length > 1 ? projectLabel(n) : "" }));
}

/**
 * ディレクトリの付け外しを任せられる範囲。付け外すプロジェクトのほか、ディレクトリを取ってくるプロジェクトの dirs も要る。
 * ホームディレクトリやその上を足す（ほとんどの作業場所が入ってしまう）のは、任せた範囲でもさせない
 */
export function dirScopes(s: RelayState, project: string, added: string[]): DelegationScope[] | undefined {
  let home = resolve(homedir());
  try {
    home = canonicalDir(home);
  } catch {
    // ホームがなければ、そのまま比べる
  }
  if (added.some((d) => home === d || home.startsWith(d.endsWith(sep) ? d : d + sep))) return undefined;
  const from = new Set<string>([project]);
  for (const other of Object.values(s.projects)) if (other.name !== project && other.dirs.some((d) => added.includes(d))) from.add(other.name);
  return [...from].map((n) => ({ kind: "dirs" as const, project: n }));
}
