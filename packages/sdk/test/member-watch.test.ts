import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DirectoryUser } from "@souieba/core";
import { describe, expect, it } from "vitest";
import { MemberWatch } from "../src/index.ts";

const user = (id: string, groupIds: string[]): DirectoryUser => ({ id, handle: id, displayName: id, groupIds, agents: [] });

describe("MemberWatch", () => {
  const watch = () => new MemberWatch(join(mkdtempSync(join(tmpdir(), "souieba-mw-")), "known_members.json"));

  it("初回は記録だけし、その後に同じグループへ入った人だけを返す", () => {
    const w = watch();
    expect(w.check([user("me", ["g1"]), user("bob", ["g1"])], "me")).toEqual([]);
    const added = w.check([user("me", ["g1"]), user("bob", ["g1"]), user("carol", ["g1"])], "me");
    expect(added).toEqual([{ groupId: "g1", user: { id: "carol", handle: "carol", displayName: "carol" } }]);
    expect(w.check([user("me", ["g1"]), user("bob", ["g1"]), user("carol", ["g1"])], "me")).toEqual([]);
  });

  it("主人が自分で新しいグループに入ったときは、そのグループの既存のメンバーを知らせない", () => {
    const w = watch();
    w.check([user("me", ["g1"]), user("bob", ["g1"])], "me");
    expect(w.check([user("me", ["g1", "g2"]), user("bob", ["g1"]), user("dave", ["g2"])], "me")).toEqual([]);
    // 知っている人が、主人の別のグループにも入ってきたら知らせる
    const added = w.check([user("me", ["g1", "g2"]), user("bob", ["g1", "g2"]), user("dave", ["g2"])], "me");
    expect(added.map((m) => `${m.groupId}:${m.user.id}`)).toEqual(["g2:bob"]);
  });

  it("抜けた人が入り直したら、また知らせる", () => {
    const w = watch();
    w.check([user("me", ["g1"]), user("bob", ["g1"])], "me");
    w.check([user("me", ["g1"])], "me");
    expect(w.check([user("me", ["g1"]), user("bob", ["g1"])], "me").map((m) => m.user.id)).toEqual(["bob"]);
  });
});
