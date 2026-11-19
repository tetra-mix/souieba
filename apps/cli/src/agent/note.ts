/** 主人のしていることのメモ（souieba note）と、メモのプロジェクトの決め方 */
import {
  DEFAULT_PROJECT,
  type NoteContext,
  type NoteProjectChoice,
  RelayStateError,
  resolveNoteProject,
  resolveRelayAgent,
} from "@souieba/sdk";
import { NeedsApprovalError, approvalMessage, relayParts } from "../relay.ts";
import { OpError, projectLabel, relayOps } from "../relay-ops.ts";
import { sessionGuide } from "../integrations/shared/guide.ts";
import { type AgentFlags, type AgentResult, context, out, parsePeriod, print, rewriteRequest, shq } from "./context.ts";

/** メモを書くときの文脈（プロジェクトを決めるのに使う。docs/v2-projects.md §3） */
export type NoteOptions = Omit<NoteContext, "pin" | "sessionCwd" | "env"> & {
  /** 会話の ID（フックの session_id。CLI の --session）。主人の指定（pin）とフックが知らせた作業ディレクトリを引く */
  session?: string | null;
  /** souieba mcp の会話での指定（MCP は会話ごとにプロセスが分かれるので、プロセスの中に持つ） */
  pin?: string | null;
};

/** 会話中に知った主人の活動をローカルに書き溜める（サーバには送らない） */
export function note(flags: AgentFlags, text: string, opts: NoteOptions = {}): void {
  print(flags, noteResult(flags, text, opts));
}

/** このメモのプロジェクトを決める。会話の ID があれば、主人の指定とフックが知らせた作業ディレクトリを使う */
export function noteProjectFor(flags: AgentFlags, opts: NoteOptions = {}): NoteProjectChoice | null {
  const ctx = context(flags);
  const now = flags.now();
  const sess = opts.session ? ctx.parts.sessions.get(opts.session, now) : null;
  return resolveNoteProject(ctx.transport.localState(), {
    cwd: opts.cwd,
    client: opts.client,
    pin: opts.pin ?? sess?.pin ?? null,
    sessionCwd: sess?.cwd ?? null,
    roots: opts.roots,
    guess: opts.guess,
  });
}

/**
 * 主人の規則・会話の指定・作業場所・エージェントの推定の順にプロジェクトを決める（docs/v2-projects.md §3）。
 * どれでも決まらなければ、主人の設定どおり既定のプロジェクトか保留
 */
export function noteResult(flags: AgentFlags, text: string, opts: NoteOptions = {}): AgentResult {
  const ctx = context(flags);
  const { notes } = ctx;
  const now = flags.now();
  let choice: NoteProjectChoice | null;
  try {
    choice = noteProjectFor(flags, opts);
  } catch (err) {
    if (!(err instanceof RelayStateError)) throw err;
    return { ok: false, json: { ok: false, error: "unknown_project" }, text: `souieba: ${err.message}。メモはしていません。` };
  }
  try {
    const n = notes.add(text, now, choice?.project ?? undefined, choice?.via);
    notes.prune(now);
    let where = "";
    if (choice) {
      if (choice.via === "hold") where = "（どのプロジェクトにも決まらないので保留にしました。主人が振り分けるまで送りません）";
      else if (choice.project !== DEFAULT_PROJECT || choice.via === "inferred") where = `（プロジェクト: ${projectLabel(choice.project!)}${choice.via === "inferred" ? "・推定" : ""}）`;
    }
    const rejected = choice?.rejectedGuess
      ? choice.rejectedGuess.reason === "not_accepted"
        ? `プロジェクト「${choice.rejectedGuess.project}」は推定では選べない設定なので、使いませんでした。`
        : `プロジェクト「${choice.rejectedGuess.project}」はないので、推定は使いませんでした。`
      : "";
    return {
      ok: true,
      json: { ok: true, note: n, project: choice?.project ?? null, via: choice?.via ?? null, inferred: choice?.via === "inferred", rejectedGuess: choice?.rejectedGuess ?? null },
      text: `souieba: メモしました${where}。${rejected}`,
    };
  } catch (err) {
    return rewriteRequest(err);
  }
}

/**
 * フックから、この会話の作業ディレクトリを覚えて、会話のIDの手引きを返す。
 * （作業ディレクトリはフックが知らせたもので、エージェントが言うものではない）
 */
export function hookSession(flags: AgentFlags, sess: { id: string; cwd: string | null }): string | null {
  const ctx = context(flags);
  ctx.parts.sessions.touch(sess.id, sess.cwd, flags.now());
  return sessionGuide(sess.id, inferenceHint(flags));
}

/** エージェントが推定に使える、プロジェクトの一覧（説明つき。推定で選べないものは出さない）。なければ null */
export function inferenceHint(flags: AgentFlags): string | null {
  const ctx = context(flags);
  const s = ctx.transport.localState();
  const list = Object.values(s.projects).filter((p) => p.name !== DEFAULT_PROJECT && p.acceptInference !== false);
  if (list.length === 0) return null;
  return list.map((p) => `${p.name}${p.description ? `: ${p.description}` : ""}`).join(" / ");
}

/**
 * まだ送っていないメモを別のプロジェクトに移す（souieba note move）。移した先で届く相手が増えるなら、
 * relay の設定と同じく、--yes（エージェント）か端末での確認が要る
 */
export async function noteMove(flags: AgentFlags, to: string, opts: { from?: string; periodStart?: string; yes?: boolean; held?: boolean; ts?: string }): Promise<void> {
  const r = resolveRelayAgent();
  if (!r) throw new Error("Person がありません。souieba init <Relay の URL> を実行してください");
  const parts = relayParts(r, flags.now);
  const ops = relayOps({ parts, selfId: r.personId, now: flags.now });
  const periodStart = opts.periodStart ? parsePeriod(opts.periodStart).periodStart : undefined;
  const change = ops.noteMove(to, { from: opts.from, periodStart, held: opts.held, ts: opts.ts });
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  if (change.widens && !opts.yes) {
    if (!interactive) {
      const cmd = [
        "souieba note move",
        shq(to),
        ...(opts.from ? ["--from", shq(opts.from)] : []),
        ...(periodStart ? ["--period", periodStart] : []),
        ...(opts.held ? ["--held"] : []),
        ...(opts.ts ? ["--note", opts.ts] : []),
      ].join(" ");
      throw new NeedsApprovalError(approvalMessage(change.summary, `次のコマンドを実行してください:\n  ${cmd} --yes`));
    }
    const { ttyAsk } = await import("../relay.ts");
    if (!(await ttyAsk(change.summary))) throw new OpError("取りやめました");
  }
  const result = await change.apply();
  if (!interactive) ops.record(change);
  out(flags, { ok: true }, `souieba: ${result}`);
}
