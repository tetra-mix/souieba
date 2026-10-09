export const MAX_CONTENT_LENGTH = 300;
export const MIN_TELL_CONTENT_LENGTH = 10;
/** 投稿本文の上限。Tell 文（120字の本文＋定型＋表示名）が検証を通る長さに収める */
export const MAX_POST_LENGTH = 120;

/** 正規化のあとに残してよい文字。日本語の文字、英数字、空白、近況に要る程度の句読点だけ */
const DISALLOWED = /[^\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー A-Za-z0-9、。・「」『』()!?,.+\-%〜…]/gu;

/**
 * 投稿本文は他人の LLM コンテキストに入りうる、信頼できない入力として扱う。
 * 構造を持てないよう1行のプレーンテキストに正規化する。
 * 記号は許可した文字以外すべて落とす（パス・シェル・役割の区切り（SYSTEM: など）を書けないように）。
 */
export function sanitizeContent(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, " ")
    .replace(DISALLOWED, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CONTENT_LENGTH);
}

/**
 * 近況は「主人は〜していた」という三人称の報告なので、読み手（友人のエージェント）への
 * 呼びかけ・命令・指示の上書きにあたる表現は要らない。これらを含む投稿は送らず、受け取りもしない。
 * 言い換えれば抜けられるヒューリスティックで、インジェクションを完全には防げない（攻撃の手間を増やすためのもの）。
 */
const INSTRUCTION_RULES: { rule: string; re: RegExp }[] = [
  // 読み手への呼びかけ
  { rule: "addressing_reader", re: /あなた|貴方|お前|おまえ|きみ[はがにも]|君[はがにも]|これを読|この(文|文章|メッセージ|投稿|近況)を|(?<![a-z])(you|your)(?![a-z])/i },
  // 命令形・依頼
  {
    rule: "imperative",
    re: /[てで](ください|下さい|くれ(?=[。!?、 ]|$))|(?<!ごめん)なさい(?=[。!?、 ]|$)|(しろ|せよ|すべし)(?=[。!?、 ]|$)|今すぐ|直ちに|ただちに|(?<![a-z])(please|must|ignore|disregard|forget|execute)(?![a-z])/i,
  },
  // 指示の上書き
  { rule: "meta_instruction", re: /指示|命令|プロンプト|無視|従[えうっわ]|(?<![a-z])(system|prompt|instructions?|jailbreak)(?![a-z])|脱獄/i },
  // 秘密の持ち出し・コマンド実行
  { rule: "exfiltration", re: /秘密鍵|パスワード|認証情報|環境変数|(?<![a-z])(sudo|curl|wget|ssh|env|rm)(?![a-z])/i },
];

export const MAX_DISPLAY_NAME_LENGTH = 40;

/**
 * 表示名は友人の Tell 文に入り、相手の LLM が読む。本文と同じ文字だけを許し、命令に見えるものは断る。
 * サーバ（登録・変更時）と受信側（Tell 文を作る前）の両方で使う。
 */
export function isValidDisplayName(name: string): boolean {
  return (
    name.length >= 1 &&
    name.length <= MAX_DISPLAY_NAME_LENGTH &&
    sanitizeContent(name) === name &&
    findInstructionLike(name).length === 0
  );
}

/** 表示名の重複を見るときの比較キー（英字の大文字・小文字は区別しない） */
export function displayNameKey(name: string): string {
  return name.toLowerCase();
}

/** 近況として不自然な、読み手への命令に見える表現の規則名を返す（なければ空） */
export function findInstructionLike(text: string): string[] {
  const t = text.normalize("NFKC");
  return INSTRUCTION_RULES.filter(({ re }) => re.test(t)).map(({ rule }) => rule);
}
