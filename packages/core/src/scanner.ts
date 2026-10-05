/**
 * 投稿に秘密情報や個人情報が含まれていないかを調べる。
 * クライアント（publisher）とサーバの両方で同じ規則を使う。
 */
export type Finding = { rule: string; match: string };

const RULES: { rule: string; pattern: RegExp }[] = [
  { rule: "souieba_token", pattern: /sou_[ua]_[A-Za-z0-9_-]{16,}/g },
  { rule: "anthropic_key", pattern: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { rule: "openai_key", pattern: /sk-(?:proj-)?[A-Za-z0-9]{20,}/g },
  { rule: "github_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { rule: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: "slack_token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { rule: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { rule: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { rule: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { rule: "phone_jp", pattern: /(?<!\d)0\d{1,4}-?\d{1,4}-?\d{3,4}(?!\d)/g },
  { rule: "credit_card", pattern: /(?<!\d)(?:\d{4}[ -]?){3}\d{4}(?!\d)/g },
  { rule: "url_with_secret", pattern: /https?:\/\/\S*[?&](?:token|key|secret|password|sig|signature|access_token)=\S+/gi },
  { rule: "long_hex", pattern: /\b[0-9a-f]{32,}\b/gi },
  // 大文字・小文字・数字が混在する長い文字列だけを対象にし、ファイルパスなどの誤検知を避ける
  { rule: "long_base64", pattern: /(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])[A-Za-z0-9+/_-]{40,}={0,2}/g },
];

export function scanSecrets(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const { rule, pattern } of RULES) {
    for (const m of text.matchAll(pattern)) findings.push({ rule, match: m[0] });
  }
  return findings;
}

/** 検出した部分を伏せ字にする（活動ログの記録時に使う） */
export function maskSecrets(text: string): string {
  let out = text;
  for (const { pattern } of RULES) out = out.replace(pattern, "[REDACTED]");
  return out;
}
