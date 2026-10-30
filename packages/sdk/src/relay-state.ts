/**
 * v2 で Client（この PC）が持つ状態。Relay には置かない（docs/v2-design.md §6.4・§7・§8・§13.4）。
 * - 連絡先: 接続済みの Agent と、主人が付けた呼び名、検証して固定した鍵
 * - グループ: Agent ID の集合。この PC だけのもので、他のメンバーとは共有しない
 * - プロジェクト: 作業するディレクトリに名前を付けたもの。プロジェクトごとに共有先（アクセス権限）と Policy を持つ（docs/v2-projects.md）
 *   - アクセス権限: 誰に共有してよいか（個人・グループ単位）。既定はすべて禁止
 *   - Policy: 主人が自然言語で書いた共有方針（意味の判断は Agent が行う）
 *   - どのプロジェクトにも入らないディレクトリ（と、ディレクトリを持たない会話）は default プロジェクト
 * - 受信箱: 受け取って検証・復号した Narrative Message（利用期限まで）
 * どれも主人の判断で変えるもので、エージェントが自分の判断で変えないよう、変更は CLI で主人の確認を取る（apps/cli の relay コマンド）。
 */
import { join } from "node:path";
import {
  type NarrativeMessage,
  type RelayDirectoryEntry,
  type RelayEnvelope,
  isAgentId,
  isValidDisplayName,
  verifyDirectoryEntry,
} from "@souieba/core";
import { readStateJson, writeSecretJson } from "./config.ts";
import { withFileLock } from "./notes.ts";

export type Contact = {
  agentId: string;
  /** 主人が付けた呼び名（Tell 文に入る） */
  name: string;
  /** 初めて接続したときに検証して固定した鍵 */
  identityKey: string;
  encKey: string;
  encKeyVersion: number;
  encKeySig: string;
  addedAt: string;
  /** Encryption 鍵が新しい版に替わった日時（まだ主人に知らせていなければ残す） */
  keyChangedAt?: string;
};

export type LocalGroup = { id: string; name: string; members: string[]; createdAt: string };

export type AccessRule = "allow" | "deny";

export type ProjectAccess = { agents: Record<string, AccessRule>; groups: Record<string, AccessRule> };

export type SharingPolicy = { text: string; updatedAt: string };

/**
 * 名前を付けた作業の文脈。共有先と Policy は default を引き継がない（default を広げたときに、知らないうちに広がらないように）。
 * プロジェクトはこの PC だけの設定で、Relay にも相手にも見えない
 */
export type Project = {
  name: string;
  /** 結び付けたディレクトリ（realpath。git の worktree は元のリポジトリの場所にしてある）。default は持たない */
  dirs: string[];
  access: ProjectAccess;
  policy: SharingPolicy | null;
  createdAt: string;
};

/** どのプロジェクトにも入らないときに使う、既定のプロジェクト（消せない） */
export const DEFAULT_PROJECT = "default";

export type RelayState = {
  v: 2;
  contacts: Record<string, Contact>;
  /** 接続要求を送った・承認したときに主人が付けた呼び名（相手が承認して連絡先になるまで覚えておく） */
  pendingNames: Record<string, string>;
  groups: Record<string, LocalGroup>;
  /** プロジェクト（名前で引く）。default はいつもある */
  projects: Record<string, Project>;
  /** 主人に知らせ済みの、届いた接続要求 */
  notifiedRequests: string[];
  /** 最後に Tell した相手（次は他の人を優先する） */
  lastToldSender: string | null;
  /**
   * 端末の外（エージェント）から変えた共有の設定。次の tell で主人に知らせる（知らせたら notified にする）。
   * 主人がだまされたエージェントに設定を変えられても、気づけるように
   */
  changeLog?: SettingsChange[];
};

export type SettingsChange = { at: string; summary: string; widens: boolean; notified: boolean };

/** 手元に残す変更の記録の上限 */
export const MAX_CHANGE_LOG = 50;

export const emptyProject = (name: string, createdAt: string, dirs: string[] = []): Project => ({
  name,
  dirs,
  access: { agents: {}, groups: {} },
  policy: null,
  createdAt,
});

export const emptyState = (): RelayState => ({
  v: 2,
  contacts: {},
  pendingNames: {},
  groups: {},
  projects: { [DEFAULT_PROJECT]: emptyProject(DEFAULT_PROJECT, new Date(0).toISOString()) },
  notifiedRequests: [],
  lastToldSender: null,
  changeLog: [],
});

