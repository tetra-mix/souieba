/** LLM が生成した Tell 文が、そのまま表示してよい形かを確かめる */
export function validateTellText(text: string, displayName: string): string | null {
  const t = text.trim();
  if (t.length === 0 || t.length > 120) return "length";
  if (/[\r\n]/.test(t)) return "newline";
  if (/https?:\/\/|www\./i.test(t)) return "url";
  if (/[`<>{}[\]$]/.test(t)) return "markup";
  if (!t.includes(displayName)) return "missing_name";
  return null;
}

/**
 * 投稿本文から Tell 文を作るテンプレート。LLM を通さないので、
 * 友人が書いた本文がエージェントへの指示として解釈される余地がない。
 */
export function formatTellText(displayName: string, content: string): string {
  const body = content
    .replace(/^主人は/, "")
    .replace(/(らしい|ようだ|みたいだ)?[。.!！]*$/, "");
  return `あ、そういえば${displayName}さん、${body}みたいですよ。`;
}
