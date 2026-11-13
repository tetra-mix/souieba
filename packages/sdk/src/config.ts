import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DeviceCert, DeviceIdentity, KeyPair } from "@souieba/core";

export type AgentKeys = { enc: KeyPair; sign: KeyPair };

export type AgentEntry = { id: string; token: string; keys?: AgentKeys };

/** エージェント連携などのクライアント動作。秘密情報はここに置かない */
export type ClientSettings = {
  /** 会話の区切りとみなす無通信時間（分）。0なら発話ごとに新しいSession */
  sessionGapMinutes?: number;
  /** 同じSessionで次の友人の近況を伝えるまでの間隔（分）。0なら待たない */
  tellIntervalMinutes?: number;
  /** npm の更新確認を行うか。省略時は行う */
  updateCheck?: boolean;
};

/**
 * ~/.souieba/config.json。SDK・CLI が共通で読む。
 * トークンに加えて Agent の秘密鍵も入るので、権限は必ず 600 にする。
 */
export type ClientConfig = {
  serverUrl?: string;
  userToken?: string;
  user?: { id: string; handle: string; displayName: string };
  agents: Record<string, AgentEntry>;
  client?: ClientSettings;
  /** v2 RelayのPersonと、通信に使う内部端末。通常の操作ではPersonだけを意識する */
  person?: PersonEntry;
};

/**
 * 人。現在は1つの設定ディレクトリにPerson鍵と、Relay通信用の内部端末を保存する。
 */
export type PersonEntry = {
  relayUrl: string;
  personId: string;
  person: { pub: string; priv?: string };
  createdAt: string;
  /** 内部転送端末。キーは手元だけの名前で、外部のIDやCLI引数には使わない */
  devices: Record<string, DeviceEntry>;
};

export type DeviceEntry = {
  deviceId: string;
  sign: KeyPair;
  enc: KeyPair;
  encKeyVersion: number;
  createdAt: string;
  cert: DeviceCert;
  /** 取り消した日時（取り消した端末は使わない。記録のために残す） */
  revokedAt?: string;
};

/** SOUIEBA_HOME で切り替えられる（1台の PC で2人分のデモをするときなど） */
export function souiebaHome(): string {
  return process.env.SOUIEBA_HOME ?? join(homedir(), ".souieba");
}

export function configPath(): string {
  return join(souiebaHome(), "config.json");
}

export function loadClientConfig(): ClientConfig {
  const p = configPath();
  if (!existsSync(p)) return { agents: {} };
  // 前のバージョンや手で作ったファイルが他人に読める権限なら、600 に直す
  restrictMode(p, 0o600);
  const cfg = JSON.parse(readFileSync(p, "utf8")) as ClientConfig;
  cfg.agents ??= {};
  return cfg;
}

export type ResolvedClientSettings = {
  sessionGapMs?: number;
  tellIntervalMs?: number;
  updateCheck: boolean;
};

function minutes(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`設定 ${label} は0以上の分数で指定してください`);
  }
  return value;
}

function envMinutes(name: string, fallback: unknown, label: string): number | undefined {
  const value = process.env[name];
  if (value !== undefined && value !== "") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`環境変数 ${name} は0以上の分数で指定してください`);
    return n;
  }
  return minutes(fallback, label);
}

/** config.json のクライアント設定を読み、環境変数があれば一時的な上書きとして適用する */
export function resolveClientSettings(cfg: ClientConfig = loadClientConfig()): ResolvedClientSettings {
  const sessionGapMinutes = envMinutes("SOUIEBA_SESSION_GAP_MIN", cfg.client?.sessionGapMinutes, "client.sessionGapMinutes");
  const tellIntervalMinutes = envMinutes("SOUIEBA_TELL_INTERVAL_MIN", cfg.client?.tellIntervalMinutes, "client.tellIntervalMinutes");
  return {
    sessionGapMs: sessionGapMinutes === undefined ? undefined : sessionGapMinutes * 60_000,
    tellIntervalMs: tellIntervalMinutes === undefined ? undefined : tellIntervalMinutes * 60_000,
    updateCheck: !process.env.SOUIEBA_NO_UPDATE_CHECK && cfg.client?.updateCheck !== false,
  };
}

