/**
 * v2 で Client（この PC）が持つ状態。Relay には置かない（docs/v2-design.md §6.4・§7・§8・§13.4）。
 * 2.1.0 から人ごと: この PC のすべての端末（エージェント）が、~/.souieba/person/ の1組を共有する。
 * - 連絡先: 接続済みの人と、主人が付けた呼び名、検証して固定した Person 鍵と、知っている端末
 * - グループ: Person ID の集合。この PC だけのもので、他のメンバーとは共有しない
 * - プロジェクト: 作業するディレクトリに名前を付けたもの。プロジェクトごとに共有先（アクセス権限）と Policy を持つ（docs/v2-projects.md）
 *   - アクセス権限: 誰に共有してよいか（個人・グループ単位）。既定はすべて禁止
 *   - Policy: 主人が自然言語で書いた共有方針（意味の判断は Agent が行う）
 *   - どのプロジェクトにも入らないディレクトリ（と、ディレクトリを持たない会話）は default プロジェクト
 * - 受信箱: 受け取って検証・復号した Narrative Message（利用期限まで）
 * どれも主人の判断で変えるもので、エージェントが自分の判断で変えないよう、変更は CLI で主人の確認を取る（apps/cli の relay コマンド）。
 */
import { join } from "node:path";
import { type NarrativeMessage, type RelayEnvelope, isPersonId, isValidDisplayName } from "@souieba/core";
import { readStateJson, writeSecretJson } from "./config.ts";
import { withFileLock } from "./notes.ts";

export type Contact = {
  personId: string;
  /** 主人が付けた呼び名（Tell 文に入る） */
  name: string;
  /** 初めて接続したときに Person ID から確かめて固定した Person 鍵 */
  personKey: string;
  /** 知っている端末（Device ID → 暗号化鍵の版）。版が戻ったら使わない */
  devices: Record<string, number>;
  /** 確かめた端末の取り消し（Relay が取り消しを隠しても、この端末には送らない） */
  revoked: string[];
  addedAt: string;
  /** 端末が増えた・鍵が替わった日時（まだ主人に知らせていなければ残す） */
  devicesChangedAt?: string;
};

export type LocalGroup = { id: string; name: string; members: string[]; createdAt: string };

export type AccessRule = "allow" | "deny";

/** people は Person ID ごとの設定 */
export type ProjectAccess = { people: Record<string, AccessRule>; groups: Record<string, AccessRule> };

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
  /** どんな作業のプロジェクトか（主人が書く。エージェントがメモのプロジェクトを推定するときに読む） */
  description?: string;
  /** エージェントの推定（note の project の推定）でこのプロジェクトに入れてよいか。既定は true（仕事などは false にする） */
  acceptInference?: boolean;
};

/** どのプロジェクトにも入らないときに使う、既定のプロジェクト（消せない） */
export const DEFAULT_PROJECT = "default";

/** どのプロジェクトにも決まらなかったメモの扱い。default: 既定のプロジェクトに入れる（既定）/ hold: 主人が振り分けるまで送らない */
export type UnresolvedMode = "default" | "hold";

export type RelayState = {
  v: 3;
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
  /**
   * 主人がエージェントに任せた範囲（docs/v2-projects.md §9）。この範囲の中の「広げる操作」は、1回ごとの確認なしで実行できる。
   * 任せる・広げるのは主人だけ（TUI か、端末での y/N）。取り消すのはどこからでもよい
   */
  delegations?: Delegation[];
  /** MCP のクライアント（initialize の clientInfo.name）ごとに、メモを入れるプロジェクト（主人の規則） */
  clients?: Record<string, string>;
  /** どのプロジェクトにも決まらなかったメモの扱い（既定は default） */
  unresolved?: UnresolvedMode;
  /** 送った近況の、手元だけの記録（relay sent でプロジェクトと「推定」を出す。配送期限が過ぎたら消す） */
  sent?: Record<string, { project: string; inferred: boolean; at: string; until: string }>;
};

/** 変えたのが、主人に任された範囲の中でのことなら delegated */
export type SettingsChange = { at: string; summary: string; widens: boolean; notified: boolean; delegated?: boolean };

