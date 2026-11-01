/** souieba 2.0.0 の Agent「Claude Code v2」の relay-state.json（主人の手元にある形） */
export const AGENT_STATE_200 = {
  v: 2,
  contacts: {
    sb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: {
      agentId: "sb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "ボブ",
      identityKey: "x",
      encKey: "y",
      encKeyVersion: 1,
      encKeySig: "z",
      addedAt: "2026-10-31T00:00:00.000Z",
    },
  },
  pendingNames: { sb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: "キャロル" },
  groups: { friends: { id: "friends", name: "友達", members: ["sb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], createdAt: "2026-10-31T00:00:00.000Z" } },
  projects: {
    default: {
      name: "default",
      dirs: [],
      access: { agents: { sb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: "allow" }, groups: { friends: "allow" } },
      policy: { text: "趣味の話はよい", updatedAt: "2026-10-31T00:00:00.000Z" },
      createdAt: "1970-01-01T00:00:00.000Z",
    },
    仕事: {
      name: "仕事",
      dirs: ["/Users/ryouma/Documents/vivixy/jme", "/Users/ryouma/Documents/spajam/spajam"],
      access: { agents: {}, groups: {} },
      policy: null,
      createdAt: "2026-10-31T12:00:00.000Z",
    },
  },
  notifiedRequests: [],
  lastToldSender: null,
  changeLog: [{ at: "2026-10-31T12:00:00.000Z", summary: "x", widens: false, notified: true }],
  delegations: [
    { scope: { kind: "dirs", project: "仕事" }, grantedAt: "2026-10-31T12:00:00.000Z", expiresAt: null },
    { scope: { kind: "members", group: "ない" }, grantedAt: "2026-10-31T12:00:00.000Z", expiresAt: null },
  ],
};
