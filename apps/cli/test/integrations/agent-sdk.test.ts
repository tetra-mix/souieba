import { describe, expect, it } from "vitest";
import { souieba } from "../../src/integrations/agent-sdk.ts";
import { NOTE_GUIDE } from "../../src/integrations/guide.ts";
import type { RunTell } from "../../src/integrations/run-tell.ts";

const TOLD = [
  "souieba: 主人の友人の近況が1件あります。ユーザーの用件に答えたあと、回答の最後に、次の例と同じ内容を一文で添えてください。",
  '<souieba_tell post_id="p1">あ、そういえばアリスさん、M5Stackを使ったロボットを作っていたみたいですよ。</souieba_tell>',
].join("\n");

/** Agent SDK が UserPromptSubmit で呼ぶのと同じように、登録されたフックを呼ぶ */
async function submit(runTell: RunTell, opts = {}) {
  const [matcher] = souieba(opts, runTell).hooks.UserPromptSubmit;
  return matcher!.hooks[0]!({ hook_event_name: "UserPromptSubmit", prompt: "こんにちは" });
}

describe("Agent SDK への組み込み", () => {
  it("メモの手引きをシステムプロンプトに入れ、確かめずに書いてよいと伝える", () => {
    const s = souieba({}, async () => null);
    expect(s.systemPrompt).toContain(NOTE_GUIDE);
    expect(s.systemPrompt).toContain("確かめる必要はありません");
    expect(s.allowedTools).toEqual(["Bash(souieba note *)"]);
  });

  it("主人の発言ごとに tell を実行し、結果を additionalContext で渡す", async () => {
    let calls = 0;
    const r = await submit(async () => (calls++, `${TOLD}\n`));
    expect(calls).toBe(1);
    expect(r.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
    expect(r.hookSpecificOutput?.additionalContext).toContain('<souieba_tell post_id="p1">');
  });

  it("伝える近況がないときや tell が失敗したときは、何も足さない", async () => {
    expect(await submit(async () => "souieba: 今回伝える近況はありません。\n")).toEqual({});
    expect(await submit(async () => null)).toEqual({});
    expect(await submit(async () => Promise.reject(new Error("boom")))).toEqual({});
  });

  it("agent を指定すると SOUIEBA_AGENT を渡す", async () => {
    let env: NodeJS.ProcessEnv | undefined;
    await submit(async (e) => ((env = e), null), { agent: "My Agent" });
    expect(env?.SOUIEBA_AGENT).toBe("My Agent");
  });
});