/**
 * 任せる範囲。小さく、はっきりしたものだけにする。どれも「任せる範囲そのものを作る・広げる」ことは含まない
 * - audience: プロジェクトの共有先（個人・グループの allow / deny / unset）
 * - policy: プロジェクトの共有方針
 * - dirs: プロジェクトのディレクトリの付け外し
 * - members: グループのメンバーの出し入れ
 * - accept: 届いた接続要求の承認（承認しても、共有するには別に許可が要る）
 */
export type DelegationScope =
  | { kind: "audience" | "policy" | "dirs"; project: string }
  | { kind: "members"; group: string }
  | { kind: "accept" };

export type Delegation = { scope: DelegationScope; grantedAt: string; /** null なら期限なし */ expiresAt: string | null };

/** 任せる範囲を1つの文字列にする（同じ範囲は1つだけ持つ） */
export function scopeKey(s: DelegationScope): string {
  return s.kind === "accept" ? "accept" : s.kind === "members" ? `members:${s.group}` : `${s.kind}:${s.project}`;
}

/** 今も効いている、任せた範囲 */
export function activeDelegations(state: RelayState, now: Date): Delegation[] {
  const t = now.toISOString();
  return (state.delegations ?? []).filter((d) => d.expiresAt === null || d.expiresAt > t);
}

/** scopes のどれもが、今も効いている任せた範囲に入っているか（空なら false） */
export function delegationCovers(state: RelayState, scopes: DelegationScope[], now: Date): boolean {
  if (scopes.length === 0) return false;
  const keys = new Set(activeDelegations(state, now).map((d) => scopeKey(d.scope)));
  return scopes.every((s) => keys.has(scopeKey(s)));
}

/** 手元に残す変更の記録の上限 */
export const MAX_CHANGE_LOG = 50;

export const emptyProject = (name: string, createdAt: string, dirs: string[] = []): Project => ({
  name,
  dirs,
  access: { people: {}, groups: {} },
  policy: null,
  createdAt,
});

export const emptyState = (): RelayState => ({
  v: 3,
  contacts: {},
  pendingNames: {},
  groups: {},
  projects: { [DEFAULT_PROJECT]: emptyProject(DEFAULT_PROJECT, new Date(0).toISOString()) },
  notifiedRequests: [],
  lastToldSender: null,
  changeLog: [],
  clients: {},
  unresolved: "default",
});

/** 共有してよい相手（今の設定で、そのプロジェクトの Publish の宛先になりうる連絡先） */
export function allowedSet(state: RelayState, project: string = DEFAULT_PROJECT): Set<string> {
  return new Set(Object.keys(state.contacts).filter((id) => accessFor(state, id, project).allowed));
}

/** 今の版の状態にする。読めない版なら null（2.0.0 の Agent ごとの状態は migrateAgentState で移す） */
export function migrateRelayState(raw: unknown): RelayState | null {
  if (!raw || typeof raw !== "object") return null;
  if ((raw as { v?: unknown }).v !== 3) return null;
  const s = { ...emptyState(), ...(raw as RelayState) };
  if (!s.projects[DEFAULT_PROJECT]) s.projects = { ...s.projects, [DEFAULT_PROJECT]: emptyState().projects[DEFAULT_PROJECT]! };
  return s;
}

/** 2.0.0 までの、Agent ごとの状態（v1: プロジェクトなし / v2: プロジェクトあり） */
type AgentStateV1 = { v: 1; contacts?: Record<string, { name?: string }>; pendingNames?: Record<string, string>; groups?: Record<string, LocalGroup>; access?: { agents?: Record<string, AccessRule>; groups?: Record<string, AccessRule> }; policy?: SharingPolicy | null; delegations?: Delegation[] };
type AgentStateV2 = Omit<AgentStateV1, "v" | "access" | "policy"> & {
  v: 2;
  projects?: Record<string, { name: string; dirs?: string[]; access?: { agents?: Record<string, AccessRule>; groups?: Record<string, AccessRule> }; policy?: SharingPolicy | null; createdAt?: string }>;
};

