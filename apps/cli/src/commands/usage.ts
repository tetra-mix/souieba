import { configPath } from "@souieba/sdk";
import { HOOK_TARGETS } from "../integrations/hook/index.ts";
import { SKILL_TOPICS } from "../skill.ts";
import { renderUsage } from "./catalog.ts";

export const USAGE = renderUsage({ topics: Object.keys(SKILL_TOPICS).join(" / "), hooks: HOOK_TARGETS.join("|") }, configPath());
