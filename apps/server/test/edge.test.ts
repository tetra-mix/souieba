import { describe, expect, it } from "vitest";
import { edgeGuard } from "../src/edge.ts";

const req = (path: string, init: RequestInit = {}) => new Request(`https://souieba.example.com${path}`, init);

describe("Workers の入口での検査", () => {
  it("API 以外のパスは Durable Object に渡さない", () => {
    expect(edgeGuard(req("/"))?.status).toBe(404);
    expect(edgeGuard(req("/wp-login.php"))?.status).toBe(404);
  });

  it("認証の要らないエンドポイントは通す", () => {
    expect(edgeGuard(req("/healthz"))).toBeNull();
    expect(edgeGuard(req("/v1/instance"))).toBeNull();
    expect(edgeGuard(req("/v1/auth/redeem", { method: "POST" }))).toBeNull();
    expect(edgeGuard(req("/v1/admin/bootstrap", { method: "POST" }))).toBeNull();
  });

  it("それ以外は Authorization の形が正しくなければ、その場で 401", () => {
    expect(edgeGuard(req("/v1/me"))?.status).toBe(401);
    expect(edgeGuard(req("/v1/me", { headers: { authorization: "Bearer xyz" } }))?.status).toBe(401);
    expect(edgeGuard(req("/v1/me", { headers: { authorization: "Bearer sou_u_abc" } }))).toBeNull();
    expect(edgeGuard(req("/v1/admin/users", { headers: { authorization: "Bearer sou_m_abc" } }))).toBeNull();
  });

  it("大きすぎる本文は 413", () => {
    const r = req("/v1/posts", { method: "POST", headers: { authorization: "Bearer sou_a_x", "content-length": String(1024 * 1024) } });
    expect(edgeGuard(r)?.status).toBe(413);
  });
});
