import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DeviceCert, DeviceIdentity, KeyPair } from "@souieba/core";

export type AgentKeys = { enc: KeyPair; sign: KeyPair };

export type AgentEntry = { id: string; token: string; keys?: AgentKeys };

/**
 * ~/.souieba/config.json。SDK・CLI が共通で読む。
 * トークンに加えて Agent の秘密鍵も入るので、権限は必ず 600 にする。
 */
export type ClientConfig = {
  serverUrl?: string;
  userToken?: string;
  user?: { id: string; handle: string; displayName: string };
  agents: Record<string, AgentEntry>;
  /**
   * 2.0.0 の v2（Relay）の Agent（Agent ごとの ID）。2.1.0 では使わない（souieba init --from <名前> で、人ごとの ID に移す）。
   * 自動では消さない
   */
  relayAgents?: Record<string, RelayAgentEntry>;
  /** 2.1.0 からの v2: この PC の主人（人ごとの ID）と、その端末（エージェント）。docs/v2-design.md */
  person?: PersonEntry;
};

/**
 * 人。Person 鍵の秘密鍵は、その人の最初の PC にだけある（ほかの PC の端末を足す device link は今後。そのときは priv のない形になる）
 */
export type PersonEntry = {
  relayUrl: string;
  personId: string;
  person: { pub: string; priv?: string };
  createdAt: string;
  /** 端末。キーは手元だけの名前（「Claude Code」など。友人には見せない）。--agent・SOUIEBA_AGENT で選ぶ */
  devices: Record<string, DeviceEntry>;
  /** 2.0.0 の Agent から移したとき、その名前 */
  migratedFrom?: string;
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

export type RelayAgentEntry = {
  relayUrl: string;
  agentId: string;
  identity: KeyPair;
  enc: KeyPair;
  encKeyVersion: number;
  createdAt: string;
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
 * 使う Agent を決める。優先順: 引数（--agent）> 環境変数 SOUIEBA_AGENT > 登録が1つだけならそれ。
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

/** v2 の端末（エージェント）として選ばれたもの */
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

/** v1 の Agent・v2 の端末・2.0.0 の v2 Agent の名前は重ねない。agent を決めるときに、どれの名前かを見分けるため */
export function agentNameTaken(cfg: ClientConfig, name: string): boolean {
  return name in cfg.agents || name in (cfg.relayAgents ?? {}) || name in (cfg.person?.devices ?? {});
}

/** 使っている（取り消していない）端末の名前 */
export function activeDeviceNames(cfg: ClientConfig): string[] {
  return Object.entries(cfg.person?.devices ?? {})
    .filter(([, d]) => !d.revokedAt)
    .map(([n]) => n);
}

/** 2.0.0 の v2 Agent を選んだとき（2.1.0 では使えない。移行を案内する） */
export class LegacyRelayAgentError extends Error {}

/**
 * Person の Relay を使う内部端末を返す。v1 の Agent なら null。
 * Person が選ばれているときは、v1 Agent が同じ設定に残っていても、v2 側を既定にする。
 * --agent / SOUIEBA_AGENT は、旧設定や複数の内部端末との互換用にだけ使う。
 */
export function resolveRelayAgent(name?: string): ResolvedRelayAgent | null {
  const requested = name ?? (process.env.SOUIEBA_AGENT || undefined);
  const cfg = loadClientConfig();
  const p = cfg.person;
  const active = activeDeviceNames(cfg);
  // Person がある場合は、同じ ~/.souieba に v1 Agent が残っていても v2 を優先する。
  // 内部端末が複数ある旧設定では、明示指定がなければ先頭の有効な端末を使う。
  const key = requested === undefined ? active[0] : p?.devices[requested] ? requested : undefined;
  if (requested !== undefined && !key) {
    if (cfg.agents[requested]) return null;
    if (cfg.relayAgents?.[requested]) {
      throw new LegacyRelayAgentError(
        `「${requested}」は souieba 2.0.0 の v2 Agent です。2.1.0 から ID は人ごとになりました。souieba init --from ${JSON.stringify(requested)} で移してください（古いファイルは消しません）`,
      );
    }
    return null;
  }
  if (!key) return null;
  const d = p?.devices[key];
  if (!p || !d) {
    if (cfg.relayAgents?.[key]) {
      throw new LegacyRelayAgentError(
        `「${key}」は souieba 2.0.0 の v2 Agent です。2.1.0 から ID は人ごとになりました。souieba init --from ${JSON.stringify(key)} で移してください（古いファイルは消しません）`,
      );
    }
    return null;
  }
  if (d.revokedAt) throw new Error(`端末「${key}」は取り消してあります（souieba device list で確かめられます）`);
  return {
    name: key,
    relayUrl: process.env.SOUIEBA_RELAY_URL ?? p.relayUrl,
    personId: p.personId,
    personKey: p.person.pub,
    device: { personId: p.personId, deviceId: d.deviceId, sign: d.sign, enc: d.enc, encKeyVersion: d.encKeyVersion, createdAt: d.createdAt, cert: d.cert },
  };
}
