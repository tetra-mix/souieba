/**
 * v2 の設定を変える操作。CLI（souieba relay ...）と TUI（souieba relay ui）で共通に使う。
 *
 * どの操作も、まず「何が変わるか」（Change）を組み立ててから実行する。
 * 共有の範囲を広げる操作（widens）は、呼び出し側で主人の承認を取ってから apply する（docs/v2-relay-plan.md §5）。
 * 広げるかどうかは、共有してよい相手の集合が増えるか（アクセス権限・グループ）と、操作の種類（接続・承認・ブロック解除・Policy）で決める。
 */
import { isAgentId, isValidDisplayName } from "@souieba/core";
import {
  type AccessRule,
  type Contact,
  type LocalGroup,
  MAX_CHANGE_LOG,
  MAX_LOCAL_GROUPS,
  MAX_POLICY_LENGTH,
  type RelayState,
  allowedSet,
  findContact,
  findGroup,
  isGroupId,
  requireContactName,
} from "@souieba/sdk";
import type { relayParts } from "./relay.ts";

export type Change = {
  /** 主人に見せる、変更の内容 */
  summary: string;
  /** 共有の範囲を広げるか（広げるなら主人の承認が要る） */
  widens: boolean;
  /** 実行して、結果の文を返す */
  apply: () => Promise<string>;
};

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

export function requireGroup(state: RelayState, ref: string | undefined): LocalGroup {
  const g = ref ? findGroup(state, ref) : undefined;
  if (!g) throw new OpError(`グループ「${(ref ?? "").replace(/^group:/, "")}」はありません`);
  return g;
}

/** 接続を解除・ブロックした相手を、連絡先・グループ・アクセス権限から外す */
function forget(s: RelayState, id: string): void {
  delete s.contacts[id];
  delete s.pendingNames[id];
  delete s.access.agents[id];
  for (const g of Object.values(s.groups)) g.members = g.members.filter((m) => m !== id);
}

/** 共有してよい相手の変化の説明（増えた人・減った人） */
function describeDiff(before: RelayState, after: RelayState): { widens: boolean; note: string } {
  const b = allowedSet(before);
  const a = allowedSet(after);
  const added = [...a].filter((id) => !b.has(id));
  const removed = [...b].filter((id) => !a.has(id));
  const names = (ids: string[]) => ids.map((id) => after.contacts[id]?.name ?? before.contacts[id]?.name ?? short(id)).join("、");
  const parts: string[] = [];
  if (added.length) parts.push(`共有する相手が増えます: ${names(added)}`);
  if (removed.length) parts.push(`共有しなくなる相手: ${names(removed)}`);
  return { widens: added.length > 0, note: parts.length ? `（${parts.join("。")}）` : "" };
}

export function relayOps(ctx: OpsContext) {
  const { parts: p } = ctx;
  const load = () => p.state.load();

  /** 手元の状態だけを変える操作。変える前後で、共有してよい相手が増えるかを比べる */
  function mutation(summary: string, fn: (s: RelayState) => void, done: string, opts: { alwaysWidens?: boolean } = {}): Change {
    const before = load();
    const after = structuredClone(before);
    fn(after);
    const diff = describeDiff(before, after);
    return {
      summary: `${summary}${diff.note}`,
      widens: opts.alwaysWidens || diff.widens,
      apply: async () => {
        p.state.update(fn);
        return done;
      },
    };
  }

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

    /** rule が null なら個別の設定を消す */
    setAccess(ref: string, rule: AccessRule | null): Change {
      const s = load();
      const g = ref.startsWith("group:") || (!findContact(s, ref) && findGroup(s, ref)) ? requireGroup(s, ref) : undefined;
      const id = g ? g.id : requireContact(s, ref).agentId;
      const target = g ? `グループ「${g.name}」（${g.members.length}人）` : who(s, id);
      const verb = rule === "allow" ? "に近況を共有してよいことにします" : rule === "deny" ? "には近況を共有しないことにします" : "の個別の設定を消します";
      return mutation(
        `${target}${verb}`,
        (st) => {
          const table = g ? st.access.groups : st.access.agents;
          if (rule === null) delete table[id];
          else table[id] = rule;
        },
        `${target}${verb.replace("ことにします", "ことにしました").replace("消します", "消しました")}`,
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
      );
    },

    groupDelete(ref: string): Change {
      const s = load();
      const g = requireGroup(s, ref);
      return mutation(
        `グループ「${g.name}」を消します（このグループへの共有の設定も消えます）`,
        (st) => {
          delete st.groups[g.id];
          delete st.access.groups[g.id];
        },
        `グループ「${g.name}」を消しました`,
      );
    },

    /** Policy は意味の判断に使うもので、機械的には狭めたか広げたか分からないので、変えるときはいつも承認を取る */
    policySet(text: string): Change {
      const t = text.trim();
      if (!t) throw new OpError("共有方針の文章を指定してください");
      if (t.length > MAX_POLICY_LENGTH) throw new OpError(`共有方針は ${MAX_POLICY_LENGTH} 文字までにしてください`);
      return mutation(`共有方針を次の内容にします:\n  ${t}`, (st) => void (st.policy = { text: t, updatedAt: ctx.now().toISOString() }), "共有方針を設定しました", {
        alwaysWidens: true,
      });
    },

    policyClear(): Change {
      return mutation("共有方針を消します（方針による制限がなくなります）", (st) => void (st.policy = null), "共有方針を消しました", { alwaysWidens: true });
    },

    /** 端末の外（エージェント）から変えたことを記録する。次の tell で主人に知らせる */
    record(change: Change): void {
      p.state.update((st) => {
        st.changeLog = [...(st.changeLog ?? []), { at: ctx.now().toISOString(), summary: change.summary.split("\n")[0]!, widens: change.widens, notified: false }].slice(
          -MAX_CHANGE_LOG,
        );
      });
    },
  };
}

export type RelayOps = ReturnType<typeof relayOps>;
