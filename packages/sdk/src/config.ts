import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** ~/.souieba/config.json。SDK・CLI・フック・MCP が共通で読む */
export type ClientConfig = {
  serverUrl?: string;
  userToken?: string;
  user?: { id: string; handle: string; displayName: string };
  agents: Record<string, { id: string; token: string }>;
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
  const cfg = JSON.parse(readFileSync(p, "utf8")) as ClientConfig;
  cfg.agents ??= {};
  return cfg;
}

/** トークンを含むので所有者だけが読める権限（600）で書く */
export function writeSecretJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function saveClientConfig(cfg: ClientConfig): void {
  writeSecretJson(configPath(), cfg);
}

/**
 * 使う Agent を決める。優先順: 引数（--agent）> 環境変数 SOUIEBA_AGENT > 登録が1つだけならそれ。
 * 環境変数 SOUIEBA_SERVER / SOUIEBA_AGENT_TOKEN があれば設定ファイルより優先する。
 */
export function resolveAgent(name?: string): { serverUrl: string; agentId: string | null; token: string; name: string } {
  name ??= process.env.SOUIEBA_AGENT || undefined;
  const cfg = loadClientConfig();
  const serverUrl = process.env.SOUIEBA_SERVER ?? cfg.serverUrl;
  if (!serverUrl) throw new Error("サーバが未設定です。`souieba login <URL> --code <コード>` を実行してください");
  if (process.env.SOUIEBA_AGENT_TOKEN) {
    return { serverUrl, agentId: null, token: process.env.SOUIEBA_AGENT_TOKEN, name: name ?? "env" };
  }
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
  return { serverUrl, agentId: agent.id, token: agent.token, name: key };
}
