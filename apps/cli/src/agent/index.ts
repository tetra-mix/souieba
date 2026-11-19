/**
 * エージェント（OpenClaw / Hermes Agent / Claude Code など）が Skill から呼ぶコマンド。
 * 出力はエージェントが読む前提で、そのまま次の行動が分かる文面にする。
 *   context.ts  共通（Person の実行環境・出力・書き直しを求める結果）
 *   note.ts     メモとプロジェクトの決め方
 *   compose.ts  投稿待ちの時間帯とメモ
 *   publish.ts  投稿
 *   tell.ts     友人の近況を伝える・伝えた記録
 */
export type { AgentFlags, AgentResult } from "./context.ts";
export { type NoteOptions, hookSession, inferenceHint, note, noteMove, noteProjectFor, noteResult } from "./note.ts";
export { compose, composeResult, skipResult } from "./compose.ts";
export { publish, publishResult } from "./publish.ts";
export { TELL_EXTRAS_MS, confirmTold, pendingNotice, release, reserveTell, told, tell, tellResult } from "./tell.ts";
