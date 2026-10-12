/**
 * 投稿に秘密情報や個人情報が含まれていないかを調べる。
 * 本文は E2EE でサーバからは見えないので、クライアント（メモと投稿の送信前）で使う。
 */
export type Finding = { rule: string; match: string };

type Rule = { rule: string; pattern: RegExp; check?: (match: string) => boolean };

/** マイナンバー（個人番号）の検査用数字が合うか。12桁の数字すべてを拾うと誤検知が多いため */
function isMyNumber(match: string): boolean {
  const d = match.replace(/\D/g, "");
  if (d.length !== 12) return false;
  let sum = 0;
  for (let n = 1; n <= 11; n++) sum += Number(d[11 - n]) * (n <= 6 ? n + 1 : n - 5);
  const r = sum % 11;
  return Number(d[11]) === (r <= 1 ? 0 : 11 - r);
}

const RULES: Rule[] = [
  { rule: "souieba_token", pattern: /sou_[uam]_[A-Za-z0-9_-]{16,}/g },
  { rule: "anthropic_key", pattern: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { rule: "openai_key", pattern: /sk-(?:proj-)?[A-Za-z0-9]{20,}/g },
  { rule: "stripe_key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { rule: "gitlab_token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { rule: "github_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { rule: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: "slack_token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { rule: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { rule: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { rule: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { rule: "phone_jp", pattern: /(?<!\d)0\d{1,4}-?\d{1,4}-?\d{3,4}(?!\d)/g },
  // 空白区切りは日付などと紛れやすいので、市外局番＋市内局番が6桁（携帯は7桁）になる形に限る
  { rule: "phone_jp", pattern: /(?<!\d)(?:0\d \d{4}|0\d{2} \d{3,4}|0\d{3} \d{2}|0\d{4} \d) \d{4}(?!\d)/g },
  { rule: "credit_card", pattern: /(?<!\d)(?:\d{4}[ -]?){3}\d{4}(?!\d)/g },
  // American Express は15桁（4-6-5）
  { rule: "credit_card", pattern: /(?<!\d)3[47]\d{2}[ -]?\d{6}[ -]?\d{5}(?!\d)/g },
  { rule: "my_number", pattern: /(?<!\d)\d{4}[ -]?\d{4}[ -]?\d{4}(?!\d)/g, check: isMyNumber },
  { rule: "password", pattern: /\b(?:password|passwd|pwd)\s*[:=]\s*["']?[^\s"']+/gi },
  // 「パスワードは変更した」のような文は拾わず、数字か記号を含む英数字の値だけを対象にする
  { rule: "password", pattern: /(?:パスワード|暗証番号)\s*(?:は|[:：=])\s*[「"']?(?=[!-~]*[0-9!-/:-@[-`{-~])[!-~]{4,}/g },
  // postgres://user:pass@db:5432/app のような認証情報入りの URL（TLD のないホストも含む）
  { rule: "url_with_credentials", pattern: /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s:@/]*:[^\s@/]+@[^\s/]+/gi },
  { rule: "url_with_secret", pattern: /https?:\/\/\S*[?&](?:token|key|secret|password|sig|signature|access_token)=\S+/gi },
  { rule: "long_hex", pattern: /\b[0-9a-f]{32,}\b/gi },
  // 大文字・小文字・数字が混在する長い文字列だけを対象にし、ファイルパスなどの誤検知を避ける
  { rule: "long_base64", pattern: /(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])[A-Za-z0-9+/_-]{40,}={0,2}/g },
];

export function scanSecrets(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const { rule, pattern, check } of RULES) {
    for (const m of text.matchAll(pattern)) if (!check || check(m[0])) findings.push({ rule, match: m[0] });
  }
  return findings;
}

/** 検出した部分を伏せ字にする（活動ログの記録時に使う） */
export function maskSecrets(text: string): string {
  let out = text;
  for (const { pattern, check } of RULES) out = out.replace(pattern, (m) => (!check || check(m) ? "[REDACTED]" : m));
  return out;
}
