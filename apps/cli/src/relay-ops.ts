/**
 * v2 の設定を変える操作。CLI（souieba relay ...）と TUI（souieba relay ui）で共通に使う。
 *
 * どの操作も、まず「何が変わるか」（Change）を組み立ててから実行する。
 * 共有の範囲を広げる操作（widens）は、呼び出し側で主人の承認を取ってから apply する（docs/v2-relay-plan.md §5）。
 * 広げるかどうかは、共有してよい相手の集合が増えるか（アクセス権限・グループ）と、操作の種類（接続・承認・ブロック解除・Policy）で決める。
 * 共有先と Policy はプロジェクトごと（docs/v2-projects.md）。ディレクトリの付け外しとプロジェクトの削除は、
 * そのディレクトリのメモが届く相手が、前後で増えるかで決める。
 *
 * 主人がエージェントに任せた範囲（delegations。docs/v2-projects.md §9）の中の広げる操作は、1回ごとの確認なしで実行できる。
 * どの操作がどの範囲に入るかは、操作ごとに scopes で示す（scopes がない広げる操作は、任せられない）。
 * 任せる操作（delegateGrant）は ownerOnly で、主人が直接（TUI か端末での y/N）しか実行できない。
 */
import { isAgentId, isValidDisplayName } from "@souieba/core";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import {
  type AccessRule,
  type Contact,
  DEFAULT_PROJECT,
  type DelegationScope,
  type LocalGroup,
  MAX_CHANGE_LOG,
  MAX_LOCAL_GROUPS,
  MAX_POLICY_LENGTH,
  MAX_PROJECTS,
  NotesStore,
  type Project,
  type RelayState,
  allowedSet,
  canonicalDir,
  delegationCovers,
  emptyProject,
  findContact,
  findGroup,
  findProject,
  isGroupId,
  matchProject,
  requireContactName,
  requireProjectName,
  scopeKey,
} from "@souieba/sdk";
import type { relayParts } from "./relay.ts";

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
export const DELEGATION_TERMS = { "24h": 24 * 3_600_000, "7d": 7 * 86_400_000, forever: null } as const;
export type DelegationTerm = keyof typeof DELEGATION_TERMS;

export function parseTerm(v: string | undefined): DelegationTerm {
  const t = (v ?? "24h").trim();
  if (t === "無期限" || t === "none") return "forever";
  if (t in DELEGATION_TERMS) return t as DelegationTerm;
  throw new OpError("期限は 24h・7d・forever のどれかにしてください");
}

const termLabel = (t: DelegationTerm) => (t === "24h" ? "24時間" : t === "7d" ? "7日間" : "期限なし（取り消すまで）");

export type OpsContext = {
  parts: ReturnType<typeof relayParts>;
  selfId: string;
  now: () => Date;
};

export class OpError extends Error {}

const short = (id: string) => `${id.slice(0, 10)}…`;

export function who(state: RelayState, id: string): string {
  const c = state.contacts[id];
  return c ? `${c.name}（${short(id)}）` : id;
}

