import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** MCP のツールの結果（文章）。isError にすると、エージェントにはツールのエラーとして見える */
export function text(t: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}
