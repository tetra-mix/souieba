// souieba/agent-sdk の型（実装は src/integrations/agent-sdk.ts）。
// @anthropic-ai/claude-agent-sdk の query() の options にそのまま渡せる形にしている。

export type SouiebaOptions = {
  /** 同じ PC で複数のエージェントが Souieba を使うときの、このエージェントの名前（SOUIEBA_AGENT） */
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
};

export declare function souieba(opts?: SouiebaOptions): SouiebaAgentSdk;
