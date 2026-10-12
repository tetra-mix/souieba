import { chmodSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadClientConfig, saveClientConfig } from "../src/config.ts";

const mode = (p: string) => statSync(p).mode & 0o777;

describe.skipIf(process.platform === "win32")("設定ファイルの権限", () => {
  let home: string;
  const prev = process.env.SOUIEBA_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "souieba-config-"));
    process.env.SOUIEBA_HOME = home;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.SOUIEBA_HOME;
    else process.env.SOUIEBA_HOME = prev;
  });

  it("保存すると、既にある ~/.souieba も 700、config.json は 600 にし、一時ファイルを残さない", () => {
    chmodSync(home, 0o755);
    saveClientConfig({ serverUrl: "https://example.test", agents: {} });
    expect(mode(home)).toBe(0o700);
    expect(mode(configPath())).toBe(0o600);
    expect(readdirSync(home)).toEqual(["config.json"]);
  });

  it("読むときに、他人が読める config.json を 600 に直す", () => {
    saveClientConfig({ serverUrl: "https://example.test", agents: {} });
    chmodSync(configPath(), 0o644);
    expect(loadClientConfig().serverUrl).toBe("https://example.test");
    expect(mode(configPath())).toBe(0o600);
  });
});