export type AgentStateMigration = {
  state: RelayState;
  /** つなぎ直してもらう相手（ID が変わったので、連絡先は移せない） */
  oldContacts: { name: string; agentId: string }[];
  /** 移せなかった設定（個人ごとの共有の設定・グループのメンバー）の説明 */
  dropped: string[];
};

/**
 * 2.0.0 の Agent ごとの状態（relay-state.json）を、人ごとの状態に移す（souieba init --from）。
 * プロジェクト（ディレクトリ・方針・グループごとの共有先）・グループ（名前だけ）・任せた範囲を移す。
 * 連絡先・個人ごとの共有の設定・グループのメンバーは、相手の ID が変わるので移さない（一覧にして、つなぎ直してもらう）
 */
export function migrateAgentState(raw: unknown, now: Date): AgentStateMigration | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as AgentStateV1 | AgentStateV2;
  if (r.v !== 1 && r.v !== 2) return null;
  const state = emptyState();
  const dropped: string[] = [];
  const oldContacts = [
    ...Object.entries(r.contacts ?? {}).map(([agentId, c]) => ({ agentId, name: typeof c?.name === "string" ? c.name : agentId })),
    ...Object.entries(r.pendingNames ?? {}).map(([agentId, name]) => ({ agentId, name })),
  ];
  for (const g of Object.values(r.groups ?? {})) {
    if (!g || !isGroupId(g.id)) continue;
    state.groups[g.id] = { id: g.id, name: g.name, members: [], createdAt: g.createdAt ?? now.toISOString() };
    if (g.members?.length) dropped.push(`グループ「${g.name}」のメンバー ${g.members.length} 人（つなぎ直したら、もう一度加えてください）`);
  }
  const projects =
    r.v === 1
      ? { [DEFAULT_PROJECT]: { name: DEFAULT_PROJECT, dirs: [], access: r.access, policy: r.policy ?? null, createdAt: new Date(0).toISOString() } }
      : (r.projects ?? {});
  for (const [name, p] of Object.entries(projects)) {
    if (!p) continue;
    const pr = emptyProject(name, p.createdAt ?? now.toISOString(), name === DEFAULT_PROJECT ? [] : [...(p.dirs ?? [])]);
    for (const [gid, rule] of Object.entries(p.access?.groups ?? {})) if (state.groups[gid] && (rule === "allow" || rule === "deny")) pr.access.groups[gid] = rule;
    const people = Object.keys(p.access?.agents ?? {}).length;
    if (people) dropped.push(`プロジェクト「${name === DEFAULT_PROJECT ? "既定" : name}」の個人ごとの共有の設定 ${people} 件`);
    pr.policy = p.policy ?? null;
    state.projects[name] = pr;
  }
  if (!state.projects[DEFAULT_PROJECT]) state.projects[DEFAULT_PROJECT] = emptyState().projects[DEFAULT_PROJECT]!;
  state.delegations = (r.delegations ?? []).filter((d) => {
    const sc = d?.scope;
    if (!sc) return false;
    if (sc.kind === "members") return !!state.groups[sc.group];
    if (sc.kind === "accept") return true;
    return !!state.projects[sc.project];
  });
  return { state, oldContacts, dropped };
}

export const MAX_POLICY_LENGTH = 1000;
/** プロジェクトの説明の上限（推定のためにエージェントへ渡すので、短くする） */
export const MAX_PROJECT_DESCRIPTION = 200;
export const MAX_LOCAL_GROUPS = 50;
export const MAX_PROJECTS = 50;
const GROUP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class RelayStateError extends Error {}

export function isGroupId(id: string): boolean {
  return GROUP_ID_RE.test(id);
}

/** 人の状態ディレクトリ（~/.souieba/person/）に置く、v2 の状態ファイル */
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

/** 確かめた1人分のディレクトリ（verifyPersonDirectory の結果）から、連絡先を作る */
export function contactFrom(personId: string, personKey: string, devices: { deviceId: string; encKeyVersion: number }[], revoked: string[], name: string, now: Date): Contact {
  return {
    personId,
    name,
    personKey,
    devices: Object.fromEntries(devices.map((d) => [d.deviceId, d.encKeyVersion])),
    revoked: [...revoked],
    addedAt: now.toISOString(),
  };
}

