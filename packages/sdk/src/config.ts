import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { KeyPair, RelayIdentity } from "@souieba/core";

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
  /** v2（Relay）の Agent。アカウントもトークンもなく、Identity 鍵と Encryption 鍵だけを持つ（docs/v2-relay-plan.md） */
  relayAgents?: Record<string, RelayAgentEntry>;
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

export type ResolvedRelayAgent = { name: string; relayUrl: string; identity: RelayIdentity };

/** v2 の Agent と v1 の Agent の名前は重ねない。agent を決めるときに、どちらの名前かを見分けるため */
export function agentNameTaken(cfg: ClientConfig, name: string): boolean {
  return name in cfg.agents || name in (cfg.relayAgents ?? {});
}

/**
 * 使う Agent が v2（Relay）のものなら、その Agent を返す。v1 の Agent なら null。
 * 決め方は resolveAgent と同じ（引数 > SOUIEBA_AGENT > 登録が1つだけならそれ）。v1 と v2 を合わせて1つだけのときも、それを使う
 */
export function resolveRelayAgent(name?: string): ResolvedRelayAgent | null {
  name ??= process.env.SOUIEBA_AGENT || undefined;
  const cfg = loadClientConfig();
  const relay = cfg.relayAgents ?? {};
  const relayNames = Object.keys(relay);
  const total = relayNames.length + Object.keys(cfg.agents).length;
  const key = name ?? (relayNames.length === 1 && total === 1 ? relayNames[0] : undefined);
  const e = key ? relay[key] : undefined;
  if (!key || !e) return null;
  return {
    name: key,
    relayUrl: process.env.SOUIEBA_RELAY_URL ?? e.relayUrl,
    identity: { agentId: e.agentId, identity: e.identity, enc: e.enc, encKeyVersion: e.encKeyVersion },
  };
}
