import { SKILL_TOPICS, installedSkills, isSkillTopic, skillText, skillVersionAdvice } from "../skill.ts";
import { CLI_VERSION } from "../version.ts";
import { usageOf } from "./catalog.ts";
import type { CommandContext } from "./context.ts";

/** souieba skill get <topic> | skill list */
export function skillCommand({ sub, rest }: CommandContext): void {
  if (sub === "get" && isSkillTopic(rest[0])) {
    // 手順の先頭に、どのバージョンの CLI の手順かを出す（スキルとのずれに気づけるように）
    console.log(`<!-- souieba ${CLI_VERSION} / skill get ${rest[0]} -->`);
    for (const s of installedSkills()) {
      const advice = skillVersionAdvice(s);
      if (advice) console.log(`> 注意: ${advice}`);
    }
    console.log(skillText(rest[0]));
  } else if (sub === "list" || sub === undefined) {
    for (const [t, d] of Object.entries(SKILL_TOPICS)) console.log(`${t}\t${d}`);
  } else {
    throw new Error(`${usageOf("skill get")}（topic: ${Object.keys(SKILL_TOPICS).join(" / ")}）`);
  }
}
