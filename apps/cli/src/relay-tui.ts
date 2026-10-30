/**
 * souieba relay ui: v2 の設定を、主人が自分の目で見て直接操作する画面（TUI）。
 * エージェント（LLM）を通さない、決定論的な入口（docs/v2-relay-plan.md §5）。
 * 届いた接続要求・連絡先と共有の可否・グループ・Policy・ブロックを一画面に並べ、キーで操作する。
 * 操作の中身は CLI と同じ relay-ops.ts を使う。共有を広げる操作と、取り消しにくい操作は、画面の中で y/n を聞く。
 * 外部のライブラリは使わない（CLI を依存なしで配るため）。
 */
import { emitKeypressEvents } from "node:readline";
import type { RelayConnection, RelayState, ResolvedRelayAgent } from "@souieba/sdk";
import { accessFor } from "@souieba/sdk";
import { type Change, relayOps } from "./relay-ops.ts";
import type { relayParts } from "./relay.ts";

type Key = { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string };

export type TuiInput = NodeJS.ReadableStream & { setRawMode?: (on: boolean) => unknown; isTTY?: boolean };
export type TuiOutput = { write: (s: string) => unknown; columns?: number; rows?: number };

export type TuiOptions = {
  parts: ReturnType<typeof relayParts>;
  agent: ResolvedRelayAgent;
  now: () => Date;
  input?: TuiInput;
  output?: TuiOutput;
};

type Row =
  | { kind: "policy" }
  | { kind: "request"; id: string; at: string }
  | { kind: "contact"; id: string }
  | { kind: "unnamed"; id: string }
  | { kind: "outgoing"; id: string }
  | { kind: "group"; id: string }
  | { kind: "blocked"; id: string };

type Line = { text: string; row?: Row };

type Mode =
  | { kind: "list" }
  | { kind: "prompt"; label: string; value: string; onSubmit: (v: string) => Promise<void> | void }
  | { kind: "confirm"; summary: string; onYes: () => Promise<void> }
  | { kind: "members"; groupId: string; cursor: number; selected: Set<string> };

const ESC = "\x1b[";
const short = (id: string) => `${id.slice(0, 12)}…`;

/** 端末での表示幅（全角は2） */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w +=
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x1f300
        ? 2
        : 1;
  }
  return w;
}

const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - displayWidth(s)));

