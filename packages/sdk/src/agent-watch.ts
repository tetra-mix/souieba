import { existsSync, readFileSync } from "node:fs";
import type { DirectoryAgent } from "@souieba/core";
import { writeSecretJson } from "./config.ts";

/**
 * 自分のアカウントに登録されている Agent を覚えておき、増えたものを知らせる。
 * User トークンが漏れて、他人が鍵を持つ Agent を足された（＝なりすましと盗み読みを始められた）ことに気づくため。
 * Agent ごとに1つのファイル（~/.souieba/agents/<id>/known_agents.json）に記録する。
 */
export class AgentWatch {
  constructor(readonly path: string) {}

  /** 前回から増えた Agent を返して、今の一覧を記録する。初回は記録だけして何も返さない */
  check(own: DirectoryAgent[]): DirectoryAgent[] {
    const first = !existsSync(this.path);
    const known = new Set<string>(first ? [] : ((JSON.parse(readFileSync(this.path, "utf8")) as { ids?: string[] }).ids ?? []));
    const added = own.filter((a) => !known.has(a.id));
    if (first || added.length > 0) writeSecretJson(this.path, { ids: [...new Set([...known, ...own.map((a) => a.id)])] });
    return first ? [] : added;
  }
}
