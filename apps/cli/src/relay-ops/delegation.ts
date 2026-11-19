/** エージェントに任せる範囲と、端末の外からの変更の記録の操作 */
import { type DelegationScope, MAX_CHANGE_LOG, delegationCovers, scopeKey } from "@souieba/sdk";
import { type Change, DELEGATION_TERMS, type DelegationTerm, termLabel, OpError, describeScope } from "./helpers.ts";
import type { OpsEnv } from "./env.ts";

export function delegationOps({ ctx, p, load }: OpsEnv) {
  return {
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
