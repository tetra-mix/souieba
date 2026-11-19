import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "apps/cli/src/main.ts");

describe("CLIのv1専用コマンド", () => {
  it.each(["login", "whoami", "profile", "invite", "agent", "posts", "export", "relay"])("%s は受け付けない", (command) => {
    const result = spawnSync(tsx, [cli, command], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("使い方: souieba <command>");
  });

  it("help で、接続・共有のコマンドも含めた使い方を表示できる", () => {
    const result = spawnSync(tsx, [cli, "help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("groups create");
    expect(result.stdout).toContain("connect <Person ID>");
  });

  it("未初期化のPersonにはv1ログインではなくinitを案内する", () => {
    const testHome = mkdtempSync(resolve(tmpdir(), "souieba-no-person-"));
    const result = spawnSync(tsx, [cli, "note", "主人は開発していた"], {
      encoding: "utf8", env: { ...process.env, SOUIEBA_HOME: testHome },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("souieba init");
    expect(result.stderr).not.toContain("souieba login");
  });
});
