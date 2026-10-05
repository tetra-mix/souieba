import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type KeyDirectory, type Pins, type TrustResult, emptyPins, evaluateTrust } from "@souieba/core";
import { souiebaHome, writeSecretJson } from "./config.ts";

/**
 * 信頼の記録（~/.souieba/known_keys.json）。最初に見た Identity 鍵と、検証済みのグループのメンバーを残す。
 * 同じ PC の Agent どうしで共有する。
 */
export class Keyring {
  constructor(readonly path = join(souiebaHome(), "known_keys.json")) {}

  load(): Pins {
    if (!existsSync(this.path)) return emptyPins();
    const p = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Pins>;
    return { identities: p.identities ?? {}, members: p.members ?? {} };
  }

  save(pins: Pins): void {
    writeSecretJson(this.path, pins);
  }

  /** ディレクトリを検証し、新しく信頼したものを記録する */
  evaluate(dir: KeyDirectory, selfIdentityKey: string): TrustResult {
    const result = evaluateTrust(dir, this.load(), selfIdentityKey);
    // 検証の途中で別のプロセスが書いた記録を消さないよう、読み直してから足し合わせる
    const latest = this.load();
    for (const [u, k] of Object.entries(result.pins.identities)) latest.identities[u] ??= k;
    for (const [g, ms] of Object.entries(result.pins.members)) latest.members[g] = [...new Set([...(latest.members[g] ?? []), ...ms])];
    this.save(latest);
    return result;
  }

  /** 招待者の指紋をサーバの外で確認できたときに、その鍵を記録する */
  pinIdentity(userId: string, identityKey: string): void {
    const pins = this.load();
    pins.identities[userId] = identityKey;
    this.save(pins);
  }

  /** 記録した鍵を忘れる（相手が鍵を作り直したことを、サーバの外で確認できたとき） */
  forgetIdentity(userId: string): void {
    const pins = this.load();
    delete pins.identities[userId];
    for (const g of Object.keys(pins.members)) pins.members[g] = pins.members[g]!.filter((u) => u !== userId);
    this.save(pins);
  }
}