/** 共有してよい相手（今の設定で、そのプロジェクトの Publish の宛先になりうる連絡先） */
export function allowedSet(state: RelayState, project: string = DEFAULT_PROJECT): Set<string> {
  return new Set(Object.keys(state.contacts).filter((id) => accessFor(state, id, project).allowed));
}

/** v1 の状態（プロジェクトがなかったころ）。access・policy は default プロジェクトの設定にする */
type RelayStateV1 = Omit<RelayState, "v" | "projects"> & {
  v: 1;
  access?: ProjectAccess;
  policy?: SharingPolicy | null;
};

/** 古い版の状態を今の版にする。読めない版なら null */
export function migrateRelayState(raw: unknown): RelayState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { v?: unknown };
  if (r.v === 1) {
    const { access, policy, ...rest } = raw as RelayStateV1;
    const def = emptyProject(DEFAULT_PROJECT, new Date(0).toISOString());
    def.access = { agents: { ...(access?.agents ?? {}) }, groups: { ...(access?.groups ?? {}) } };
    def.policy = policy ?? null;
    return { ...emptyState(), ...rest, v: 2, projects: { [DEFAULT_PROJECT]: def } };
  }
  if (r.v === 2) {
    const s = { ...emptyState(), ...(raw as RelayState) };
    if (!s.projects[DEFAULT_PROJECT]) s.projects = { ...s.projects, [DEFAULT_PROJECT]: emptyState().projects[DEFAULT_PROJECT]! };
    return s;
  }
  return null;
}

export const MAX_POLICY_LENGTH = 1000;
export const MAX_LOCAL_GROUPS = 50;
export const MAX_PROJECTS = 50;
const GROUP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class RelayStateError extends Error {}

export function isGroupId(id: string): boolean {
  return GROUP_ID_RE.test(id);
}

/** Agent の状態ディレクトリに置く、v2 の状態ファイル */
export class RelayStateStore {
  readonly path: string;

  constructor(dir: string) {
    this.path = join(dir, "relay-state.json");
  }

  private get lockPath(): string {
    return `${this.path}.lock`;
  }

  load(): RelayState {
    return migrateRelayState(readStateJson<unknown>(this.path)) ?? emptyState();
  }

  save(state: RelayState): void {
    writeSecretJson(this.path, state);
  }

  /** 読んで変えて書く。同時に動く別の souieba（フック・MCP・CLI）と変更を取り合わないよう、ロックを取る */
  update<T>(fn: (s: RelayState) => T): T {
    return withFileLock(this.lockPath, () => {
      const s = this.load();
      const r = fn(s);
      this.save(s);
      return r;
    });
  }
}

// ---- 連絡先と鍵の固定 ----

export type KeyCheck =
  | { ok: true; changed: boolean }
  | { ok: false; reason: "invalid_entry" | "key_rollback" | "key_conflict" };

/**
 * Relay が返した鍵を、固定した鍵と照らし合わせる（§4.5・§15.1）。
 * Agent ID は Identity 鍵のハッシュなので、ID が合えば Identity 鍵は本物。Encryption 鍵は Identity 鍵の署名で確かめる。
 * 版が上がっていれば受け入れて知らせ、版が戻っている・同じ版で鍵が違うなら、Relay のすり替えを疑って使わない。
 */
export function checkPinnedKey(contact: Contact | undefined, entry: RelayDirectoryEntry): KeyCheck {
  if (!verifyDirectoryEntry(entry).ok) return { ok: false, reason: "invalid_entry" };
  if (!contact) return { ok: true, changed: false };
  if (contact.identityKey !== entry.identityKey) return { ok: false, reason: "invalid_entry" };
  if (entry.encKeyVersion < contact.encKeyVersion) return { ok: false, reason: "key_rollback" };
  if (entry.encKeyVersion === contact.encKeyVersion) {
    return entry.encKey === contact.encKey ? { ok: true, changed: false } : { ok: false, reason: "key_conflict" };
  }
  return { ok: true, changed: true };
}

export function contactFrom(entry: RelayDirectoryEntry, name: string, now: Date): Contact {
  return {
    agentId: entry.agentId,
    name,
    identityKey: entry.identityKey,
    encKey: entry.encKey,
    encKeyVersion: entry.encKeyVersion,
    encKeySig: entry.encKeySig,
    addedAt: now.toISOString(),
  };
}

