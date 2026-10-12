/**
 * プラグインや組み込み（OpenClaw、Agent SDK）から souieba tell を実行する。
 * バンドル後は dist/ の隣に CLI 本体（dist/souieba.mjs）がある。PATH の souieba とバージョンがずれないよう、こちらを使う。
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

/** souieba tell を実行して標準出力を返す。失敗したら null（主人の会話を止めない） */
export type RunTell = (env: NodeJS.ProcessEnv) => Promise<string | null>;

export const TELL_TIMEOUT_MS = 10_000;

export const runBundledTell: RunTell = (env) =>
  new Promise((resolve) => {
    const cli = fileURLToPath(new URL("./souieba.mjs", import.meta.url));
    execFile(process.execPath, [cli, "tell"], { env, timeout: TELL_TIMEOUT_MS }, (err, stdout) => resolve(err ? null : stdout));
  });
