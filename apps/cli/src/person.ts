/**
 * souieba init: v2 の Person と、Relay に接続する内部転送端末を初期化する。
 *
 * 内部端末の名前は手元だけのもので、Relay にも友人にも送らない。
 */
import { join } from "node:path";
import {
  type DeviceIdentity,
  type PersonKeys,
  certifyDevice,
  generateDevice,
  generatePerson,
  isValidDisplayName,
} from "@souieba/core";
import {
  type ClientConfig,
  type DeviceEntry,
  RelayHttp,
  deviceDir,
  loadClientConfig,
  saveClientConfig,
} from "@souieba/sdk";
import { CLI_VERSION } from "./version.ts";

export type PersonIo = { log: (line: string) => void; now: () => Date };

/** セッショントークンを平文で流さないよう、http は手元で動かす開発用（localhost / 127.0.0.1）だけにする */
function relayOrigin(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && (host === "localhost" || host === "127.0.0.1" || host === "::1"))) {
    throw new Error("Relay の URL は https にしてください（http は手元で動かす開発用の localhost / 127.0.0.1 だけ）");
  }
  return parsed.origin;
}
function requireDeviceName(cfg: ClientConfig, name: string): string {
  const n = name.trim();
  if (!isValidDisplayName(n)) throw new Error("端末の名前は1〜40文字で、日本語・英数字・一部の記号だけにしてください");
  if (n in (cfg.person?.devices ?? {})) throw new Error(`内部端末「${n}」はすでにあります。別の名前にしてください`);
  return n;
}

function newDevice(person: PersonKeys, now: Date): DeviceIdentity & { entry: DeviceEntry } {
  const d = generateDevice(person.personId, now.toISOString());
  const cert = certifyDevice(person, d);
  return { ...d, cert, entry: { deviceId: d.deviceId, sign: d.sign, enc: d.enc, encKeyVersion: d.encKeyVersion, createdAt: d.createdAt, cert } };
}

/** souieba init <Relay の URL> [--name <内部名>] */
export async function initCommand(a: { url?: string; name?: string }, io: PersonIo): Promise<void> {
  const cfg = loadClientConfig();
  if (cfg.person) {
    throw new Error(`v2 のPerson ID（${cfg.person.personId}）はもうあります。別のPersonを作るときは SOUIEBA_HOME を変えてください`);
  }
  const url = a.url;
  if (!url) throw new Error("souieba init <Relay の URL> [--name <内部名>]");
  const relayUrl = relayOrigin(url);
  const name = requireDeviceName(cfg, a.name ?? "relay");
  const now = io.now();
  const person = generatePerson();
  const dev = newDevice(person, now);
  const http = new RelayHttp({ relayUrl, device: dev, sessionPath: join(deviceDir(dev.deviceId), "relay-session.json"), clientVersion: CLI_VERSION, now: io.now });
  await http.register(person.person.pub);
  // 登録した鍵でセッションを得られるか（Relay の URL が正しいか）を確かめる
  await http.connections();

  cfg.person = {
    relayUrl,
    personId: person.personId,
    person: person.person,
    createdAt: now.toISOString(),
    devices: { [name]: dev.entry },
  };
  saveClientConfig(cfg);
  io.log(`v2 の ID を作り、${relayUrl} に登録しました。`);
  io.log(`ID: ${person.personId}（このPCの同じPersonを使うクライアントで共通です。友人にはこのIDを伝えます）`);
  io.log(`内部転送端末: ${name}（通常の操作では指定不要です）`);
  io.log("次に:");
  io.log("  1. 友人と ID を伝え合い、souieba relay connect <相手の ID> --name <呼び名> で接続を要求する（相手が承認すると接続）");
  io.log("  2. 共有してよい相手を決める: souieba relay allow <呼び名>（既定はすべて禁止）");
  io.log("  3. 別のPersonを作るなら、SOUIEBA_HOMEを変えて souieba init を実行します");
  io.log("souieba relay ui で、これらを画面で見ながら設定することもできます。");
}
