import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePeriod } from "../src/agent/context.ts";

const root = resolve(import.meta.dirname, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "apps/cli/src/main.ts");

function souieba(home: string, ...args: string[]) {
  const r = spawnSync(tsx, [cli, ...args], { encoding: "utf8", env: { ...process.env, SOUIEBA_HOME: home, SOUIEBA_NO_UPDATE_CHECK: "1" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("投稿の間隔（post-interval）", () => {
  it("souieba config で設定・確認・既定に戻せる", () => {
    const home = mkdtempSync(resolve(tmpdir(), "souieba-post-interval-"));
    expect(souieba(home, "config", "set", "post-interval", "30").code).toBe(0);
    expect(JSON.parse(souieba(home, "config", "show").out)).toEqual({ client: { postIntervalMinutes: 30 } });
    expect(souieba(home, "config", "unset", "post-interval").code).toBe(0);
    expect(JSON.parse(souieba(home, "config", "show").out)).toEqual({ client: {} });
  });

  it("5分以上24時間以下で、1日を割り切る分数だけ受け付ける", () => {
    const home = mkdtempSync(resolve(tmpdir(), "souieba-post-interval-"));
    for (const bad of ["7", "3", "2880", "abc", "-30"]) {
      const r = souieba(home, "config", "set", "post-interval", bad);
      expect(r.code, bad).toBe(1);
    }
    expect(souieba(home, "config", "set", "post-interval", "7").err).toContain("1日");
    expect(JSON.parse(souieba(home, "config", "show").out)).toEqual({ client: {} });
  });

  it("時間帯の開始時刻から、設定の長さの時間帯を作る", () => {
    expect(parsePeriod("2026-10-05T13:00:00Z", 3_600_000)).toEqual({ periodStart: "2026-10-05T13:00:00.000Z", periodEnd: "2026-10-05T14:00:00.000Z" });
    expect(parsePeriod("2026-10-05T13:00:00Z", 30 * 60_000)).toEqual({ periodStart: "2026-10-05T13:00:00.000Z", periodEnd: "2026-10-05T13:30:00.000Z" });
  });
});
