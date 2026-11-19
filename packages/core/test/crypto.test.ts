import { describe, expect, it } from "vitest";
import { generateEncryptionKey, generateSigningKey, isPublicKey, sha256Hex, signText, verifyText } from "../src/index.ts";

describe("署名と鍵", () => {
  it("署名した本人の公開鍵でだけ検証でき、本文を書き換えると通らない", () => {
    const alice = generateSigningKey();
    const bob = generateSigningKey();
    const sig = signText(alice, "souieba");
    expect(verifyText(alice.pub, "souieba", sig)).toBe(true);
    expect(verifyText(alice.pub, "souieba!", sig)).toBe(false);
    expect(verifyText(bob.pub, "souieba", sig)).toBe(false);
    expect(verifyText(alice.pub, "souieba", "not-a-signature")).toBe(false);
  });

  it("公開鍵の形式を種類ごとに確かめる", () => {
    const sign = generateSigningKey();
    const enc = generateEncryptionKey();
    expect(isPublicKey("ed25519", sign.pub)).toBe(true);
    expect(isPublicKey("x25519", enc.pub)).toBe(true);
    expect(isPublicKey("ed25519", "short")).toBe(false);
    expect(isPublicKey("ed25519", 42)).toBe(false);
  });

  it("sha256Hex は 64 桁の 16 進数", () => {
    expect(sha256Hex("souieba")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});