/** 幅に収まるように切る */
function clip(s: string, w: number): string {
  if (displayWidth(s) <= w) return s;
  let out = "";
  for (const ch of s) {
    if (displayWidth(out + ch) > w - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/** 文字列から表示を崩す制御文字を除く（呼び名などは検証済みだが、念のため） */
const plain = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

export function createRelayTui(opts: TuiOptions) {
  const { parts: p, agent } = opts;
  const ops = relayOps({ parts: p, selfId: agent.identity.agentId, now: opts.now });
  const out = opts.output ?? process.stdout;
  const input = opts.input ?? process.stdin;

  let state: RelayState = p.state.load();
  let connections: RelayConnection[] = [];
  let blocked: string[] = [];
  let offline: string | null = null;
  let cursor = 0;
  let mode: Mode = { kind: "list" };
  let message = "";
  let queue: Promise<void> = Promise.resolve();
  let lastScreen = "";
  let finish: () => void = () => {};
  const done = new Promise<void>((r) => (finish = r));
  let closed = false;

  async function reload(): Promise<void> {
    try {
      const r = await p.transport().syncContacts(true);
      connections = r.connections;
      blocked = r.blocked;
      offline = null;
    } catch (err) {
      offline = `Relay に接続できません（${err instanceof Error ? err.message : err}）。手元の設定だけを表示しています`;
    }
    state = p.state.load();
  }

  function lines(): Line[] {
    const s = state;
    const L: Line[] = [];
    const by = (st: RelayConnection["status"]) => connections.filter((c) => c.status === st);
    L.push({ text: `Souieba v2 の設定  ${plain(agent.name)}  ${agent.identity.agentId}` });
    L.push({ text: `Relay: ${agent.relayUrl}` });
    L.push({ text: "" });
    L.push({ text: `共有方針: ${s.policy ? plain(s.policy.text).replace(/\s+/g, " ") : "（未設定）"}`, row: { kind: "policy" } });

    const incoming = by("incoming");
    if (incoming.length) {
      L.push({ text: "" }, { text: `■ 届いた接続要求（${incoming.length}）` });
      for (const c of incoming) L.push({ text: `${c.peer}  ${c.createdAt.slice(0, 16).replace("T", " ")}`, row: { kind: "request", id: c.peer, at: c.createdAt } });
    }

    const contacts = Object.values(s.contacts);
    L.push({ text: "" }, { text: `■ 連絡先（${contacts.length}）  ${pad("", 0)}個別の設定 → 共有` });
    if (contacts.length === 0) L.push({ text: "  （まだいません。c で接続を要求できます）" });
    for (const c of contacts) {
      const own = s.access.agents[c.agentId];
      const d = accessFor(s, c.agentId);
      const groups = Object.values(s.groups)
        .filter((g) => g.members.includes(c.agentId))
        .map((g) => plain(g.name));
      const rule = own === "allow" ? "許可" : own === "deny" ? "禁止" : "なし";
      const via = d.why === "group_allow" ? "（グループで許可）" : d.why === "group_deny" ? "（グループで禁止）" : "";
      L.push({
        text: `${pad(clip(plain(c.name), 16), 17)}${pad(short(c.agentId), 16)}${pad(rule, 6)}→ ${d.allowed ? "共有する" : "共有しない"}${via}${groups.length ? `  [${groups.join("・")}]` : ""}`,
        row: { kind: "contact", id: c.agentId },
      });
    }

    const unnamed = by("accepted").filter((c) => !s.contacts[c.peer]);
    if (unnamed.length) {
      L.push({ text: "" }, { text: "■ 呼び名のない接続（呼び名を付けるまで、この人からの近況は受け取りません）" });
      for (const c of unnamed) L.push({ text: c.peer, row: { kind: "unnamed", id: c.peer } });
    }

    const outgoing = by("outgoing");
    if (outgoing.length) {
      L.push({ text: "" }, { text: "■ 送った接続要求（相手の承認待ち）" });
      for (const c of outgoing) L.push({ text: `${pad(plain(s.pendingNames[c.peer] ?? ""), 17)}${c.peer}`, row: { kind: "outgoing", id: c.peer } });
    }

    const groups = Object.values(s.groups);
    L.push({ text: "" }, { text: `■ グループ（${groups.length}）  この PC だけのもので、相手には見えません` });
    if (groups.length === 0) L.push({ text: "  （まだありません。g で作れます）" });
    for (const g of groups) {
      const rule = s.access.groups[g.id] === "allow" ? "許可" : s.access.groups[g.id] === "deny" ? "禁止" : "なし";
      const members = g.members.map((m) => plain(s.contacts[m]?.name ?? short(m))).join("、") || "メンバーなし";
      L.push({ text: `${pad(clip(`${plain(g.name)} [${g.id}]`, 24), 25)}${pad(rule, 6)}${members}`, row: { kind: "group", id: g.id } });
    }

    if (blocked.length) {
      L.push({ text: "" }, { text: "■ ブロック中" });
      for (const id of blocked) L.push({ text: id, row: { kind: "blocked", id } });
    }
    return L;
  }

  const selectable = (ls: Line[]) => ls.filter((l) => l.row);

  function keysFor(row: Row | undefined): string {
    switch (row?.kind) {
      case "policy":
        return "Enter: 共有方針を編集";
      case "request":
        return "a: 承認  r: 断る  b: ブロック";
      case "contact":
        return "Space: 許可→禁止→なし  n: 呼び名  x: 接続解除  b: ブロック";
      case "unnamed":
        return "n: 呼び名を付ける  x: 接続解除  b: ブロック";
      case "outgoing":
        return "x: 要求を取り消す";
      case "group":
        return "Space: 許可→禁止→なし  m: メンバー  d: 削除";
      case "blocked":
        return "u: ブロックを解除";
      default:
        return "";
    }
  }

  function render(): void {
    const width = Math.max(40, (out.columns ?? 100) - 1);
    const body: string[] = [];
    if (mode.kind === "members") {
      const m = mode;
      const g = state.groups[m.groupId];
      const contacts = Object.values(state.contacts);
      body.push(`グループ「${plain(g?.name ?? "")}」のメンバー（Space で選ぶ / Enter で決定 / q で取りやめ）`, "");
      if (contacts.length === 0) body.push("  （連絡先がありません）");
      contacts.forEach((c, i) => {
        body.push(`${i === m.cursor ? "›" : " "} [${m.selected.has(c.agentId) ? "x" : " "}] ${plain(c.name)}  ${short(c.agentId)}`);
      });
    } else {
      const ls = lines();
      const sel = selectable(ls);
      cursor = Math.min(cursor, Math.max(0, sel.length - 1));
      const current = sel[cursor];
      for (const l of ls) body.push(clip(`${l.row && l === current ? "› " : "  "}${l.text}`, width));
      body.push("");
      if (offline) body.push(clip(`! ${offline}`, width));
      body.push(clip(`[${keysFor(current?.row)}]`, width));
      body.push(clip("[↑↓: 選ぶ  c: 接続を要求  g: グループを作る  r: 再読み込み  q: 終了]", width));
    }
    if (mode.kind === "prompt") body.push("", `${mode.label}: ${mode.value}▏`, "（Enter で決定 / Esc で取りやめ）");
    if (mode.kind === "confirm") body.push("", ...mode.summary.split("\n"), "y で実行 / それ以外のキーで取りやめ");
    if (message) body.push("", ...message.split("\n").map((m) => clip(m, width)));
    lastScreen = body.join("\n");
    out.write(`${ESC}H${ESC}2J${body.join("\r\n")}`);
  }

  function prompt(label: string, initial: string, onSubmit: (v: string) => Promise<void> | void): void {
    mode = { kind: "prompt", label, value: initial, onSubmit };
  }

  /** 変更を実行する。広げる操作と、取り消しにくい操作（destructive）は、先に y/n を聞く */
  async function perform(change: Change, opts: { destructive?: boolean } = {}): Promise<void> {
    const run = async () => {
      try {
        message = await change.apply();
      } catch (err) {
        message = `エラー: ${err instanceof Error ? err.message : err}`;
      }
      await reload();
    };
    if (change.widens || opts.destructive) mode = { kind: "confirm", summary: change.summary, onYes: run };
    else await run();
  }

  /** 操作を組み立てて実行する。組み立てで出たエラー（呼び名の重複など）は、画面の下に出す */
  async function attempt(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      message = `エラー: ${err instanceof Error ? err.message : err}`;
    }
  }

  const nextRule = (r: "allow" | "deny" | undefined) => (r === undefined ? "allow" : r === "allow" ? "deny" : null);

  function freeGroupId(): string {
    for (let i = 1; ; i++) if (!state.groups[`g${i}`]) return `g${i}`;
  }

  async function onListKey(str: string | undefined, key: Key): Promise<void> {
    const sel = selectable(lines());
    const row = sel[cursor]?.row;
    const name = key.name;
    if (name === "up" || str === "k") cursor = Math.max(0, cursor - 1);
    else if (name === "down" || str === "j") cursor = Math.min(sel.length - 1, cursor + 1);
    else if (str === "q") return close();
    else if (str === "r" && row?.kind !== "request") {
      message = "再読み込みしました";
      await reload();
    } else if (str === "c") {
      prompt("接続する相手の Agent ID", "", (id) =>
        prompt("この人の呼び名", "", (n) => attempt(async () => perform(ops.connect(id.trim(), n)))),
      );
    } else if (str === "g") {
      prompt("新しいグループの名前", "", (n) => attempt(async () => perform(ops.groupCreate(freeGroupId(), n))));
    } else if (row?.kind === "policy" && (name === "return" || str === "e")) {
      prompt("共有方針（空にすると消します）", state.policy?.text ?? "", (t) =>
        attempt(async () => perform(t.trim() ? ops.policySet(t) : ops.policyClear())),
      );
    } else if (row?.kind === "request") {
      if (str === "a") prompt("この人の呼び名", "", (n) => attempt(async () => perform(ops.accept(row.id, n))));
      else if (str === "r") await attempt(async () => perform(ops.reject(row.id), { destructive: true }));
      else if (str === "b") await attempt(async () => perform(ops.disconnect(row.id, { block: true }), { destructive: true }));
    } else if (row?.kind === "contact") {
      if (name === "space" || name === "return") await attempt(async () => perform(ops.setAccess(row.id, nextRule(state.access.agents[row.id]))));
      else if (str === "n") prompt("新しい呼び名", state.contacts[row.id]?.name ?? "", (n) => attempt(async () => perform(ops.rename(row.id, n))));
      else if (str === "x") await attempt(async () => perform(ops.disconnect(row.id), { destructive: true }));
      else if (str === "b") await attempt(async () => perform(ops.disconnect(row.id, { block: true }), { destructive: true }));
    } else if (row?.kind === "unnamed") {
      if (str === "n") prompt("この人の呼び名", "", (n) => attempt(async () => perform(ops.rename(row.id, n))));
      else if (str === "x") await attempt(async () => perform(ops.disconnect(row.id), { destructive: true }));
      else if (str === "b") await attempt(async () => perform(ops.disconnect(row.id, { block: true }), { destructive: true }));
    } else if (row?.kind === "outgoing") {
      if (str === "x") await attempt(async () => perform(ops.disconnect(row.id), { destructive: true }));
    } else if (row?.kind === "group") {
      if (name === "space" || name === "return") await attempt(async () => perform(ops.setAccess(`group:${row.id}`, nextRule(state.access.groups[row.id]))));
      else if (str === "m") mode = { kind: "members", groupId: row.id, cursor: 0, selected: new Set(state.groups[row.id]?.members ?? []) };
      else if (str === "d") await attempt(async () => perform(ops.groupDelete(`group:${row.id}`), { destructive: true }));
    } else if (row?.kind === "blocked") {
      if (str === "u") await attempt(async () => perform(ops.unblock(row.id)));
    }
  }

  async function onKey(str: string | undefined, key: Key = {}): Promise<void> {
    if (key.ctrl && key.name === "c") return close();
    if (mode.kind === "list") {
      message = "";
      await onListKey(str, key);
    } else if (mode.kind === "prompt") {
      const m = mode;
      if (key.name === "escape") {
        mode = { kind: "list" };
        message = "取りやめました";
      } else if (key.name === "return") {
        mode = { kind: "list" };
        await m.onSubmit(m.value);
      } else if (key.name === "backspace") {
        m.value = [...m.value].slice(0, -1).join("");
      } else if (str && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/.test(str)) {
        m.value += str;
      }
    } else if (mode.kind === "confirm") {
      const m = mode;
      mode = { kind: "list" };
      if (str === "y" || str === "Y") await m.onYes();
      else message = "取りやめました";
    } else if (mode.kind === "members") {
      const m = mode;
      const contacts = Object.values(state.contacts);
      if (key.name === "up" || str === "k") m.cursor = Math.max(0, m.cursor - 1);
      else if (key.name === "down" || str === "j") m.cursor = Math.min(contacts.length - 1, m.cursor + 1);
      else if (key.name === "space") {
        const id = contacts[m.cursor]?.agentId;
        if (id) m.selected.has(id) ? m.selected.delete(id) : m.selected.add(id);
      } else if (str === "q" || key.name === "escape") {
        mode = { kind: "list" };
        message = "取りやめました";
      } else if (key.name === "return") {
        mode = { kind: "list" };
        const before = new Set(state.groups[m.groupId]?.members ?? []);
        const add = [...m.selected].filter((id) => !before.has(id));
        const remove = [...before].filter((id) => !m.selected.has(id));
        if (add.length + remove.length === 0) message = "変更はありません";
        else await attempt(async () => perform(ops.groupMembers(`group:${m.groupId}`, add, remove)));
      }
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    input.removeListener("keypress", listener);
    input.setRawMode?.(false);
    input.pause();
    out.write(`${ESC}?25h${ESC}?1049l`);
    finish();
  }

  const listener = (str: string | undefined, key: Key) => {
    queue = queue
      .then(() => onKey(str, key))
      .catch((err) => {
        message = `エラー: ${err instanceof Error ? err.message : err}`;
      })
      .then(() => {
        if (!closed) render();
      });
  };

  return {
    /** 画面を出して、q で閉じるまで待つ */
    async start(): Promise<void> {
      emitKeypressEvents(input);
      input.setRawMode?.(true);
      input.resume();
      out.write(`${ESC}?1049h${ESC}?25l`);
      message = "読み込んでいます…";
      render();
      queue = queue.then(async () => {
        await reload();
        message = "";
        render();
      });
      input.on("keypress", listener);
      return done;
    },
    /** 入力の処理が終わるまで待つ（テスト用） */
    idle: () => queue,
    /** 最後に描いた画面（テスト用） */
    screen: () => lastScreen,
    close,
  };
}

export async function runRelayTui(opts: TuiOptions): Promise<void> {
  if (!opts.input && !(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new Error("souieba relay ui は端末で実行してください（主人が自分で操作する画面です。エージェントは souieba relay の各コマンドを使います）");
  }
  await createRelayTui(opts).start();
}
