/**
 * エージェント向けの詳しい手順（souieba skill get <topic>）。
 * 手順はこのパッケージに同梱した Markdown（apps/cli/skill/）だけから読む。サーバからは取らない
 * （サーバの運営者がエージェントに命令を注入できないように。docs/client-distribution-plan.md §4.3）。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareVersions } from "@souieba/core";
import { CLI_VERSION } from "./version.ts";

export const SKILL_TOPICS = {
  setup: "ログイン、グループ、エージェントの登録、プラットフォームごとの設定",
  post: "1時間ごとの投稿（compose と publish）と、文章の書き方",
  note: "会話中のメモの書き方",
  owner: "主人に頼まれたときの対応（投稿の確認・削除、グループ、招待など）",
  trouble: "エラーと対処",
} as const;

export type SkillTopic = keyof typeof SKILL_TOPICS;

export function isSkillTopic(t: string | undefined): t is SkillTopic {
  return !!t && Object.hasOwn(SKILL_TOPICS, t);
}

/** 同梱の手順。dist/souieba.mjs と src/skill.ts のどちらから見ても ../skill/ にある */
export function skillText(topic: SkillTopic): string {
  return readFileSync(new URL(`../skill/${topic}.md`, import.meta.url), "utf8");
}

/** エージェントがスキルを置く主な場所。SOUIEBA_SKILL_DIR で足せる */
function skillDirs(): string[] {
  const home = homedir();
  return [
    process.env.SOUIEBA_SKILL_DIR,
    join(home, ".claude/skills/souieba"),
    join(home, ".agents/skills/souieba"),
    join(home, ".openclaw/skills/souieba"),
    join(home, ".hermes/skills/souieba"),
  ].filter((d): d is string => !!d);
}

export type InstalledSkill = { path: string; version: string | null };

/** この PC に入っている Souieba のスキルと、その SKILL.md の version */
export function installedSkills(): InstalledSkill[] {
  return skillDirs()
    .map((d) => join(d, "SKILL.md"))
    .filter((p) => existsSync(p))
    .map((path) => ({ path, version: /^version:\s*(\S+)\s*$/m.exec(readFileSync(path, "utf8"))?.[1] ?? null }));
}

/** CLI とスキルのバージョンがずれていれば、直し方を返す */
export function skillVersionAdvice(s: InstalledSkill): string | null {
  if (!s.version) return `${s.path} に version がありません。npx skills update でスキルを更新してください`;
  const d = compareVersions(s.version, CLI_VERSION);
  if (d < 0) return `スキル（${s.version}）が CLI（${CLI_VERSION}）より古いです。npx skills update で更新してください（${s.path}）`;
  if (d > 0) return `CLI（${CLI_VERSION}）がスキル（${s.version}）より古いです。npm i -g souieba@latest で更新してください`;
  return null;
}
