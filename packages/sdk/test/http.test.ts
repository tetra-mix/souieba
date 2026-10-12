import { describe, expect, it } from "vitest";
import { HttpClient, SouiebaApiError } from "../src/http.ts";

/** 決まった応答を返す fetch。呼ばれた引数も覚えておく */
function stub(res: (init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return res(init);
  }) as unknown as typeof fetch;
  return { client: new HttpClient({ baseUrl: "https://example.test/", token: "tok", clientVersion: "1.0.0", fetch: fetchImpl }), calls };
}

const caught = (p: Promise<unknown>) => p.then(() => null, (err: unknown) => err);

describe("HttpClient", () => {
  it("2xx の JSON を返し、トークンを送る", async () => {
    const { client, calls } = stub(() => Response.json({ ok: true }));
    expect(await client.request("POST", "/v1/x", { a: 1 })).toEqual({ ok: true });
    expect(calls[0]!.url).toBe("https://example.test/v1/x");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("204 は undefined を返す", async () => {
    const { client } = stub(() => new Response(null, { status: 204 }));
    expect(await client.request("POST", "/v1/x")).toBeUndefined();
  });

  it("2xx 以外は、サーバのエラーコードとメッセージで SouiebaApiError にする", async () => {
    const { client } = stub(() => Response.json({ error: { code: "client_outdated", message: "古い" } }, { status: 426 }));
    const err = await caught(client.request("GET", "/v1/x"));
    expect(err).toBeInstanceOf(SouiebaApiError);
    expect(err).toMatchObject({ status: 426, code: "client_outdated", message: "古い" });
  });

  it("2xx 以外で本文が JSON でなければ、http_error にする", async () => {
    const { client } = stub(() => new Response("<html>Bad Gateway</html>", { status: 502 }));
    expect(await caught(client.request("GET", "/v1/x"))).toMatchObject({ status: 502, code: "http_error", message: "HTTP 502" });
  });

  it("2xx なのに JSON でなければ、bad_response で断る", async () => {
    for (const body of ["<html>maintenance</html>", ""]) {
      const { client } = stub(() => new Response(body, { status: 200 }));
      const err = await caught(client.request("GET", "/v1/x"));
      expect(err).toBeInstanceOf(SouiebaApiError);
      expect(err).toMatchObject({ status: 200, code: "bad_response" });
    }
  });

  it("応答がなければ、タイムアウトで中断する", async () => {
    // 渡された signal が中断されるまで応答しない fetch
    const { client } = stub(
      (init) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    const started = Date.now();
    const err = await caught(client.request("GET", "/v1/x", undefined, 50));
    expect((err as Error).name).toBe("TimeoutError");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
