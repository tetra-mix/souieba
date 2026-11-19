import { MAX_POST_LENGTH, findInstructionLike, sanitizeContent, scanSecrets } from "@souieba/core";

export class SecretInPostError extends Error {
  constructor(readonly rules: string[]) {
    super(`秘密情報の可能性があるため投稿できません（${rules.join(", ")}）`);
  }
}

/** 読み手のエージェントへの命令に見える投稿。受信側で捨てられるので、送る前に断る */
export class InstructionLikePostError extends Error {
  constructor(readonly rules: string[]) {
    super(`友人のエージェントへの命令に見える表現があるため投稿できません（${rules.join(", ")}）`);
  }
}

export class PostTooLongError extends Error {
  constructor(readonly length: number) {
    super(`投稿が長すぎます（${length}字。${MAX_POST_LENGTH}字まで）`);
  }
}

/** 秘密情報の可能性があれば断る。元の文字列と、正規化したあとの両方を調べる */
export function assertNoSecrets(...raws: (string | undefined)[]): void {
  const rules = new Set<string>();
  for (const raw of raws) {
    if (!raw) continue;
    for (const f of [...scanSecrets(raw), ...scanSecrets(sanitizeContent(raw))]) rules.add(f.rule);
  }
  if (rules.size > 0) throw new SecretInPostError([...rules]);
}

/**
 * 送る前の本文の検査と正規化。
 * サーバ・Relay は本文を見られないので、秘密情報の検査と正規化は送る前にクライアントで行う
 */
export function checkPostContent(raw: string): string {
  const content = sanitizeContent(raw);
  assertNoSecrets(raw);
  if (content.length === 0) throw new Error("本文が空です");
  if (content.length > MAX_POST_LENGTH) throw new PostTooLongError(content.length);
  const suspicious = findInstructionLike(content);
  if (suspicious.length > 0) throw new InstructionLikePostError(suspicious);
  return content;
}
