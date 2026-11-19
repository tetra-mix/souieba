/** 連絡先の接続・承認・ブロックの操作 */
import { isPersonId } from "@souieba/core";
import { findContact, requireContactName } from "@souieba/sdk";
import { type Change, OpError, who, requireContact, forget } from "./helpers.ts";
import type { OpsEnv } from "./env.ts";

export function contactOps({ ctx, p, load }: OpsEnv) {
  return {
    connect(id: string, rawName: string): Change {
      if (!isPersonId(id)) throw new OpError("ID の形式が不正です（sb_ で始まる文字列）");
      if (id === ctx.selfId) throw new OpError("自分自身には接続できません");
      const name = requireContactName(rawName, load(), id);
      return {
        summary: `${id} に接続を要求し、呼び名を「${name}」にします（相手が承認すると接続になります。共有するには、別に許可が要ります）`,
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
      if (!isPersonId(id)) throw new OpError("ID の形式が不正です（sb_ で始まる文字列）");
      const name = requireContactName(rawName, load(), id);
      return {
        summary: `${id} からの接続要求を承認し、呼び名を「${name}」にします（相手からの近況が届くようになります。こちらから共有するには、別に許可が要ります）`,
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
      if (!isPersonId(id)) throw new OpError("ID の形式が不正です（sb_ で始まる文字列）");
      return {
        summary: `${id} からの接続要求を断ります（相手には知らせません）`,
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
      if (!c && !isPersonId(ref)) throw new OpError(`連絡先に「${ref}」がありません`);
      const id = c?.personId ?? ref;
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
      const id = isPersonId(ref) ? ref : requireContact(s, ref).personId;
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
      if (!isPersonId(id)) throw new OpError("ID の形式が不正です（sb_ で始まる文字列）");
      return {
        summary: `${id} のブロックを解除します（この相手から、また接続要求が届くようになります）`,
        widens: true,
        apply: async () => {
          await p.http.unblock(id);
          return "ブロックを解除しました";
        },
      };
    },
  };
}
