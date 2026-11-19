import type { relayParts } from "../relay.ts";
import type { DelegationScope, RelayState } from "@souieba/sdk";
import { matchProject } from "@souieba/sdk";
import { type Change, type Shift, describeDiff, sameProjects } from "./helpers.ts";

export type OpsContext = {
  parts: ReturnType<typeof relayParts>;
  selfId: string;
  now: () => Date;
};

/** 操作のグループ（contacts・access・projects・delegation）が共有する道具 */
export function createEnv(ctx: OpsContext) {
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

  return { ctx, p, load, mutation, dirShifts };
}

export type OpsEnv = ReturnType<typeof createEnv>;
