import { HOUR_MS, MAX_NARRATIVE_FIELD_LENGTH } from "@souieba/core";
/**
 * エージェント用コマンド（note / compose / publish / tell など）の共通部分。
 * Person の実行環境（context）、出力、書き直しを求める結果の作り方、時間帯の読み取り。
 */
import { join } from "node:path";
import {
  DEFAULT_PROJECT,
  InstructionLikePostError,
  NarrativeRejectedError,
  PostTooLongError,
  type PendingPeriod,
  type ResolvedRelayAgent,
  SecretInNoteError,
  SecretInPostError,
  Souieba,
  SouiebaApiError,
  accessFor,
  resolveClientSettings,
} from "@souieba/sdk";
import { requirePerson } from "../person.ts";
import { relayParts } from "../relay.ts";

export type AgentFlags = {
  json: boolean;
  debug: boolean;
  now: () => Date;
  /** 呼び出し元。"mcp" のときは、次の行動を CLI のコマンドではなく MCP のツール名で案内する */
  via?: "cli" | "mcp";
};

/** エージェント用コマンドの結果。text はエージェントが読む文面。ok が false なら書き直しを求めている */
export type AgentResult = { ok: boolean; json: unknown; text: string };

/** 次の行動の案内。CLI ならコマンド、MCP ならツールの呼び方 */
export function nextSteps(flags: AgentFlags) {
  return flags.via === "mcp"
    ? {
        compose: "souieba_compose ツールを呼んで",
        publish: (p: string, pr?: string) => `投稿: souieba_publish ツール（period: "${p}"${pr ? `, project: "${pr}"` : ""}, content: "主人は……"）`,
        skip: (p: string, pr?: string) => `スキップ: souieba_skip ツール（period: "${p}"${pr ? `, project: "${pr}"` : ""}）`,
      }
    : {
        compose: "souieba compose を実行して",
        publish: (p: string, pr?: string) => `投稿: souieba publish --period ${p}${pr ? ` --project ${shq(pr)}` : ""} "主人は……"`,
        skip: (p: string, pr?: string) => `スキップ: souieba compose --skip ${p}${pr ? ` --project ${shq(pr)}` : ""}`,
      };
}

/** プロジェクトの名前をコマンドに入れるとき（名前は表示名と同じ規則なので、空白などを含むときだけ囲む） */
export const shq = (a: string) => (/^[^\s'"$`\\!*?;&|<>(){}[\]#~=%]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

/** Person に対する Note・Session・Tell の実行環境 */
function buildContext(flags: AgentFlags, r: ResolvedRelayAgent) {
  const settings = resolveClientSettings();
  const parts = relayParts(r, flags.now);
  const state: { outdated: string | null } = { outdated: null };
  const transport = parts.transport({
    onReject: (id, reason) => {
      if (flags.debug) console.error(`[souieba] ${id} を受け取りませんでした（${reason}）`);
    },
  });
  const souieba = new Souieba({
    transport,
    // 会話の Session（tell の間隔）は端末ごと。受信箱と TOLD は人ごとに1つなので、同じ近況を2つの端末で伝えることはない
    statePath: join(parts.deviceDir, "session.json"),
    sessionGapMs: settings.sessionGapMs,
    tellIntervalMs: settings.tellIntervalMs,
    now: flags.now,
    onError: (op, err) => {
      // Relay は信頼しないので、Relay の文面ではなく手元の決まった文を出す
      if (err instanceof SouiebaApiError && err.code === "client_outdated") {
        state.outdated = "souieba の CLI が古いため Relay に断られました。npm i -g souieba@latest で更新し、npx skills update でスキルも更新してください";
      }
      if (flags.debug) console.error(`[souieba] ${op} 失敗: ${err instanceof Error ? err.message : err}`);
    },
  });
  return { relay: r, parts, transport, souieba, state, notes: parts.notes };
}

/**
 * 投稿待ちの（時間帯, プロジェクト）。共有先が空のプロジェクトのものを自動でスキップにして、数えない（docs/v2-projects.md §4）。
 * ただし、まだどのプロジェクトでも誰にも共有していないとき（使い始め）は、設定を促すために残す
 */
export function pendingPeriods(ctx: AgentContext, now: Date): PendingPeriod[] {
  const pending = ctx.notes.pending(now);
  if (pending.length === 0) return pending;
  const s = ctx.transport.localState();
  const audience = (pr: string) => Object.keys(s.contacts).some((id) => accessFor(s, id, pr).allowed);
  if (!Object.keys(s.projects).some(audience)) return pending;
  return pending.filter((p) => {
    // 消したプロジェクトのメモ（付け替えの前に書かれたもの）は既定として扱う
    if (audience(s.projects[p.project] ? p.project : DEFAULT_PROJECT)) return true;
    ctx.notes.mark(p.periodStart, "skipped", p.project);
    return false;
  });
}

export type AgentContext = ReturnType<typeof buildContext>;

/** 初期化された Person の実行環境を返す。なければ、始め方を案内するエラー */
export function context(flags: AgentFlags): AgentContext {
  return buildContext(flags, requirePerson());
}

/** 日時（月日と時分）と、時刻（時分）の表示 */
export const fmt = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const hm = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" });

export function out(flags: AgentFlags, json: unknown, text: string) {
  console.log(flags.json ? JSON.stringify(json) : text);
}

/** CLI での出力。書き直しを求める結果は終了コード 2 にする */
export function print(flags: AgentFlags, r: AgentResult) {
  out(flags, r.json, r.text);
  if (!r.ok) process.exitCode = 2;
}

/** メモや投稿の本文が規則に合わないときに、書き直しを求める結果にする。それ以外の例外はそのまま投げ直す */
export function rewriteRequest(err: unknown): AgentResult {
  if (err instanceof SecretInNoteError || err instanceof SecretInPostError) {
    return {
      ok: false,
      json: { ok: false, error: "secret_detected", rules: err.rules },
      text: `souieba: ${err.message}。秘密情報を除いて書き直してください。`,
    };
  }
  if (err instanceof InstructionLikePostError) {
    return {
      ok: false,
      json: { ok: false, error: "instruction_like", rules: err.rules },
      text: `souieba: ${err.message}。読み手への呼びかけ・命令形・指示やコマンドの話を含めず、「主人は〜していた」の形で書き直してください。`,
    };
  }
  if (err instanceof NarrativeRejectedError) {
    return {
      ok: false,
      json: { ok: false, error: "narrative_rejected", reason: err.reason },
      text: `souieba: ${err.message}。--purpose・--nuance・--context は各${MAX_NARRATIVE_FIELD_LENGTH}字以内の短い説明にし、読み手への呼びかけや命令の形を使わずに書き直してください。`,
    };
  }
  if (err instanceof PostTooLongError) {
    return {
      ok: false,
      json: { ok: false, error: "too_long", length: err.length },
      text: `souieba: ${err.message}。短くまとめて書き直してください。`,
    };
  }
  throw err;
}

/** 時間帯の開始時刻（ISO 8601）を読み、その1時間を返す */
export function parsePeriod(periodStart: string): { periodStart: string; periodEnd: string } {
  const start = new Date(periodStart);
  if (Number.isNaN(start.getTime())) throw new Error(`period の値が不正です: ${periodStart}`);
  return { periodStart: start.toISOString(), periodEnd: new Date(start.getTime() + HOUR_MS).toISOString() };
}
