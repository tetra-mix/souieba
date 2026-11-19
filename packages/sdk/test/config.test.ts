import { chmodSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadClientConfig, resolveClientSettings, saveClientConfig } from "../src/config.ts";

const mode = (p: string) => statSync(p).mode & 0o777;

describe.skipIf(process.platform === "win32")("設定ファイルの権限", () => {
  let home: string;
  const prev = process.env.SOUIEBA_HOME;
  const prevGap = process.env.SOUIEBA_SESSION_GAP_MIN;
  const prevTell = process.env.SOUIEBA_TELL_INTERVAL_MIN;
  const prevNoUpdate = process.env.SOUIEBA_NO_UPDATE_CHECK;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "souieba-config-"));
    process.env.SOUIEBA_HOME = home;
    delete process.env.SOUIEBA_SESSION_GAP_MIN;
    delete process.env.SOUIEBA_TELL_INTERVAL_MIN;
    delete process.env.SOUIEBA_NO_UPDATE_CHECK;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.SOUIEBA_HOME;
    else process.env.SOUIEBA_HOME = prev;
    if (prevGap === undefined) delete process.env.SOUIEBA_SESSION_GAP_MIN;
    else process.env.SOUIEBA_SESSION_GAP_MIN = prevGap;
    if (prevTell === undefined) delete process.env.SOUIEBA_TELL_INTERVAL_MIN;
    else process.env.SOUIEBA_TELL_INTERVAL_MIN = prevTell;
    if (prevNoUpdate === undefined) delete process.env.SOUIEBA_NO_UPDATE_CHECK;
    else process.env.SOUIEBA_NO_UPDATE_CHECK = prevNoUpdate;
  });

  it("保存すると、既にある ~/.souieba も 700、config.json は 600 にし、一時ファイルを残さない", () => {
    chmodSync(home, 0o755);
    saveClientConfig({ client: { updateCheck: false } });
    expect(mode(home)).toBe(0o700);
    expect(mode(configPath())).toBe(0o600);
    expect(readdirSync(home)).toEqual(["config.json"]);
  });

  it("読むときに、他人が読める config.json を 600 に直す", () => {
    saveClientConfig({ client: { updateCheck: false } });
    chmodSync(configPath(), 0o644);
    expect(loadClientConfig().client?.updateCheck).toBe(false);
    expect(mode(configPath())).toBe(0o600);
  });

  it("投稿の間隔（post-interval）を読む。既定は1時間で、正しくない値は断る", () => {
    delete process.env.SOUIEBA_POST_INTERVAL_MIN;
    expect(resolveClientSettings({ client: {} }).postIntervalMs).toBe(3_600_000);
    expect(resolveClientSettings({ client: { postIntervalMinutes: 30 } }).postIntervalMs).toBe(1_800_000);
    expect(() => resolveClientSettings({ client: { postIntervalMinutes: 7 } })).toThrow(/1日/);
    process.env.SOUIEBA_POST_INTERVAL_MIN = "120";
    try {
      expect(resolveClientSettings({ client: { postIntervalMinutes: 30 } }).postIntervalMs).toBe(7_200_000);
    } finally {
      delete process.env.SOUIEBA_POST_INTERVAL_MIN;
    }
  });

  it("クライアント設定の間隔を読み、環境変数で一時的に上書きできる", () => {
    saveClientConfig({ client: { sessionGapMinutes: 0, tellIntervalMinutes: 2, updateCheck: false } });
    expect(resolveClientSettings()).toEqual({ sessionGapMs: 0, tellIntervalMs: 120_000, postIntervalMs: 3_600_000, updateCheck: false });

    process.env.SOUIEBA_SESSION_GAP_MIN = "3";
    process.env.SOUIEBA_TELL_INTERVAL_MIN = "0";
    process.env.SOUIEBA_NO_UPDATE_CHECK = "1";
    expect(resolveClientSettings()).toEqual({ sessionGapMs: 180_000, tellIntervalMs: 0, postIntervalMs: 3_600_000, updateCheck: false });
  });
});
