import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { describe, expect, it } from "vitest";
import { HpkeError, generateEncryptionKey, hpkeOpen, hpkeSeal } from "../src/index.ts";

/** 参照実装（@hpke/core）。同じスイートで相互に開けることを確かめる */
const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });

const te = new TextEncoder();
const b64 = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString("base64url");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

async function refKeyPair(kp: { pub: string; priv: string }) {
  const kem = new DhkemX25519HkdfSha256();
  return {
    publicKey: await kem.deserializePublicKey(ab(unb64(kp.pub))),
    privateKey: await kem.deserializePrivateKey(ab(unb64(kp.priv))),
  };
}

describe("HPKE（RFC 9180）", () => {
  const info = "souieba/test-info";
  const aad = "souieba/test-aad";
  const pt = te.encode("あ、そういえば");

  it("自分で封をしたものを開ける", () => {
    const kp = generateEncryptionKey();
    const sealed = hpkeSeal(kp.pub, info, aad, pt);
    expect(hpkeOpen(kp, sealed, info, aad).toString("utf8")).toBe("あ、そういえば");
  });

  it("この実装で封をしたものを、参照実装で開ける", async () => {
    const kp = generateEncryptionKey();
    const sealed = hpkeSeal(kp.pub, info, aad, pt);
    const ref = await refKeyPair(kp);
    const plain = await suite.open(
      { recipientKey: ref.privateKey, enc: ab(unb64(sealed.enc)), info: ab(te.encode(info)) },
      ab(unb64(sealed.ct)),
      ab(te.encode(aad)),
    );
    expect(new TextDecoder().decode(plain)).toBe("あ、そういえば");
  });

  it("参照実装で封をしたものを、この実装で開ける", async () => {
    const kp = generateEncryptionKey();
    const ref = await refKeyPair(kp);
    const sender = await suite.createSenderContext({ recipientPublicKey: ref.publicKey, info: ab(te.encode(info)) });
    const ct = await sender.seal(ab(pt), ab(te.encode(aad)));
    const opened = hpkeOpen(kp, { enc: b64(sender.enc), ct: b64(ct) }, info, aad);
    expect(opened.toString("utf8")).toBe("あ、そういえば");
  });

  it("info・aad・鍵が違えば開けない", () => {
    const kp = generateEncryptionKey();
    const other = generateEncryptionKey();
    const sealed = hpkeSeal(kp.pub, info, aad, pt);
    expect(() => hpkeOpen(kp, sealed, "other", aad)).toThrow(HpkeError);
    expect(() => hpkeOpen(kp, sealed, info, "other")).toThrow(HpkeError);
    expect(() => hpkeOpen(other, sealed, info, aad)).toThrow(HpkeError);
  });

  it("暗号文を1ビットでも変えると開けない", () => {
    const kp = generateEncryptionKey();
    const sealed = hpkeSeal(kp.pub, info, aad, pt);
    const ct = Buffer.from(sealed.ct, "base64url");
    ct[0]! ^= 1;
    expect(() => hpkeOpen(kp, { ...sealed, ct: ct.toString("base64url") }, info, aad)).toThrow(HpkeError);
  });

  it("すべて 0 の公開鍵（小さい位数の点）を断る", () => {
    expect(() => hpkeSeal(Buffer.alloc(32).toString("base64url"), info, aad, pt)).toThrow();
  });
});
