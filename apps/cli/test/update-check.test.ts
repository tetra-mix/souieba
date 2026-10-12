import { mkdtempSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { latestVersion, updateToNotify } from "../src/update-check.ts";
import { CLI_VERSION } from "../src/version.ts";

let version = "99.0.0";
let requests = 0;
let server: Server;

beforeAll(async () => {
  server = createServer((_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "souieba", version }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.SOUIEBA_UPDATE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/souieba/latest`;
});
afterAll(() => {
  server.close();
  delete process.env.SOUIEBA_UPDATE_URL;
  process.env.SOUIEBA_NO_UPDATE_CHECK = "1";
});
beforeEach(() => {
  process.env.SOUIEBA_HOME = mkdtempSync(join(tmpdir(), "souieba-update-"));
  delete process.env.SOUIEBA_NO_UPDATE_CHECK;
  version = "99.0.0";
  requests = 0;
});

const day = 24 * 3_600_000;

describe("新しい版の CLI の知らせ", () => {
  it("新しい版があれば1日に1回だけ知らせ、npm への問い合わせも1日に1回にする", async () => {
    const t0 = new Date("2026-10-12T00:00:00Z");
    expect(await updateToNotify(t0)).toBe("99.0.0");
    expect(await updateToNotify(new Date(t0.getTime() + 3_600_000))).toBeNull();
    expect(requests).toBe(1);
    // 1日たてば問い合わせ直し、まだ更新していなければもう一度知らせる
    expect(await updateToNotify(new Date(t0.getTime() + day + 1))).toBe("99.0.0");
    expect(requests).toBe(2);
  });

  it("今の版と同じか古ければ知らせない", async () => {
    version = CLI_VERSION;
    expect(await updateToNotify(new Date())).toBeNull();
    version = "0.0.1";
    expect(await latestVersion(new Date(), { force: true })).toBe("0.0.1");
    expect(await updateToNotify(new Date())).toBeNull();
  });

  it("tell の期限を過ぎていたら、知らせた扱いにしない", async () => {
    const now = new Date("2026-10-12T00:00:00Z");
    expect(await updateToNotify(now, () => false)).toBeNull();
    expect(await updateToNotify(now)).toBe("99.0.0");
  });

  it("SOUIEBA_NO_UPDATE_CHECK があれば問い合わせない", async () => {
    process.env.SOUIEBA_NO_UPDATE_CHECK = "1";
    expect(await updateToNotify(new Date())).toBeNull();
    expect(requests).toBe(0);
  });
});
