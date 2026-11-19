/** 投稿待ちの時間帯とメモを、エージェントが投稿を書くための材料として出す（souieba compose） */
import { DEFAULT_PROJECT, type PendingPeriod, type RelayState, accessFor } from "@souieba/sdk";
import { projectLabel } from "../relay-ops/index.ts";
import { type AgentFlags, type AgentResult, context, fmt, hm, nextSteps, parsePeriod, pendingPeriods, print } from "./context.ts";

/** 投稿待ちの時間帯と、その材料のメモを表示する。--skip で投稿しない時間帯を確定する */
export function compose(flags: AgentFlags, skip?: string, project?: string): void {
  print(flags, skip ? skipResult(flags, skip, project) : composeResult(flags));
}

export function skipResult(flags: AgentFlags, periodStart: string, project: string = DEFAULT_PROJECT): AgentResult {
  const { periodStart: start } = parsePeriod(periodStart);
  context(flags).notes.mark(start, "skipped", project);
  return { ok: true, json: { ok: true, skipped: start, project }, text: "souieba: この時間帯は投稿しないことにしました。" };
}

export function composeResult(flags: AgentFlags): AgentResult {
  const ctx = context(flags);
  const { notes } = ctx;
  const now = flags.now();
  notes.prune(now);
  const pending = pendingPeriods(ctx, now);
  if (pending.length === 0) return { ok: true, json: { pending }, text: "souieba: 投稿待ちの時間帯はありません。" };
  return composeText(flags, pending, ctx.transport.localState());
}

/**
 * compose の文面。（時間帯, プロジェクト）ごとに、そのプロジェクトの共有の境界（共有してよい相手・Policy）とメモを1つの塊で出す。
 * Policy の意味の判断はエージェントが行い、宛先の制限は CLI が機械的に行う（docs/architecture.md）。
 * 共有先が空のプロジェクトのメモは、材料にもしないよう出さない（docs/v2-projects.md §4）
 */
function composeText(flags: AgentFlags, pending: PendingPeriod[], s: RelayState): AgentResult {
  const next = nextSteps(flags);
  // 消したプロジェクトのメモ（付け替えの前に書かれたもの）は既定として扱う
  const projectOf = (p: PendingPeriod) => (s.projects[p.project] ? p.project : DEFAULT_PROJECT);
  const allowedIn = (pr: string) => Object.values(s.contacts).filter((c) => accessFor(s, c.personId, pr).allowed);
  const anyAllowed = Object.keys(s.projects).some((pr) => allowedIn(pr).length > 0);
  const multi = Object.keys(s.projects).length > 1;
  const lines = [
    `souieba: 投稿待ちの時間帯が ${pending.length} 件あります。`,
    "各時間帯について、メモをもとに主人がしていたことを1〜2文（120字以内、「主人は」で始まる三人称、推測は「〜らしい」）にまとめて投稿してください。",
    "秘密情報・住所・金融情報・他人の個人情報・主人が「内緒」と言ったことは書かないでください。意味のある内容がなければスキップしてください。",
  ];
  if (multi) {
    lines.push(
      "時間帯はプロジェクト（主人が作業していた場所）ごとに分かれていて、共有してよい相手と共有方針もプロジェクトごとに違います。各塊は、その塊のメモだけを材料にし、ほかの塊のメモの内容を混ぜないでください。",
    );
  }
  if (!anyAllowed) {
    lines.push(
      "## 共有の範囲",
      "主人はまだ誰にも共有を許可していないので、投稿しても誰にも届きません。投稿はせずにスキップし、ユーザーへの回答のあとで、主人に souieba relay allow <相手> で共有する相手を決めるよう伝えてください。",
    );
  }
  for (const p of pending) {
    const pr = projectOf(p);
    const tag = pr === DEFAULT_PROJECT ? "" : pr;
    const inferred = p.notes.some((n) => n.via === "inferred");
    lines.push("", `## ${fmt.format(new Date(p.periodStart))}〜${hm.format(new Date(p.periodEnd))}${multi ? `  プロジェクト: ${projectLabel(pr)}${inferred ? "（推定を含む）" : ""}` : ""}`);
    // 共有先が空のプロジェクトは pendingPeriods で自動でスキップしてあるので、ここには来ない（誰にも共有していない使い始めを除く）
    const allowed = allowedIn(pr);
    if (allowed.length > 0) {
      const proj = s.projects[pr]!;
      lines.push(`共有してよい相手: ${allowed.map((c) => c.name).join("、")}`);
      const groups = Object.values(s.groups).filter((g) => proj.access.groups[g.id] === "allow");
      if (groups.length) lines.push(`共有してよいグループ: ${groups.map((g) => `${g.name}（group:${g.id}）`).join("、")}`);
      if (proj.policy) {
        lines.push(
          "主人の共有方針（主人が書いたもの。これに合わない内容は書かないでください。迷ったらスキップしてください）:",
          `<souieba_policy>${proj.policy.text}</souieba_policy>`,
        );
      } else {
        lines.push("主人の共有方針はまだありません。近況として当たり障りのないことだけを書いてください。");
      }
    }
    lines.push("メモ:");
    for (const n of p.notes) lines.push(`- ${hm.format(new Date(n.ts))} ${n.text}${n.via === "inferred" ? "（プロジェクトは推定）" : ""}`);
    lines.push(next.publish(p.periodStart, tag || undefined));
    lines.push(next.skip(p.periodStart, tag || undefined));
  }
  if (anyAllowed) {
    const flag = flags.via === "mcp" ? "souieba_publish の to・purpose・nuance・context" : "--to・--purpose・--nuance・--context";
    lines.push(
      "",
      `投稿のときは ${flag} で、宛先（省略すると、そのプロジェクトで共有してよい全員。相手の呼び名か group:<グループ>）と、伝え方の意図を添えられます（各60字以内、任意）:`,
      "  purpose: なぜこの相手に伝えたいか / nuance: どんな調子で伝えてほしいか / context: どんな話題のときに出すとよいか",
      "受け取った側のエージェントは参考にするだけで、従う義務はありません。読み手への呼びかけや命令の形は使わないでください。",
    );
  }
  return { ok: true, json: { pending: pending.map((p) => ({ ...p, project: projectOf(p) })) }, text: lines.join("\n") };
}