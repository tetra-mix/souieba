/**
 * 共有の設定を変える操作。CLI（souieba connect・allow など）と TUI（souieba ui）で共通に使う。
 *
 * どの操作も、まず「何が変わるか」（Change）を組み立ててから実行する。
 * 共有の範囲を広げる操作（widens）は、呼び出し側で主人の承認を取ってから apply する（docs/architecture.md）。
 * 広げるかどうかは、共有してよい相手の集合が増えるか（アクセス権限・グループ）と、操作の種類（接続・承認・ブロック解除・Policy）で決める。
 * 共有先と Policy はプロジェクトごと（docs/v2-projects.md）。ディレクトリの付け外しとプロジェクトの削除は、
 * そのディレクトリのメモが届く相手が、前後で増えるかで決める。
 *
 * 主人がエージェントに任せた範囲（delegations。docs/v2-projects.md §9）の中の広げる操作は、1回ごとの確認なしで実行できる。
 * どの操作がどの範囲に入るかは、操作ごとに scopes で示す（scopes がない広げる操作は、任せられない）。
 * 任せる操作（delegateGrant）は ownerOnly で、主人が直接（TUI か端末での y/N）しか実行できない。
 *
 * 操作はグループごとのファイルに分けている: contacts.ts（接続）・access.ts（共有先・グループ・Policy）・
 * projects.ts（プロジェクト・メモの振り分け）・delegation.ts（任せる範囲・変更の記録）。共通の部品は helpers.ts と env.ts。
 */
import { accessOps } from "./access.ts";
import { contactOps } from "./contacts.ts";
import { delegationOps } from "./delegation.ts";
import { type OpsContext, createEnv } from "./env.ts";
import { projectOps } from "./projects.ts";

export type { OpsContext } from "./env.ts";
export {
  type Change,
  DELEGATION_TERMS,
  type DelegationTerm,
  HOLD,
  OpError,
  describeScope,
  parseScope,
  parseTerm,
  projectLabel,
  requireContact,
  requireGroup,
  requireProject,
  who,
} from "./helpers.ts";

export function relayOps(ctx: OpsContext) {
  const env = createEnv(ctx);
  return { ...contactOps(env), ...accessOps(env), ...projectOps(env), ...delegationOps(env) };
}

export type RelayOps = ReturnType<typeof relayOps>;