/**
 * 呼び名を確かめる。Tell 文に入るので表示名と同じ規則にし、宛先の指定で見分けられるよう、
 * ほかの連絡先（承認待ちを含む）と重なる名前と、宛先の予約語（all）は断る。self はその名前を付け直す相手の Agent ID
 */
export function requireContactName(name: string, state?: RelayState, self?: string): string {
  const n = name.trim();
  if (!isValidDisplayName(n)) throw new RelayStateError("呼び名は1〜40文字で、日本語・英数字・一部の記号だけにしてください");
  if (n.toLowerCase() === "all") throw new RelayStateError("「all」は宛先の指定（全員）に使うので、呼び名にはできません");
  if (state) {
    const taken = [
      ...Object.values(state.contacts).map((c) => [c.agentId, c.name] as const),
      ...Object.entries(state.pendingNames),
    ].some(([id, other]) => id !== self && other === n);
    if (taken) throw new RelayStateError(`「${n}」という呼び名の相手がすでにいます。別の呼び名にしてください`);
    if (Object.values(state.groups).some((g) => g.name === n || g.id === n)) {
      throw new RelayStateError(`「${n}」はグループの名前と同じです。別の呼び名にしてください`);
    }
  }
  return n;
}

/** 呼び名・Agent ID のどちらでも連絡先を引く */
export function findContact(state: RelayState, ref: string): Contact | undefined {
  if (state.contacts[ref]) return state.contacts[ref];
  const byName = Object.values(state.contacts).filter((c) => c.name === ref);
  return byName.length === 1 ? byName[0] : undefined;
}

/** プロジェクトを名前で引く（default は「既定」でも引ける） */
export function findProject(state: RelayState, ref: string): Project | undefined {
  const name = ref === "既定" ? DEFAULT_PROJECT : ref;
  return state.projects[name];
}

/**
 * プロジェクトの名前を確かめる。compose の出力（エージェントが読む）とファイルに入るので、表示名と同じ規則にする。
 * default（既定）は予約語
 */
export function requireProjectName(name: string, state?: RelayState): string {
  const n = name.trim();
  if (!isValidDisplayName(n)) throw new RelayStateError("プロジェクトの名前は1〜40文字で、日本語・英数字・一部の記号だけにしてください");
  if (n.toLowerCase() === DEFAULT_PROJECT || n === "既定") throw new RelayStateError(`「${n}」は既定のプロジェクトの名前なので使えません`);
  if (state?.projects[n]) throw new RelayStateError(`プロジェクト「${n}」はすでにあります`);
  return n;
}

export function findGroup(state: RelayState, ref: string): LocalGroup | undefined {
  const id = ref.replace(/^group:/, "");
  if (state.groups[id]) return state.groups[id];
  const byName = Object.values(state.groups).filter((g) => g.name === id);
  return byName.length === 1 ? byName[0] : undefined;
}

// ---- アクセス権限 ----

export type AccessDecision = { allowed: boolean; why: "agent_allow" | "agent_deny" | "group_allow" | "group_deny" | "default_deny" };

/**
 * その Agent に共有してよいか（§7）。優先順位は次のとおり（docs/v2-relay-plan.md「未決定事項の決定」）:
 * 1. 個人の設定があればそれに従う（グループの設定より優先）
 * 2. 入っているグループの設定のうち、1つでも deny があれば禁止
 * 3. 入っているグループのどれかが allow なら許可
 * 4. どれもなければ禁止（既定）
 */
export function accessFor(state: RelayState, agentId: string, project: string = DEFAULT_PROJECT): AccessDecision {
  const p = state.projects[project];
  // 知らないプロジェクトには誰にも共有しない
  if (!p) return { allowed: false, why: "default_deny" };
  const own = p.access.agents[agentId];
  if (own === "allow") return { allowed: true, why: "agent_allow" };
  if (own === "deny") return { allowed: false, why: "agent_deny" };
  const rules = Object.values(state.groups)
    .filter((g) => g.members.includes(agentId))
    .map((g) => p.access.groups[g.id])
    .filter((r): r is AccessRule => r !== undefined);
  if (rules.includes("deny")) return { allowed: false, why: "group_deny" };
  if (rules.includes("allow")) return { allowed: true, why: "group_allow" };
  return { allowed: false, why: "default_deny" };
}

