/**
 * 暗号化したグループ名（#16、docs/public-deployment-plan.md §14）。
 * サーバは名前を読めない。名前はメンバーの Agent ごとに封をして置き、読めるクライアントが、
 * まだ封を持っていないメンバーの Agent（新しく入った人・あとから足した Agent）に封をし直す。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DirectoryAgent,
  type GroupNameBox,
  type KeyDirectory,
  type WireGroup,
  isValidDisplayName,
  openGroupName,
  sealGroupName,
  verifyGroupNameBox,
} from "@souieba/core";
import { type AgentKeys, souiebaHome, writeSecretJson } from "./config.ts";

/** User トークンでも Agent トークンでも使える、グループ名に要る API */
export type GroupNameApi = {
  groups(): Promise<WireGroup[]>;
  keys(): Promise<KeyDirectory>;
  putNameBoxes(groupId: string, input: { version: number; boxes: { agentId: string; box: GroupNameBox }[]; clearPlain?: boolean }): Promise<void>;
};

export type LocalAgentKeys = { agentId: string; keys: AgentKeys };

export type NamedGroup = WireGroup & {
  /** 復号できた名前。読めなければ null */
  name: string | null;
};

type CacheEntry = { name: string; version: number };

/**
 * 手元に覚えておくグループ名（~/.souieba/group_names.json）。
 * 作った直後や招待コードで参加した直後は、まだ自分の Agent 宛ての封がないので、ここから名前を出す。
 */
export class GroupNameCache {
  constructor(readonly path = join(souiebaHome(), "group_names.json")) {}

  private read(): Record<string, CacheEntry> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, CacheEntry>;
    } catch {
      return {};
    }
  }

  get(groupId: string, version: number): string | null {
    const e = this.read()[groupId];
    return e && e.version === version ? e.name : null;
  }

  set(groupId: string, version: number, name: string): void {
    const all = this.read();
    if (all[groupId]?.name === name && all[groupId]?.version === version) return;
    writeSecretJson(this.path, { ...all, [groupId]: { name, version } });
  }
}

/** 名前を CLI の出力に出してよいか。名前は他のメンバーが付けたもので、出力はエージェント（LLM）も読む */
export function displayGroupName(name: string | null): string | null {
  return name && isValidDisplayName(name) ? name : null;
}

/**
 * 自分のグループを取り、名前を復号する。そのあと、まだ封を持っていないメンバーの Agent に封をし直す（失敗しても続ける）。
 * local は手元の Agent の鍵（Agent トークンならその Agent だけ）。最初のものが封をし直すときの送り主になる。
 */
export async function loadGroupNames(api: GroupNameApi, local: LocalAgentKeys[], cache = new GroupNameCache()): Promise<NamedGroup[]> {
  const [groups, dir] = await Promise.all([api.groups(), api.keys()]);
  const agents = new Map<string, DirectoryAgent>(dir.users.flatMap((u) => u.agents.map((a) => [a.id, a] as const)));
  const named = groups.map((g) => {
    const fromBox = openOwnBox(g, local, agents);
    const name = fromBox ?? cache.get(g.id, g.nameVersion) ?? g.legacyName;
    if (name) cache.set(g.id, g.nameVersion, name);
    return { group: { ...g, name }, fromBox: fromBox !== null };
  });
  const sender = local[0];
  if (sender) {
    for (const { group, fromBox } of named) await reseal(api, group, fromBox, sender, agents).catch(() => {});
  }
  return named.map((n) => n.group);
}

/** 自分の Agent 宛ての封を、署名を確かめてから開く。送り主は、今いっしょにグループにいる人の Agent でなければならない */
function openOwnBox(g: WireGroup, local: LocalAgentKeys[], agents: Map<string, DirectoryAgent>): string | null {
  for (const box of g.nameBoxes) {
    const me = local.find((l) => l.agentId === box.recipientAgentId);
    const sender = agents.get(box.senderAgentId);
    if (!me || !sender || box.groupId !== g.id || box.version !== g.nameVersion) continue;
    if (!verifyGroupNameBox(box, sender.signKey)) continue;
    try {
      return openGroupName(box, { agentId: me.agentId, encKey: me.keys.enc });
    } catch {}
  }
  return null;
}

async function reseal(api: GroupNameApi, g: NamedGroup, fromBox: boolean, sender: LocalAgentKeys, agents: Map<string, DirectoryAgent>) {
  if (!g.name) return;
  const targets = g.missingAgentIds.map((id) => agents.get(id)).filter((a): a is DirectoryAgent => !!a);
  // 平文の名前を消すのは、メンバーの Agent 全員が封を持てたときだけ（Agent がまだ1つもなければ消さない）
  const clearPlain = !!g.legacyName && targets.length === g.missingAgentIds.length && (targets.length > 0 || fromBox);
  if (targets.length === 0 && !clearPlain) return;
  const boxes = targets.map((a) => ({
    agentId: a.id,
    box: sealGroupName(g.name!, { groupId: g.id, version: g.nameVersion }, { agentId: sender.agentId, signKey: sender.keys.sign }, { agentId: a.id, encKey: a.encKey }),
  }));
  await api.putNameBoxes(g.id, { version: g.nameVersion, boxes, ...(clearPlain ? { clearPlain } : {}) });
}

/** グループ名の変更用。メンバーの Agent 全員宛てに、新しい版の封を作る */
export function sealForMembers(name: string, groupId: string, version: number, dir: KeyDirectory, sender: LocalAgentKeys) {
  return dir.users
    .filter((u) => u.groupIds.includes(groupId))
    .flatMap((u) => u.agents)
    .map((a) => ({
      agentId: a.id,
      box: sealGroupName(name, { groupId, version }, { agentId: sender.agentId, signKey: sender.keys.sign }, { agentId: a.id, encKey: a.encKey }),
    }));
}
