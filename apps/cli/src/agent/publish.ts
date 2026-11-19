/** 1時間分の投稿を、Relay へ暗号化して送る（souieba publish） */
import { periodOf, DAY_MS } from "@souieba/core";
import { DEFAULT_PROJECT, NoRecipientsError, type RelayPublishOptions } from "@souieba/sdk";
import { projectLabel } from "../relay-ops/index.ts";
import { type AgentContext, type AgentFlags, type AgentResult, context, fmt, hm, parsePeriod, print, rewriteRequest } from "./context.ts";

/** periodArg: previous | current | 時間帯の開始時刻（ISO 8601） */
export async function publish(flags: AgentFlags, content: string, periodArg = "previous", narrative: RelayPublishOptions = {}): Promise<void> {
  print(flags, await publishResult(flags, content, periodArg, narrative));
}

export async function publishResult(
  flags: AgentFlags,
  content: string,
  periodArg = "previous",
  narrative: RelayPublishOptions = {},
): Promise<AgentResult> {
  const ctx = context(flags);
  const now = flags.now();
  const period = periodArg === "previous" || periodArg === "current" ? periodOf(now, periodArg) : parsePeriod(periodArg);
  const project = narrative.project ?? DEFAULT_PROJECT;
  if (!ctx.transport.localState().projects[project]) {
    return { ok: false, json: { ok: false, error: "unknown_project" }, text: `souieba: プロジェクト「${project}」はありません。souieba compose が示した --project を使ってください。` };
  }
  return sendPost(flags, ctx, period, content, { ...narrative, project });
}

async function sendPost(
  flags: AgentFlags,
  ctx: AgentContext,
  period: { periodStart: string; periodEnd: string },
  content: string,
  narrative: RelayPublishOptions,
): Promise<AgentResult> {
  let r;
  try {
    r = await ctx.transport.publishNarrative({ ...period, content }, narrative);
  } catch (err) {
    if (err instanceof NoRecipientsError) {
      // 何度 compose しても送れないので、この時間帯は投稿しないことにして、主人に設定を頼む
      ctx.notes.mark(period.periodStart, "skipped", narrative.project);
      return {
        ok: false,
        json: { ok: false, error: "no_recipients", denied: err.targets.denied, notConnected: err.targets.notConnected },
        text: `souieba: ${err.message}。この時間帯は投稿しないことにしました。ユーザーへの回答のあとで、主人に souieba status で共有の設定を確かめるよう伝えてください。あなたが設定を変えてはいけません。`,
      };
    }
    return rewriteRequest(err);
  }
  ctx.notes.mark(period.periodStart, "published", narrative.project);
  const project = narrative.project ?? DEFAULT_PROJECT;
  const inferred = ctx.notes.notesIn(period.periodStart).some((n) => (n.project ?? DEFAULT_PROJECT) === project && n.via === "inferred");
  const at = flags.now();
  ctx.parts.state.update((s) => {
    const t = at.toISOString();
    s.sent = Object.fromEntries(Object.entries(s.sent ?? {}).filter(([, v]) => v.until > t));
    s.sent[r.postId] = { project, inferred, at: t, until: new Date(at.getTime() + 7 * DAY_MS).toISOString() };
  });
  const extra: string[] = [];
  if (r.denied.length) extra.push(`共有を許可していない ${r.denied.length} 人には送っていません`);
  if (r.notConnected.length) extra.push(`接続していない ${r.notConnected.length} 人には送っていません`);
  if (r.keyProblems.length) {
    extra.push(
      `${r.keyProblems.length} 人は鍵を確かめられなかったので送っていません（Relay が鍵をすり替えた可能性があります。ユーザーへの回答のあとで、主人に伝えてください）`,
    );
  }
  return {
    ok: true,
    json: { ok: true, ...r, ...period, project, inferred },
    text: `souieba: ${r.recipients.join("、")} に送りました（${fmt.format(new Date(period.periodStart))}〜の1時間${project !== DEFAULT_PROJECT || inferred ? `、プロジェクト: ${projectLabel(project)}${inferred ? "・推定を含む" : ""}` : ""}、${hm.format(new Date(r.visibleAt))} から届きます）。${extra.join("。")}`,
  };
}