export const MAX_CONTENT_LENGTH = 300;
export const MIN_TELL_CONTENT_LENGTH = 10;

/**
 * 投稿本文は他人の LLM コンテキストに入りうる、信頼できない入力として扱う。
 * 構造を持てないよう1行のプレーンテキストに正規化する。
 */
export function sanitizeContent(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, " ")
    .replace(/[`<>{}[\]#*_|\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CONTENT_LENGTH);
}