export type ResolvedTargets = {
  /** 送ってよい宛先 */
  recipients: Contact[];
  /** 宛先に含めたが、アクセス権限がない */
  denied: string[];
  /** 宛先に含めたが、接続していない（連絡先にない） */
  notConnected: string[];
};

/**
 * Publish の宛先を決める。targets は "all"（既定。接続済みの全員）・"group:<ID か名前>"・Agent ID・呼び名。
 * 送信時点の連絡先とグループのメンバーだけを使う（あとから加わった人に過去のメッセージは届かない。§6.3）。
 * connected は Relay が接続済みと返した Agent（接続が切れた相手には送らない）。アクセス権限は project の設定だけで決める
 */
export function resolveTargets(state: RelayState, targets: string[], connected: Set<string>, project: string = DEFAULT_PROJECT): ResolvedTargets {
  if (!state.projects[project]) throw new RelayStateError(`プロジェクト「${project}」はありません`);
  const wanted = new Set<string>();
  const unknown: string[] = [];
  for (const t of targets.length ? targets : ["all"]) {
    if (t === "all") {
      for (const id of Object.keys(state.contacts)) wanted.add(id);
    } else if (t.startsWith("group:") || (!isAgentId(t) && findGroup(state, t) && !findContact(state, t))) {
      const g = findGroup(state, t);
      if (!g) throw new RelayStateError(`グループ「${t.replace(/^group:/, "")}」はありません`);
      for (const id of g.members) wanted.add(id);
    } else {
      const c = findContact(state, t);
      if (c) wanted.add(c.agentId);
      else if (isAgentId(t)) unknown.push(t);
      else throw new RelayStateError(`宛先「${t}」が見つかりません（呼び名・Agent ID・group:<グループ> のどれか）`);
    }
  }
  const recipients: Contact[] = [];
  const denied: string[] = [];
  const notConnected = [...unknown];
  for (const id of wanted) {
    const c = state.contacts[id];
    if (!c || !connected.has(id)) {
      notConnected.push(id);
      continue;
    }
    if (accessFor(state, id, project).allowed) recipients.push(c);
    else denied.push(id);
  }
  return { recipients, denied, notConnected };
}

// ---- 受信箱 ----

export type RelayInboxItem = {
  messageId: string;
  sender: string;
  createdAt: string;
  receivedAt: string;
  deliveryExpiresAt: string;
  message: NarrativeMessage;
  reservedUntil?: string;
  toldAt?: string;
};

/** 接続済みだが呼び名のない相手から届いた、まだ開けていないメッセージ（呼び名が付いたら検証して開く） */
export type HeldEnvelope = { envelope: RelayEnvelope; receivedAt: string };

/** 手元に置いておく、開けていないメッセージの上限 */
export const MAX_HELD = 200;

type InboxFile = { v: 1; items: RelayInboxItem[]; seen: Record<string, string>; held?: HeldEnvelope[] };

/** 伝えたあとも、同じメッセージの再配送（リプレイ）を見分けるため、配送期限まで ID を覚えておく */
export class RelayInboxStore {
  readonly path: string;

  constructor(dir: string) {
    this.path = join(dir, "relay-inbox.json");
  }

  load(): InboxFile {
    const f = readStateJson<InboxFile>(this.path);
    return f && f.v === 1 ? f : { v: 1, items: [], seen: {} };
  }

  save(f: InboxFile): void {
    writeSecretJson(this.path, f);
  }

  update<T>(fn: (f: InboxFile) => T): T {
    return withFileLock(`${this.path}.lock`, () => {
      const f = this.load();
      const r = fn(f);
      this.save(f);
      return r;
    });
  }

  /**
   * 利用期限を過ぎたものは受信箱から消す（§11.3。もう Tell に使わない）。伝えたものは1日だけ残す。
   * 再配送を見分けるための ID は、配送期限まで残す
   */
  static prune(f: InboxFile, now: Date): void {
    const t = now.toISOString();
    const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
    f.items = f.items.filter((i) => i.message.useExpiresAt > t && !(i.toldAt && i.toldAt < dayAgo));
    for (const [id, exp] of Object.entries(f.seen)) if (exp <= t) delete f.seen[id];
    f.held = (f.held ?? []).filter((h) => typeof h.envelope?.deliveryExpiresAt === "string" && h.envelope.deliveryExpiresAt > t).slice(-MAX_HELD);
  }
}
