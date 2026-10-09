import { existsSync, readFileSync } from "node:fs";
import type { DirectoryUser } from "@souieba/core";
import { writeSecretJson } from "./config.ts";

export type NewMember = { groupId: string; user: Pick<DirectoryUser, "id" | "handle" | "displayName"> };

type Known = { groups: string[]; members: string[] };

/**
 * 主人のグループのメンバーを覚えておき、新しく入った人を知らせる。
 * 自分の近況が届く相手が増えたことに主人が気づけるように（招待コードが漏れて知らない人が入った場合も含む）。
 * Agent ごとに1つのファイル（~/.souieba/agents/<id>/known_members.json）に記録する。
 */
export class MemberWatch {
  constructor(readonly path: string) {}

  /**
   * 前回から増えたメンバーを返して、今の一覧を記録する。
   * 初回と、主人が新しく入ったグループのメンバーは、記録だけして返さない（主人が自分で入ったので知らせる必要がない）。
   * 抜けた人は記録から消すので、入り直したらまた知らせる。
   */
  check(users: DirectoryUser[], myUserId: string): NewMember[] {
    const first = !existsSync(this.path);
    const known: Known = first ? { groups: [], members: [] } : { groups: [], members: [], ...JSON.parse(readFileSync(this.path, "utf8")) };
    const knownGroups = new Set(known.groups);
    const knownMembers = new Set(known.members);
    const myGroups = users.find((u) => u.id === myUserId)?.groupIds ?? [];

    const current: string[] = [];
    const added: NewMember[] = [];
    for (const u of users) {
      if (u.id === myUserId) continue;
      for (const groupId of u.groupIds) {
        const key = `${groupId}:${u.id}`;
        current.push(key);
        if (!first && knownGroups.has(groupId) && !knownMembers.has(key)) {
          added.push({ groupId, user: { id: u.id, handle: u.handle, displayName: u.displayName } });
        }
      }
    }
    const next: Known = { groups: [...myGroups].sort(), members: current.sort() };
    const prev: Known = { groups: [...known.groups].sort(), members: [...known.members].sort() };
    if (first || JSON.stringify(next) !== JSON.stringify(prev)) writeSecretJson(this.path, next);
    return added;
  }
}
