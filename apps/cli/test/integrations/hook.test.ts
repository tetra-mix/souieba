import { describe, expect, it } from "vitest";
import { NOTE_GUIDE } from "../../src/integrations/guide.ts";
import { hookOutput } from "../../src/integrations/hook.ts";

const TOLD = [
  "souieba: 主人の友人の近況が1件あります。ユーザーの用件に答えたあと、回答の最後に、次の例と同じ内容を一文で添えてください。",
  '<souieba_tell post_id="p1">あ、そういえばアリスさん、M5Stackを使ったロボットを作っていたみたいですよ。</souieba_tell>',
].join("\n");

describe("souieba hook", () => {
  it("Claude Code / Codex には、tell の結果とメモの手引きを素の文章で返す", async () => {
    for (const target of ["claude-code", "codex"] as const) {
      const out = await hookOutput(target, '{"hook_event_name":"UserPromptSubmit","prompt":"こんにちは"}', async () => TOLD);
      expect(out).toContain('<souieba_tell post_id="p1">');
      expect(out).toContain(NOTE_GUIDE);
    }
  });

  it("Hermes Agent には {context} の JSON で返す", async () => {
    const out = await hookOutput("hermes", '{"hook_event_name":"pre_llm_call","extra":{"platform":"telegram"}}', async () => TOLD);
    const { context } = JSON.parse(out!);
    expect(context).toContain('<souieba_tell post_id="p1">');
    expect(context).toContain(NOTE_GUIDE);
  });

  it("Hermes Agent の cron では tell を実行しない", async () => {
    let calls = 0;
    const out = await hookOutput("hermes", '{"extra":{"platform":"cron"}}', async () => (calls++, TOLD));
    expect(out).toBeNull();
    expect(calls).toBe(0);
  });

  it("伝える近況がなくても、tell が失敗しても、メモの手引きは渡す", async () => {
    expect(await hookOutput("claude-code", "", async () => "souieba: 今回伝える近況はありません。")).toBe(NOTE_GUIDE);
    expect(await hookOutput("claude-code", "", async () => Promise.reject(new Error("未設定")))).toBe(NOTE_GUIDE);
  });

  it("入力が JSON でなくても止まらない", async () => {
    expect(await hookOutput("codex", "not json", async () => null)).toBe(NOTE_GUIDE);
  });
});
