/**
 * v2 で Client（この PC）が持つ状態。Relay には置かない（docs/v2-design.md §6.4・§7・§8・§13.4）。
 * - 連絡先: 接続済みの Agent と、主人が付けた呼び名、検証して固定した鍵
 * - グループ: Agent ID の集合。この PC だけのもので、他のメンバーとは共有しない
 * - アクセス権限: 誰に共有してよいか（個人・グループ単位）。既定はすべて禁止
 * - Policy: 主人が自然言語で書いた共有方針（意味の判断は Agent が行う）
 * - 受信箱: 受け取って検証・復号した Narrative Message（利用期限まで）
 * どれも主人の判断で変えるもので、エージェントが自分の判断で変えないよう、変更は CLI で主人の確認を取る（apps/cli の relay コマンド）。
 */
import { join } from "node:path";
import {
  type NarrativeMessage,
  type RelayDirectoryEntry,
  isAgentId,
  isValidDisplayName,
  verifyDirectoryEntry,
} from "@souieba/core";
import { readStateJson, writeSecretJson } from "./config.ts";

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

export type RelayState = {
  v: 1;
  contacts: Record<string, Contact>;
  /** 接続要求を送った・承認したときに主人が付けた呼び名（相手が承認して連絡先になるまで覚えておく） */
  pendingNames: Record<string, string>;
  groups: Record<string, LocalGroup>;
  access: { agents: Record<string, AccessRule>; groups: Record<string, AccessRule> };
  policy: { text: string; updatedAt: string } | null;
  /** 主人に知らせ済みの、届いた接続要求 */
  notifiedRequests: string[];
  /** 最後に Tell した相手（次は他の人を優先する） */
  lastToldSender: string | null;
};

export const emptyState = (): RelayState => ({
  v: 1,
  contacts: {},
  pendingNames: {},
  groups: {},
  access: { agents: {}, groups: {} },
  policy: null,
  notifiedRequests: [],
  lastToldSender: null,
});

export const MAX_POLICY_LENGTH = 1000;
export const MAX_LOCAL_GROUPS = 50;
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

  load(): RelayState {
    const s = readStateJson<RelayState>(this.path);
    return s && s.v === 1 ? { ...emptyState(), ...s } : emptyState();
  }

  save(state: RelayState): void {
    writeSecretJson(this.path, state);
  }

  update<T>(fn: (s: RelayState) => T): T {
    const s = this.load();
    const r = fn(s);
    this.save(s);
    return r;
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

export function requireContactName(name: string): string {
  const n = name.trim();
  if (!isValidDisplayName(n)) throw new RelayStateError("呼び名は1〜40文字で、日本語・英数字・一部の記号だけにしてください");
  return n;
}

/** 呼び名・Agent ID のどちらでも連絡先を引く */
export function findContact(state: RelayState, ref: string): Contact | undefined {
  if (state.contacts[ref]) return state.contacts[ref];
  const byName = Object.values(state.contacts).filter((c) => c.name === ref);
  return byName.length === 1 ? byName[0] : undefined;
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
export function accessFor(state: RelayState, agentId: string): AccessDecision {
  const own = state.access.agents[agentId];
  if (own === "allow") return { allowed: true, why: "agent_allow" };
  if (own === "deny") return { allowed: false, why: "agent_deny" };
  const rules = Object.values(state.groups)
    .filter((g) => g.members.includes(agentId))
    .map((g) => state.access.groups[g.id])
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
 * connected は Relay が接続済みと返した Agent（接続が切れた相手には送らない）
 */
export function resolveTargets(state: RelayState, targets: string[], connected: Set<string>): ResolvedTargets {
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
    if (accessFor(state, id).allowed) recipients.push(c);
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

type InboxFile = { v: 1; items: RelayInboxItem[]; seen: Record<string, string> };

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
    const f = this.load();
    const r = fn(f);
    this.save(f);
    return r;
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
  }
}
