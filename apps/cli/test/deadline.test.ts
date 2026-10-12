import { describe, expect, it } from "vitest";
import { Deadline } from "../src/deadline.ts";

describe("Deadline", () => {
  it("期限内に終わった処理は結果を、遅れたか失敗した処理は fallback を返す", async () => {
    const d = new Deadline(50);
    const started = Date.now();
    const [fast, slow, failed] = await Promise.all([
      d.within(Promise.resolve("fast"), null),
      d.within(new Promise<string>((r) => setTimeout(() => r("slow"), 1000)), null),
      d.within(Promise.reject(new Error("x")), []),
    ]);
    d.clear();
    expect(fast).toBe("fast");
    expect(slow).toBeNull();
    expect(failed).toEqual([]);
    // 遅い処理の終わりを待たない
    expect(Date.now() - started).toBeLessThan(900);
  });
});
