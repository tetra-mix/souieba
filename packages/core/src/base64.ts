/** 鍵・署名・暗号文の文字列表現（base64url）。core の中でだけ使う（index.ts からは出さない） */
export const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
export const unb64 = (s: string): Buffer => Buffer.from(s, "base64url");