/**
 * 手元の状態ファイル（Session・既知の Agent やメンバー・グループ名など）を読む。ないか壊れていれば null。
 * 壊れたファイルで tell などが毎回落ちないよう、作り直せるものだけに使う（トークンを持つ config.json には使わない）
 */
export function readStateJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** トークンを含むので所有者だけが読める権限（600）で書く */
export function writeSecretJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // 同時に動く別の souieba と一時ファイルがぶつからないよう、名前を毎回変える
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    // 置き換えたあとに落ちても中身が空にならないよう、ディスクに書いてから rename する
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/**
 * 他人が読める権限なら mode に絞る。mkdirSync の mode は作るときにしか効かないので、既にある ~/.souieba にも使う。
 * Windows では権限の意味が違うので何もしない。失敗しても止めない（doctor が知らせる）
 */
function restrictMode(path: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    if (statSync(path).mode & 0o077) chmodSync(path, mode);
  } catch {
    // 所有者が違うなど。そのまま使う
  }
}

export function saveClientConfig(cfg: ClientConfig): void {
  writeSecretJson(configPath(), cfg);
  restrictMode(souiebaHome(), 0o700);
}

export type ResolvedAgent = {
  serverUrl: string;
  agentId: string;
  token: string;
  name: string;
  keys?: AgentKeys;
  userId?: string;
};

/**
 * v1で使うAgentを決める。優先順: 引数（--agent）> 環境変数 SOUIEBA_AGENT > 登録が1つだけならそれ。
 * 環境変数 SOUIEBA_SERVER があればサーバの URL だけ設定ファイルより優先する。
 * （トークンだけを環境変数で渡す方法はやめた。E2EE には Agent の秘密鍵が必要なため）
 */
export function resolveAgent(name?: string): ResolvedAgent {
  name ??= process.env.SOUIEBA_AGENT || undefined;
  const cfg = loadClientConfig();
  const serverUrl = process.env.SOUIEBA_SERVER ?? cfg.serverUrl;
  if (!serverUrl) throw new Error("サーバが未設定です。`souieba login <URL> --code <コード>` を実行してください");
  const names = Object.keys(cfg.agents);
  const key = name ?? (names.length === 1 ? names[0] : undefined);
  const agent = key ? cfg.agents[key] : undefined;
  if (!key || !agent) {
    throw new Error(
      names.length === 0
        ? "Agent が未登録です。`souieba agent add <名前>` を実行してください"
        : key
          ? `Agent「${key}」は未登録です。登録済み: ${names.join(", ")}`
          : `Agent を指定してください（--agent または環境変数 SOUIEBA_AGENT）。登録済み: ${names.join(", ")}`,
    );
  }
  return {
    serverUrl,
    agentId: agent.id,
    token: agent.token,
    name: key,
    keys: agent.keys,
    userId: cfg.user?.id,
  };
}

/** v2 の内部転送端末として解決された接続情報 */
export type ResolvedRelayAgent = {
  /** 端末の名前（手元だけ） */
  name: string;
  relayUrl: string;
  personId: string;
  personKey: string;
  device: DeviceIdentity;
};

/** 人ごとの状態（連絡先・グループ・プロジェクト・メモ・受信箱）を置くディレクトリ。この PC のすべての端末で共有する */
export function personDir(): string {
  return join(souiebaHome(), "person");
}

/** 内部の転送端末ごとの状態（Relay のセッション・会話の Session）を置くディレクトリ */
export function deviceDir(deviceId: string): string {
  return join(personDir(), "devices", deviceId);
}

/**
 * Person のRelayを使う内部端末を返す。v1のAgent設定しかなければ null。
 * Personがあるときは、そのPersonの最初の有効な内部端末を使う。
 */
export function resolveRelayAgent(): ResolvedRelayAgent | null {
  const cfg = loadClientConfig();
  const p = cfg.person;
  const [key, d] = Object.entries(p?.devices ?? {}).find(([, device]) => !device.revokedAt) ?? [];
  if (!p || !key || !d) return null;
  return {
    name: key,
    relayUrl: process.env.SOUIEBA_RELAY_URL ?? p.relayUrl,
    personId: p.personId,
    personKey: p.person.pub,
    device: { personId: p.personId, deviceId: d.deviceId, sign: d.sign, enc: d.enc, encKeyVersion: d.encKeyVersion, createdAt: d.createdAt, cert: d.cert },
  };
}
