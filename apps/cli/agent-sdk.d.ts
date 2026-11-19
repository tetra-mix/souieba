// souieba/agent-sdk の型（実装は src/integrations/agents/agent-sdk.ts）。
// @anthropic-ai/claude-agent-sdk の query() の options にそのまま渡せる形にしている。

export type SouiebaOptions = {
  /** 効果はありません。Souieba は Person 単位で動くため、エージェントの名前を選ぶ仕組みはなくなりました */
  agent?: string;
};

type UserPromptSubmitOutput = { hookSpecificOutput?: { hookEventName: "UserPromptSubmit"; additionalContext: string } };

export type SouiebaAgentSdk = {
  /** systemPrompt の append（preset: "claude_code" の場合）か、自前のシステムプロンプトの末尾に足す */
  systemPrompt: string;
  /** options.hooks にそのまま渡す（ほかのフックと併せる場合は UserPromptSubmit の配列に足す） */
  hooks: { UserPromptSubmit: { hooks: ((input: unknown) => Promise<UserPromptSubmitOutput>)[]; timeout: number }[] };
  /** options.allowedTools に足す */
  allowedTools: string[];
  /** options.disallowedTools に足す（allowedTools の範囲から、確認なしで実行させない操作を外す） */
  disallowedTools: string[];
};

export declare function souieba(opts?: SouiebaOptions): SouiebaAgentSdk;