export function requireContact(state: RelayState, ref: string | undefined): Contact {
  if (!ref) throw new OpError("相手（呼び名か Agent ID）を指定してください");
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
function scope(state: RelayState, name: string): string {
  if (name === DEFAULT_PROJECT && Object.keys(state.projects).length === 1) return "";
  return name === DEFAULT_PROJECT ? "既定のプロジェクトで、" : `プロジェクト「${name}」で、`;
}

/** 引数のディレクトリを、比べるときの形（realpath・worktree は元のリポジトリ）にする */
function dirArg(dir: string): string {
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

/** 接続を解除・ブロックした相手を、連絡先・グループ・アクセス権限から外す */
function forget(s: RelayState, id: string): void {
  delete s.contacts[id];
  delete s.pendingNames[id];
  for (const p of Object.values(s.projects)) delete p.access.agents[id];
  for (const g of Object.values(s.groups)) g.members = g.members.filter((m) => m !== id);
}

/**
 * 比べる組（変える前のプロジェクト, 変えたあとのプロジェクト, 見出し）。
 * 共有の設定を変える操作では、同じプロジェクトの前後。ディレクトリの付け外しでは、そのディレクトリが入るプロジェクトの前後
 */
type Shift = { before: string; after: string; label: string };

/** 共有してよい相手の変化の説明（増えた人・減った人）。Policy が変わって、届く相手がいれば、それも広げる扱い */
function describeDiff(before: RelayState, after: RelayState, shifts: Shift[]): { widens: boolean; note: string } {
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
function sameProjects(before: RelayState): Shift[] {
  const names = Object.keys(before.projects);
  return names.map((n) => ({ before: n, after: n, label: names.length > 1 ? projectLabel(n) : "" }));
}

/**
 * ディレクトリの付け外しを任せられる範囲。付け外すプロジェクトのほか、ディレクトリを取ってくるプロジェクトの dirs も要る。
 * ホームディレクトリやその上を足す（ほとんどの作業場所が入ってしまう）のは、任せた範囲でもさせない
 */
function dirScopes(s: RelayState, project: string, added: string[]): DelegationScope[] | undefined {
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

export function relayOps(ctx: OpsContext) {
  const { parts: p } = ctx;
  const load = () => p.state.load();

  /** 手元の状態だけを変える操作。変える前後で、共有してよい相手が増えるかを比べる（既定は、どのプロジェクトも同じプロジェクトの前後） */
  function mutation(
    summary: string,
    fn: (s: RelayState) => void,
    done: string,
    opts: { alwaysWidens?: boolean; shifts?: (before: RelayState, after: RelayState) => Shift[]; after?: () => void; scopes?: DelegationScope[] } = {},
  ): Change {
    const before = load();
    const after = structuredClone(before);
    fn(after);
    const diff = describeDiff(before, after, opts.shifts ? opts.shifts(before, after) : sameProjects(before));
    return {
      summary: `${summary}${diff.note}`,
      widens: opts.alwaysWidens || diff.widens,
      scopes: opts.scopes,
      apply: async () => {
        p.state.update(fn);
        opts.after?.();
        return done;
      },
    };
  }

  /** ディレクトリごとに、そのメモが入るプロジェクトの前後を比べる */
  const dirShifts = (dirs: string[]) => (before: RelayState, after: RelayState) =>
    dirs.map((d) => ({ before: matchProject(before, d).project, after: matchProject(after, d).project, label: d }));

  return {
    connect(id: string, rawName: string): Change {
      if (!isAgentId(id)) throw new OpError("Agent ID の形式が不正です（sb_ で始まる文字列）");
      if (id === ctx.selfId) throw new OpError("自分自身には接続できません");
      const name = requireContactName(rawName, load(), id);
      return {
        summary: `Agent ${id} に接続を要求し、呼び名を「${name}」にします（相手が承認すると接続になります。共有するには、別に許可が要ります）`,
        widens: true,
        apply: async () => {
          const [e] = await p.http.lookup([id]);
          if (!e) throw new OpError(`${id} は Relay に登録されていません`);
          p.state.update((s) => void (s.pendingNames[id] = name));
          const c = await p.http.connect(id);
          await p.transport().syncContacts();
          return c.status === "accepted" ? `「${name}」と接続しました` : `「${name}」に接続を要求しました。相手が承認すると接続になります`;
        },
      };
    },

    accept(id: string, rawName: string): Change {
      if (!isAgentId(id)) throw new OpError("Agent ID の形式が不正です（sb_ で始まる文字列）");
      const name = requireContactName(rawName, load(), id);
      return {
        summary: `Agent ${id} からの接続要求を承認し、呼び名を「${name}」にします（相手からの近況が届くようになります。こちらから共有するには、別に許可が要ります）`,
        widens: true,
        scopes: [{ kind: "accept" }],
        apply: async () => {
          p.state.update((s) => void (s.pendingNames[id] = name));
          await p.http.accept(id);
          await p.transport().syncContacts();
          return `「${name}」と接続しました`;
        },
      };
    },

    reject(id: string): Change {
      if (!isAgentId(id)) throw new OpError("Agent ID の形式が不正です（sb_ で始まる文字列）");
      return {
        summary: `Agent ${id} からの接続要求を断ります（相手には知らせません）`,
        widens: false,
        apply: async () => {
          await p.http.reject(id);
          return "断りました";
        },
      };
    },

    rename(ref: string, rawName: string): Change {
      const s = load();
      const c = findContact(s, ref);
      if (!c && !isAgentId(ref)) throw new OpError(`連絡先に「${ref}」がありません`);
      const id = c?.agentId ?? ref;
      const name = requireContactName(rawName, s, id);
      return {
        summary: `${who(s, id)} の呼び名を「${name}」にします`,
        widens: false,
        apply: async () => {
          p.state.update((st) => {
            if (st.contacts[id]) st.contacts[id]!.name = name;
            else st.pendingNames[id] = name;
          });
          if (!c) await p.transport().syncContacts();
          return `呼び名を「${name}」にしました`;
        },
      };
    },

    disconnect(ref: string, opts: { block?: boolean } = {}): Change {
      const s = load();
      const id = isAgentId(ref) ? ref : requireContact(s, ref).agentId;
      return {
        summary: opts.block
          ? `${who(s, id)} をブロックします（接続を解除し、この相手からの接続要求も届かなくなります）`
          : `${who(s, id)} との接続を解除します（承認待ちの要求の取り消しも。まだ届いていない近況は、どちら向きも届きません）`,
        widens: false,
        apply: async () => {
          if (opts.block) await p.http.block(id);
          else await p.http.disconnect(id);
          p.state.update((st) => forget(st, id));
          return opts.block ? "ブロックしました" : "接続を解除しました";
        },
      };
    },

    unblock(id: string): Change {
      if (!isAgentId(id)) throw new OpError("Agent ID の形式が不正です（sb_ で始まる文字列）");
      return {
        summary: `${id} のブロックを解除します（この相手から、また接続要求が届くようになります）`,
        widens: true,
        apply: async () => {
          await p.http.unblock(id);
          return "ブロックを解除しました";
        },
      };
    },

    /** rule が null なら個別の設定を消す。project を省くと既定のプロジェクト */
    setAccess(ref: string, rule: AccessRule | null, project: string = DEFAULT_PROJECT): Change {
      const s = load();
      const pr = requireProject(s, project).name;
      const g = ref.startsWith("group:") || (!findContact(s, ref) && findGroup(s, ref)) ? requireGroup(s, ref) : undefined;
      const id = g ? g.id : requireContact(s, ref).agentId;
      const target = g ? `グループ「${g.name}」（${g.members.length}人）` : who(s, id);
      const verb = rule === "allow" ? "に近況を共有してよいことにします" : rule === "deny" ? "には近況を共有しないことにします" : "の個別の設定を消します";
      return mutation(
        `${scope(s, pr)}${target}${verb}`,
        (st) => {
          const acc = st.projects[pr]!.access;
          const table = g ? acc.groups : acc.agents;
          if (rule === null) delete table[id];
          else table[id] = rule;
        },
        `${scope(s, pr)}${target}${verb.replace("ことにします", "ことにしました").replace("消します", "消しました")}`,
        { scopes: [{ kind: "audience", project: pr }] },
      );
    },

    groupCreate(id: string, rawName: string): Change {
      const name = rawName.trim() || id;
      if (!isGroupId(id)) throw new OpError("グループの ID は英小文字・数字・-_ で、32文字までにしてください");
      if (!isValidDisplayName(name)) throw new OpError("グループ名は1〜40文字で、日本語・英数字・一部の記号だけにしてください");
      const s = load();
      if (s.groups[id]) throw new OpError(`グループ「${id}」はすでにあります`);
      if (Object.values(s.groups).some((g) => g.name === name) || Object.values(s.contacts).some((c) => c.name === name)) {
        throw new OpError(`「${name}」はほかのグループか連絡先の名前と同じです`);
      }
      if (Object.keys(s.groups).length >= MAX_LOCAL_GROUPS) throw new OpError(`グループは ${MAX_LOCAL_GROUPS} 個までです`);
      return mutation(
        `グループ「${name}」[${id}] を作ります（この PC だけのグループで、相手には共有されません）`,
        (st) => void (st.groups[id] = { id, name, members: [], createdAt: ctx.now().toISOString() }),
        `グループ「${name}」を作りました`,
      );
    },

    groupMembers(ref: string, add: string[], remove: string[]): Change {
      const s = load();
      const g = requireGroup(s, ref);
      const addIds = add.map((r) => requireContact(s, r).agentId);
      const removeIds = remove.map((r) => requireContact(s, r).agentId);
      if (addIds.length + removeIds.length === 0) throw new OpError("加える・外す相手を指定してください");
      const names = (ids: string[]) => ids.map((id) => s.contacts[id]!.name).join("、");
      const what =
        addIds.length && removeIds.length
          ? `グループ「${g.name}」に ${names(addIds)} を加え、${names(removeIds)} を外します`
          : addIds.length
            ? `グループ「${g.name}」に ${names(addIds)} を加えます`
            : `グループ「${g.name}」から ${names(removeIds)} を外します`;
      return mutation(
        what,
        (st) => {
          const grp = st.groups[g.id]!;
          grp.members = [...new Set([...grp.members.filter((m) => !removeIds.includes(m)), ...addIds])];
        },
        `グループ「${g.name}」のメンバーを変えました`,
        { scopes: [{ kind: "members", group: g.id }] },
      );
    },

    groupDelete(ref: string): Change {
      const s = load();
      const g = requireGroup(s, ref);
      return mutation(
        `グループ「${g.name}」を消します（このグループへの共有の設定も消えます）`,
        (st) => {
          delete st.groups[g.id];
          for (const pr of Object.values(st.projects)) delete pr.access.groups[g.id];
          st.delegations = (st.delegations ?? []).filter((d) => !(d.scope.kind === "members" && d.scope.group === g.id));
        },
        `グループ「${g.name}」を消しました`,
      );
    },

    /** Policy は意味の判断に使うもので、機械的には狭めたか広げたか分からないので、変えるときはいつも承認を取る */
    policySet(text: string, project: string = DEFAULT_PROJECT): Change {
      const t = text.trim();
      if (!t) throw new OpError("共有方針の文章を指定してください");
      if (t.length > MAX_POLICY_LENGTH) throw new OpError(`共有方針は ${MAX_POLICY_LENGTH} 文字までにしてください`);
      const s = load();
      const pr = requireProject(s, project).name;
      return mutation(
        `${scope(s, pr)}共有方針を次の内容にします:\n  ${t}`,
        (st) => void (st.projects[pr]!.policy = { text: t, updatedAt: ctx.now().toISOString() }),
        "共有方針を設定しました",
        { alwaysWidens: true, scopes: [{ kind: "policy", project: pr }] },
      );
    },

    policyClear(project: string = DEFAULT_PROJECT): Change {
      const s = load();
      const pr = requireProject(s, project).name;
      return mutation(`${scope(s, pr)}共有方針を消します（方針による制限がなくなります）`, (st) => void (st.projects[pr]!.policy = null), "共有方針を消しました", {
        alwaysWidens: true,
        scopes: [{ kind: "policy", project: pr }],
      });
    },

    /**
     * プロジェクトを作る。共有先は空で始まる（copyDefault なら既定のプロジェクトの共有先と Policy を写す）。
     * ディレクトリを渡せば結び付ける。そのディレクトリのメモが届く相手が増えるなら、広げる操作
     */
    projectAdd(rawName: string, dirs: string[], opts: { copyDefault?: boolean } = {}): Change {
      const s = load();
      let name: string;
      try {
        name = requireProjectName(rawName, s);
      } catch (err) {
        throw new OpError(err instanceof Error ? err.message : String(err));
      }
      if (Object.keys(s.projects).length >= MAX_PROJECTS) throw new OpError(`プロジェクトは ${MAX_PROJECTS} 個までです`);
      const canon = [...new Set(dirs.map(dirArg))];
      const def = s.projects[DEFAULT_PROJECT]!;
      const where = canon.length ? `（ディレクトリ: ${canon.join("、")}）` : "";
      const how = opts.copyDefault ? "既定のプロジェクトの共有先と共有方針を写して" : "共有先を空で";
      return mutation(
        `プロジェクト「${name}」を${how}作ります${where}`,
        (st) => {
          const pr = emptyProject(name, ctx.now().toISOString(), canon);
          if (opts.copyDefault) {
            pr.access = structuredClone(def.access);
            pr.policy = def.policy ? { ...def.policy } : null;
          }
          for (const other of Object.values(st.projects)) other.dirs = other.dirs.filter((d) => !canon.includes(d));
          st.projects[name] = pr;
        },
        `プロジェクト「${name}」を作りました`,
        { shifts: dirShifts(canon) },
      );
    },

    /** ディレクトリを付ける・外す。ほかのプロジェクトに付いていたディレクトリは、そちらから外して付け替える */
    projectDirs(ref: string, add: string[], remove: string[]): Change {
      const s = load();
      const pr = requireProject(s, ref);
      if (pr.name === DEFAULT_PROJECT) throw new OpError("既定のプロジェクトにはディレクトリを付けられません（どのプロジェクトにも入らないディレクトリが既定になります）");
      const addDirs = [...new Set(add.map(dirArg))];
      const removeDirs = remove.map((d) => {
        const hit = pr.dirs.find((x) => x === d || x === resolve(d));
        if (hit) return hit;
        const c = dirArg(d);
        if (!pr.dirs.includes(c)) throw new OpError(`プロジェクト「${pr.name}」にディレクトリ「${d}」は付いていません`);
        return c;
      });
      if (addDirs.length + removeDirs.length === 0) throw new OpError("付ける・外すディレクトリを指定してください");
      const what = [
        addDirs.length ? `プロジェクト「${pr.name}」に ${addDirs.join("、")} を付けます` : "",
        removeDirs.length ? `プロジェクト「${pr.name}」から ${removeDirs.join("、")} を外します（ほかに合うプロジェクトがなければ既定になります）` : "",
      ]
        .filter(Boolean)
        .join("。");
      return mutation(
        what,
        (st) => {
          for (const other of Object.values(st.projects)) if (other.name !== pr.name) other.dirs = other.dirs.filter((d) => !addDirs.includes(d));
          const t = st.projects[pr.name]!;
          t.dirs = [...new Set([...t.dirs.filter((d) => !removeDirs.includes(d)), ...addDirs])];
        },
        `プロジェクト「${pr.name}」のディレクトリを変えました`,
        { shifts: dirShifts([...addDirs, ...removeDirs]), scopes: dirScopes(s, pr.name, addDirs) },
      );
    },

    /** プロジェクトを消す。そのディレクトリと、まだ送っていないメモは既定のプロジェクトになる */
    projectDelete(ref: string): Change {
      const s = load();
      const pr = requireProject(s, ref);
      if (pr.name === DEFAULT_PROJECT) throw new OpError("既定のプロジェクトは消せません");
      return mutation(
        `プロジェクト「${pr.name}」を消します（ディレクトリと、まだ送っていないメモは既定のプロジェクトになります）`,
        (st) => {
          delete st.projects[pr.name];
          st.delegations = (st.delegations ?? []).filter((d) => !("project" in d.scope && d.scope.project === pr.name));
        },
        `プロジェクト「${pr.name}」を消しました`,
        {
          shifts: () => [{ before: pr.name, after: DEFAULT_PROJECT, label: "このプロジェクトのメモ" }],
          after: () => void new NotesStore("", p.dir).move(DEFAULT_PROJECT, { from: pr.name }, ctx.now()),
        },
      );
    },

    /** プロジェクトの名前を変える。共有先・方針・ディレクトリ・メモ・任せた範囲はそのまま付いていく（届く相手は変わらないので、狭める扱い） */
    projectRename(ref: string, rawName: string): Change {
      const s = load();
      const pr = requireProject(s, ref);
      if (pr.name === DEFAULT_PROJECT) throw new OpError("既定のプロジェクトの名前は変えられません");
      let name: string;
      try {
        name = requireProjectName(rawName, s);
      } catch (err) {
        throw new OpError(err instanceof Error ? err.message : String(err));
      }
      return {
        summary: `プロジェクト「${pr.name}」の名前を「${name}」にします`,
        widens: false,
        apply: async () => {
          p.state.update((st) => {
            const t = st.projects[pr.name];
            if (!t) throw new OpError(`プロジェクト「${pr.name}」はありません`);
            if (st.projects[name]) throw new OpError(`プロジェクト「${name}」はすでにあります`);
            delete st.projects[pr.name];
            st.projects[name] = { ...t, name };
            for (const d of st.delegations ?? []) if ("project" in d.scope && d.scope.project === pr.name) d.scope.project = name;
          });
          new NotesStore("", p.dir).renameProject(pr.name, name);
          return `プロジェクト「${pr.name}」の名前を「${name}」にしました`;
        },
      };
    },

    /** エージェントに範囲を任せる（期限を延ばすのも同じ）。主人が直接するときだけ実行できる */
    delegateGrant(sc: DelegationScope, term: DelegationTerm): Change {
      const s = load();
      const ms = DELEGATION_TERMS[term];
      const expiresAt = ms === null ? null : new Date(ctx.now().getTime() + ms).toISOString();
      const desc = describeScope(s, sc);
      return {
        summary: `エージェントに、${desc}を任せます（${termLabel(term)}）。この範囲の中で共有を広げる操作は、1回ごとの確認なしで実行されるようになります（変えたことは次の tell で知らされます）`,
        widens: true,
        ownerOnly: true,
        apply: async () => {
          p.state.update((st) => {
            const key = scopeKey(sc);
            st.delegations = [
              ...(st.delegations ?? []).filter((d) => scopeKey(d.scope) !== key),
              { scope: sc, grantedAt: ctx.now().toISOString(), expiresAt },
            ];
          });
          return `${desc}を任せました（${termLabel(term)}）`;
        },
      };
    },

    /** 任せた範囲を取り消す（null ならすべて）。狭める操作なので、どこからでも実行できる */
    delegateRevoke(sc: DelegationScope | null): Change {
      const s = load();
      const has = (s.delegations ?? []).some((d) => sc === null || scopeKey(d.scope) === scopeKey(sc));
      if (!has) throw new OpError(sc === null ? "任せている範囲はありません" : `「${describeScope(s, sc)}」は任せていません`);
      return {
        summary: sc === null ? "エージェントに任せた範囲を、すべて取り消します" : `エージェントに任せた「${describeScope(s, sc)}」を取り消します`,
        widens: false,
        apply: async () => {
          p.state.update((st) => {
            st.delegations = sc === null ? [] : (st.delegations ?? []).filter((d) => scopeKey(d.scope) !== scopeKey(sc));
          });
          return "取り消しました";
        },
      };
    },

    /** 主人が任せた範囲の中の操作か（期限切れは数えない） */
    covered(change: Change): boolean {
      return !!change.scopes && !change.ownerOnly && delegationCovers(load(), change.scopes, ctx.now());
    },

    /** まだ送っていないメモを別のプロジェクトに付け替える（souieba note move）。届く相手が増えるなら広げる操作 */
    noteMove(to: string, opts: { from?: string; periodStart?: string }): Change {
      const s = load();
      const target = requireProject(s, to).name;
      const from = opts.from !== undefined ? requireProject(s, opts.from).name : undefined;
      const sources = from !== undefined ? [from] : Object.keys(s.projects).filter((n) => n !== target);
      const label = (n: string) => (n === DEFAULT_PROJECT ? "既定" : `「${n}」`);
      const diff = describeDiff(
        s,
        s,
        sources.map((n) => ({ before: n, after: target, label: `${label(n)}のメモ` })),
      );
      const what = `${from !== undefined ? `プロジェクト${label(from)}の` : ""}${opts.periodStart ? `${opts.periodStart} からの1時間の` : ""}まだ送っていないメモを、プロジェクト${label(target)}に移します`;
      return {
        summary: `${what}${diff.note}`,
        widens: diff.widens,
        apply: async () => {
          const n = new NotesStore("", p.dir).move(target, { from, periodStart: opts.periodStart }, ctx.now());
          return n > 0 ? `${n} 件のメモをプロジェクト${label(target)}に移しました` : "移すメモはありませんでした";
        },
      };
    },

    /** 端末の外（エージェント）から変えたことを記録する。次の tell で主人に知らせる */
    record(change: Change, opts: { delegated?: boolean } = {}): void {
      p.state.update((st) => {
        const entry = { at: ctx.now().toISOString(), summary: change.summary.replace(/\s*\n\s*/g, " "), widens: change.widens, notified: false, ...(opts.delegated ? { delegated: true } : {}) };
        st.changeLog = [...(st.changeLog ?? []), entry].slice(
          -MAX_CHANGE_LOG,
        );
      });
    },
  };
}

export type RelayOps = ReturnType<typeof relayOps>;
