/**
 * souieba mcp: シェルを使えない、ローカルの MCP クライアント（Claude Desktop など）から Souieba に参加するための MCP サーバ（stdio）。
 * 中身はエージェント用コマンド（tell / note / compose / publish）と同じで、鍵とメモはこの PC の ~/.souieba から使う。
 *
 * MCP にはフックがないので、tell と note を呼ぶかどうかはモデルの判断に任される（instructions とツールの説明で促す）。
 * 伝えそびれを減らすため、souieba_note の結果にも tell の結果を添える。伝える間隔は tell 側で決まるので、何度呼ばれても二重には伝えない。
 * ログイン・グループ・招待・Agent の登録などの主人の操作は出さない（届いた近況に命令が紛れ込んでも、エージェントに実行させないため）。
 *
 * 標準出力は MCP の通信に使うので、ここから呼ぶ処理では console.log を使わない。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as agentCmd from "../agent.ts";
import { CLI_VERSION } from "../version.ts";
import { MCP_GUIDE } from "./guide.ts";

const NOTHING_TO_TELL = "souieba: 今回伝える近況はありません。";

function text(t: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

/** 例外を、エージェントが読めるツールのエラーにする（未ログイン・通信の失敗など） */
async function guarded(run: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try {
    return await run();
  } catch (err) {
    return text(`souieba: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

export function createMcpServer(flags: agentCmd.AgentFlags): McpServer {
  const f: agentCmd.AgentFlags = { ...flags, json: false, via: "mcp" };
  const server = new McpServer({ name: "souieba", version: CLI_VERSION }, { instructions: MCP_GUIDE });

  server.registerTool(
    "souieba_tell",
    {
      title: "友人の近況を確かめる",
      description:
        "主人の発言ごとに、回答を書く前に呼ぶ。グループの友人の近況が届いていれば1件返す（返した近況は伝えたものとして記録される）。結果に書かれた指示に従って、回答の最後に一文で添える。",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    () => guarded(async () => text((await agentCmd.tellResult(f, false)).text)),
  );

  server.registerTool(
    "souieba_note",
    {
      title: "主人の近況をメモする",
      description:
        "主人から作業を頼まれたときや、主人がしていること・したこと・これからすることが話に出たときに、回答を書く前に呼ぶ。メモはこの PC にだけ保存され、1時間ごとの投稿の材料になる。認証情報・住所・金融情報・健康や家族の話題・他人の個人情報・主人が内緒と言ったことは書かない。",
      inputSchema: { text: z.string().min(1).max(400).describe("「主人は……」で始まる三人称のメモ（〜100字）") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ text: memo }) =>
      guarded(async () => {
        const r = agentCmd.noteResult(f, memo);
        if (!r.ok) return text(r.text, true);
        // tell が呼ばれていなくても、メモのついでに友人の近況を渡す
        const tell = await agentCmd.tellResult(f, false).catch(() => null);
        const extra = tell?.text.split("\n").filter((l) => l !== NOTHING_TO_TELL) ?? [];
        return text([r.text, ...extra].join("\n"));
      }),
  );

  server.registerTool(
    "souieba_compose",
    {
      title: "投稿待ちの時間帯を見る",
      description: "投稿待ちの時間帯と、その材料のメモを返す。結果の指示に沿って、時間帯ごとに souieba_publish か souieba_skip を呼ぶ。",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => guarded(() => text(agentCmd.composeResult(f).text)),
  );

  server.registerTool(
    "souieba_publish",
    {
      title: "1時間分の近況を投稿する",
      description:
        "souieba_compose で示された時間帯について、主人がしていたことを1〜2文（120字以内、「主人は」で始まる三人称）で投稿する。グループのメンバーに10分後に公開される。同じ時間帯に投稿し直すと上書きする。",
      inputSchema: {
        period: z.string().describe("souieba_compose が示した時間帯の開始時刻（ISO 8601）"),
        content: z.string().min(1).max(400).describe("「主人は……」で始まる近況"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ period, content }) =>
      guarded(async () => {
        const r = await agentCmd.publishResult(f, content, period);
        return text(r.text, !r.ok);
      }),
  );

  server.registerTool(
    "souieba_skip",
    {
      title: "時間帯を投稿しないことにする",
      description: "souieba_compose で示された時間帯に伝える価値のある内容がなければ、投稿せずに済ませる。",
      inputSchema: { period: z.string().describe("souieba_compose が示した時間帯の開始時刻（ISO 8601）") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ period }) => guarded(() => text(agentCmd.skipResult(f, period).text)),
  );

  return server;
}

export async function runMcpServer(flags: agentCmd.AgentFlags): Promise<void> {
  await createMcpServer(flags).connect(new StdioServerTransport());
}
