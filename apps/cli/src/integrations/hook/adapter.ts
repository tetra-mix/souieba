/** エージェントごとのフックの違い。claude-code/・codex/・hermes/ がそれぞれ実装する */
export type HookAdapter = {
  /** フックの入力（標準入力の JSON。読めなければ null）から、主人の発言で始まった実行かを判断する。cron などでは tell しない */
  isOwnerTurn(input: unknown): boolean;
  /** エージェントに渡す文脈を、そのエージェントのフックの出力の形にする */
  format(context: string): string;
};