/**
 * 呼び名を確かめる。Tell 文に入るので表示名と同じ規則にし、宛先の指定で見分けられるよう、
 * ほかの連絡先（承認待ちを含む）と重なる名前と、宛先の予約語（all）は断る。self はその名前を付け直す相手の Person ID
 */
export function requireContactName(name: string, state?: RelayState, self?: string): string {
  const n = name.trim();
  if (!isValidDisplayName(n)) throw new RelayStateError("呼び名は1〜40文字で、日本語・英数字・一部の記号だけにしてください");
  if (n.toLowerCase() === "all") throw new RelayStateError("「all」は宛先の指定（全員）に使うので、呼び名にはできません");
  if (state) {
    const taken = [
      ...Object.values(state.contacts).map((c) => [c.personId, c.name] as const),
      ...Object.entries(state.pendingNames),
    ].some(([id, other]) => id !== self && other === n);
    if (taken) throw new RelayStateError(`「${n}」という呼び名の相手がすでにいます。別の呼び名にしてください`);
    if (Object.values(state.groups).some((g) => g.name === n || g.id === n)) {
      throw new RelayStateError(`「${n}」はグループの名前と同じです。別の呼び名にしてください`);
    }
  }
  return n;
}

/** 呼び名・ID のどちらでも連絡先を引く */
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

export type AccessDecision = { allowed: boolean; why: "person_allow" | "person_deny" | "group_allow" | "group_deny" | "default_deny" };

/**
 * その人に共有してよいか（§7）。優先順位は次のとおり（docs/v2-relay-plan.md「未決定事項の決定」）:
 * 1. 個人の設定があればそれに従う（グループの設定より優先）
 * 2. 入っているグループの設定のうち、1つでも deny があれば禁止
 * 3. 入っているグループのどれかが allow なら許可
 * 4. どれもなければ禁止（既定）
 */
export function accessFor(state: RelayState, personId: string, project: string = DEFAULT_PROJECT): AccessDecision {
  const p = state.projects[project];
  // 知らないプロジェクトには誰にも共有しない
  if (!p) return { allowed: false, why: "default_deny" };
  const own = p.access.people[personId];
  if (own === "allow") return { allowed: true, why: "person_allow" };
  if (own === "deny") return { allowed: false, why: "person_deny" };
  const rules = Object.values(state.groups)
    .filter((g) => g.members.includes(personId))
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
 * Publish の宛先を決める。targets は "all"（既定。接続済みの全員）・"group:<ID か名前>"・Person ID・呼び名。
 * 送信時点の連絡先とグループのメンバーだけを使う（あとから加わった人に過去のメッセージは届かない。§6.3）。
 * connected は Relay が接続済みと返した人（接続が切れた相手には送らない）。アクセス権限は project の設定だけで決める
 */
export function resolveTargets(state: RelayState, targets: string[], connected: Set<string>, project: string = DEFAULT_PROJECT): ResolvedTargets {
  if (!state.projects[project]) throw new RelayStateError(`プロジェクト「${project}」はありません`);
  const wanted = new Set<string>();
  const unknown: string[] = [];
  for (const t of targets.length ? targets : ["all"]) {
    if (t === "all") {
      for (const id of Object.keys(state.contacts)) wanted.add(id);
    } else if (t.startsWith("group:") || (!isPersonId(t) && findGroup(state, t) && !findContact(state, t))) {
      const g = findGroup(state, t);
      if (!g) throw new RelayStateError(`グループ「${t.replace(/^group:/, "")}」はありません`);
      for (const id of g.members) wanted.add(id);
    } else {
      const c = findContact(state, t);
      if (c) wanted.add(c.personId);
      else if (isPersonId(t)) unknown.push(t);
      else throw new RelayStateError(`宛先「${t}」が見つかりません（呼び名・ID・group:<グループ> のどれか）`);
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
