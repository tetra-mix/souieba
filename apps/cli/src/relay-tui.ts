/**
 * souieba relay ui: v2 の設定を、主人が自分の目で見て直接操作する画面（TUI）。
 * エージェント（LLM）を通さない、決定論的な入口（docs/v2-relay-plan.md §5）。
 * 上にタブを並べる。プロジェクトのタブ（← → で切り替え）では、そのプロジェクトのディレクトリ・共有先・Policy を出し、
 * 「連絡先」のタブには、全体のもの（届いた接続要求・連絡先の呼び名・グループ・ブロック）をまとめる（docs/v2-projects.md §6）。
 * 操作の中身は CLI と同じ relay-ops.ts を使う。共有を広げる操作と、取り消しにくい操作は、画面の中で y/n を聞く。
 * 外部のライブラリは使わない（CLI を依存なしで配るため）。
 *
 * 表示の決まり:
 * - 東アジアの「幅があいまいな文字」（■ › → … ・ など）は端末によって幅が変わり、列がずれるので、並びに効く場所では使わない
 * - 選んでいる行は反転、共有する / しないは色と太さで分ける
 * - 画面を消してから描き直すとちらつくので、行ごとに上書きして行末を消す
 */
import { emitKeypressEvents } from "node:readline";
import type { RelayConnection, RelayState, ResolvedRelayAgent } from "@souieba/sdk";
import { DEFAULT_PROJECT, accessFor } from "@souieba/sdk";
import { type Change, projectLabel, relayOps } from "./relay-ops.ts";
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
  /** ディレクトリを足すときの初期値（既定はカレントディレクトリ） */
  cwd?: string;
};

type Row =
  | { kind: "policy" }
  | { kind: "dir"; dir: string }
  | { kind: "addDir" }
  | { kind: "share"; id: string }
  | { kind: "shareGroup"; id: string }
  | { kind: "request"; id: string }
  | { kind: "contact"; id: string }
  | { kind: "unnamed"; id: string }
  | { kind: "outgoing"; id: string }
  | { kind: "group"; id: string }
  | { kind: "blocked"; id: string }
  | { kind: "member"; id: string };

type Style = "bold" | "dim" | "green" | "red" | "section";

/** 1行の中の1区切り。w があれば、その幅に詰める（列をそろえる） */
type Cell = { t: string; w?: number; style?: Style };
type Line = { cells: Cell[]; row?: Row };

type Mode =
  | { kind: "list" }
  | { kind: "prompt"; label: string; value: string; onSubmit: (v: string) => Promise<void> | void }
  | { kind: "confirm"; summary: string; onYes: () => Promise<void> }
  | { kind: "members"; groupId: string; cursor: number; selected: Set<string> };

const ESC = "\x1b[";
const SGR: Record<Style, [string, string]> = {
  bold: [`${ESC}1m`, `${ESC}22m`],
  dim: [`${ESC}2m`, `${ESC}22m`],
  green: [`${ESC}32;1m`, `${ESC}39;22m`],
  red: [`${ESC}31m`, `${ESC}39m`],
  section: [`${ESC}1;4m`, `${ESC}22;24m`],
};
const short = (id: string) => `${id.slice(0, 12)}..`;

/** 端末での表示幅（全角は2）。幅があいまいな文字は1として数える（画面では使わない） */
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

/** 幅に収まるように切る（切ったしるしは ASCII の ..） */
function clip(s: string, w: number): string {
  if (displayWidth(s) <= w) return s;
  if (w <= 2) return ".".repeat(Math.max(0, w));
  let out = "";
  for (const ch of s) {
    if (displayWidth(out + ch) > w - 2) break;
    out += ch;
  }
  return `${out}..`;
}

/** 幅に合わせて折り返す。sep で区切った塊の途中では、なるべく折らない */
export function wrap(s: string, width: number, sep = "  "): string[] {
  const out: string[] = [];
  let cur = "";
  for (const part of s.split(sep)) {
    const next = cur ? `${cur}${sep}${part}` : part;
    if (displayWidth(next) <= width) cur = next;
    else {
      if (cur) out.push(cur);
      cur = part;
      while (displayWidth(cur) > width) {
        let head = "";
        for (const ch of cur) {
          if (displayWidth(head + ch) > width) break;
          head += ch;
        }
        out.push(head);
        cur = cur.slice(head.length);
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 文字列から表示を崩す制御文字を除く（呼び名などは検証済みだが、念のため） */
const plain = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

const text = (t: string, style?: Style): Line => ({ cells: [{ t, style }] });

/** 1行を、幅に収めて、文字だけの形と色つきの形にする */
function renderLine(l: Line, width: number, selected: boolean): { plain: string; ansi: string } {
  let p = "";
  let a = "";
  let used = 0;
  for (const c of l.cells) {
    if (used >= width) break;
    const room = width - used;
    let t = clip(plain(c.t), c.w !== undefined ? Math.min(c.w, room) : room);
    if (c.w !== undefined) t = pad(t, Math.min(c.w, room));
    used += displayWidth(t);
    p += t;
    a += c.style ? `${SGR[c.style][0]}${t}${SGR[c.style][1]}` : t;
  }
  if (selected) {
    const fill = " ".repeat(Math.max(0, width - used));
    return { plain: p.trimEnd(), ansi: `${ESC}7m${a}${fill}${ESC}27m` };
  }
  return { plain: p.trimEnd(), ansi: a };
}

export function createRelayTui(opts: TuiOptions) {
  const { parts: p, agent } = opts;
  const ops = relayOps({ parts: p, selfId: agent.identity.agentId, now: opts.now });
  const out = opts.output ?? process.stdout;
  const input = opts.input ?? process.stdin;

  let state: RelayState = p.state.load();
  let connections: RelayConnection[] = [];
  let blocked: string[] = [];
  let offline: string | null = null;
  let tab = 0;
  let cursor = 0;
  let scroll = 0;
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
    tab = Math.min(tab, tabs().length - 1);
  }

  /** タブ: 既定のプロジェクト・ほかのプロジェクト（名前順）・連絡先 */
  function tabs(): { label: string; project: string | null }[] {
    const names = Object.keys(state.projects)
      .filter((n) => n !== DEFAULT_PROJECT)
      .sort((a, b) => a.localeCompare(b));
    return [
      { label: projectLabel(DEFAULT_PROJECT), project: DEFAULT_PROJECT },
      ...names.map((n) => ({ label: n, project: n })),
      { label: "連絡先", project: null },
    ];
  }

  const currentProject = () => tabs()[tab]?.project ?? null;
  const groupName = (id: string) => plain(state.groups[id]?.name ?? id);

  function projectLines(name: string): Line[] {
    const s = state;
    const pr = s.projects[name]!;
    const L: Line[] = [];
    L.push({ cells: [{ t: "共有方針: ", style: "bold" }, { t: pr.policy ? plain(pr.policy.text).replace(/\s+/g, " ") : "（未設定。Enter で書く）" }], row: { kind: "policy" } });
    L.push(text(""));
    if (name === DEFAULT_PROJECT) {
      L.push(text("ディレクトリ: ほかのどのプロジェクトにも入らない場所と、ディレクトリのない会話", "dim"));
    } else {
      L.push(text("ディレクトリ", "section"));
      for (const d of pr.dirs) L.push({ cells: [{ t: `  ${d}` }], row: { kind: "dir", dir: d } });
      L.push({ cells: [{ t: "  + ディレクトリを足す", style: "dim" }], row: { kind: "addDir" } });
    }

    L.push(text(""), text("共有先（このプロジェクトのメモを、誰に共有するか）", "section"));
    const contacts = Object.values(s.contacts);
    if (contacts.length === 0) L.push(text("  （連絡先がまだいません。「連絡先」タブの c で接続を要求できます）", "dim"));
    else {
      L.push({ cells: [{ t: "  呼び名", w: 20 }, { t: "個別", w: 6 }, { t: "結果", w: 12 }, { t: "理由" }].map((c) => ({ ...c, style: "dim" as const })) });
    }
    for (const c of contacts) {
      const own = pr.access.agents[c.agentId];
      const d = accessFor(s, c.agentId, name);
      const ruleGroups = (rule: "allow" | "deny") =>
        Object.values(s.groups)
          .filter((g) => g.members.includes(c.agentId) && pr.access.groups[g.id] === rule)
          .map((g) => `「${plain(g.name)}」`)
          .join("");
      const reason =
        d.why === "agent_allow"
          ? "個別に許可"
          : d.why === "agent_deny"
            ? "個別に禁止"
            : d.why === "group_allow"
              ? `グループ${ruleGroups("allow")}で許可`
              : d.why === "group_deny"
                ? `グループ${ruleGroups("deny")}で禁止`
                : "設定なし";
      L.push({
        cells: [
          { t: `  ${plain(c.name)}`, w: 20 },
          { t: own === "allow" ? "許可" : own === "deny" ? "禁止" : "-", w: 6 },
          d.allowed ? { t: "共有する", w: 12, style: "green" } : { t: "共有しない", w: 12, style: "dim" },
          { t: reason, style: d.why === "default_deny" ? "dim" : undefined },
        ],
        row: { kind: "share", id: c.agentId },
      });
    }
    const groups = Object.values(s.groups);
    if (groups.length) {
      L.push(text(""), { cells: [{ t: "  グループ", w: 20 }, { t: "設定", w: 6 }, { t: "メンバー" }].map((c) => ({ ...c, style: "dim" as const })) });
      for (const g of groups) {
        const rule = pr.access.groups[g.id];
        L.push({
          cells: [
            { t: `  ${plain(g.name)}`, w: 20 },
            { t: rule === "allow" ? "許可" : rule === "deny" ? "禁止" : "-", w: 6, style: rule === "allow" ? "green" : undefined },
            { t: g.members.map((m) => plain(s.contacts[m]?.name ?? short(m))).join("、") || "メンバーなし" },
          ],
          row: { kind: "shareGroup", id: g.id },
        });
      }
    }
    return L;
  }

  function contactsLines(): Line[] {
    const s = state;
    const L: Line[] = [];
    const by = (st: RelayConnection["status"]) => connections.filter((c) => c.status === st);

    const incoming = by("incoming");
    if (incoming.length) {
      L.push(text(`届いた接続要求（${incoming.length}）`, "section"));
      for (const c of incoming) L.push({ cells: [{ t: `  ${c.peer}`, w: 40 }, { t: c.createdAt.slice(0, 16).replace("T", " "), style: "dim" }], row: { kind: "request", id: c.peer } });
      L.push(text(""));
    }

    const contacts = Object.values(s.contacts);
    L.push(text(`連絡先（${contacts.length}）`, "section"));
    if (contacts.length === 0) L.push(text("  （まだいません。c で接続を要求できます）", "dim"));
    for (const c of contacts) {
      const groups = Object.values(s.groups).filter((g) => g.members.includes(c.agentId)).map((g) => plain(g.name));
      const shared = Object.keys(s.projects).filter((pr) => accessFor(s, c.agentId, pr).allowed).map(projectLabel);
      L.push({
        cells: [
          { t: `  ${plain(c.name)}`, w: 20 },
          { t: short(c.agentId), w: 16, style: "dim" },
          { t: shared.length ? `共有: ${shared.join("、")}` : "共有なし", w: 24, style: shared.length ? "green" : "dim" },
          { t: groups.length ? `グループ: ${groups.join("、")}` : "" },
        ],
        row: { kind: "contact", id: c.agentId },
      });
    }

    const unnamed = by("accepted").filter((c) => !s.contacts[c.peer]);
    if (unnamed.length) {
      L.push(text(""), text("呼び名のない接続（呼び名を付けるまで、この人からの近況は受け取りません）", "section"));
      for (const c of unnamed) L.push({ cells: [{ t: `  ${c.peer}` }], row: { kind: "unnamed", id: c.peer } });
    }

    const outgoing = by("outgoing");
    if (outgoing.length) {
      L.push(text(""), text("送った接続要求（相手の承認待ち）", "section"));
      for (const c of outgoing) L.push({ cells: [{ t: `  ${plain(s.pendingNames[c.peer] ?? "")}`, w: 20 }, { t: c.peer, style: "dim" }], row: { kind: "outgoing", id: c.peer } });
    }

    const groups = Object.values(s.groups);
    L.push(text(""), text(`グループ（${groups.length}）  この PC だけのもので、相手には見えません`, "section"));
    if (groups.length === 0) L.push(text("  （まだありません。g で作れます）", "dim"));
    for (const g of groups) {
      const members = g.members.map((m) => plain(s.contacts[m]?.name ?? short(m))).join("、") || "メンバーなし";
      L.push({ cells: [{ t: `  ${plain(g.name)}`, w: 20 }, { t: `${g.members.length}人`, w: 6 }, { t: members }], row: { kind: "group", id: g.id } });
    }

    if (blocked.length) {
      L.push(text(""), text("ブロック中", "section"));
      for (const id of blocked) L.push({ cells: [{ t: `  ${id}` }], row: { kind: "blocked", id } });
    }
    return L;
  }

  function membersLines(m: Extract<Mode, { kind: "members" }>): Line[] {
    const contacts = Object.values(state.contacts);
    const L: Line[] = [text(`グループ「${groupName(m.groupId)}」のメンバー`, "section")];
    if (contacts.length === 0) L.push(text("  （連絡先がありません）", "dim"));
    for (const c of contacts) {
      L.push({
        cells: [{ t: `  [${m.selected.has(c.agentId) ? "x" : " "}] ` }, { t: plain(c.name), w: 20 }, { t: short(c.agentId), style: "dim" }],
        row: { kind: "member", id: c.agentId },
      });
    }
    return L;
  }

  function bodyLines(): Line[] {
    if (mode.kind === "members") return membersLines(mode);
    const pr = currentProject();
    return pr ? projectLines(pr) : contactsLines();
  }

  const selectable = (ls: Line[]) => ls.filter((l) => l.row);

  function keysFor(row: Row | undefined): string {
    switch (row?.kind) {
      case "policy":
        return "Enter: 共有方針を編集";
      case "dir":
        return "x: このディレクトリを外す";
      case "addDir":
        return "Enter: ディレクトリを足す";
      case "share":
      case "shareGroup":
        return "Space: 許可 / 禁止 / なし を切り替え";
      case "request":
        return "a: 承認  r: 断る  b: ブロック";
      case "contact":
        return "n: 呼び名  x: 接続解除  b: ブロック";
      case "unnamed":
        return "n: 呼び名を付ける  x: 接続解除  b: ブロック";
      case "outgoing":
        return "x: 要求を取り消す";
      case "group":
        return "m / Enter: メンバー  d: 削除";
      case "blocked":
        return "u: ブロックを解除";
      default:
        return "";
    }
  }

  function helpText(row: Row | undefined): string {
    if (mode.kind === "members") return "上下: 選ぶ  Space: 入れる / 外す  Enter: 決める  q: やめる";
    const pr = currentProject();
    const global =
      pr === null
        ? "c: 接続を要求  g: グループを作る"
        : `p: プロジェクトを作る${pr !== DEFAULT_PROJECT ? "  D: このプロジェクトを消す" : ""}`;
    return [keysFor(row), "左右: タブ  上下: 選ぶ", global, "R: 再読み込み  q: 終了"].filter(Boolean).join("  ");
  }

  function render(): void {
    const width = Math.max(20, (out.columns ?? 100) - 1);
    const height = Math.max(8, out.rows ?? 30);

    // 上: 題・Relay・タブ
    const head: { plain: string; ansi: string }[] = [];
    head.push(renderLine({ cells: [{ t: "Souieba v2 の設定  ", style: "bold" }, { t: `${plain(agent.name)}  ${agent.identity.agentId}` }] }, width, false));
    head.push(renderLine(text(`Relay: ${agent.relayUrl}`, "dim"), width, false));
    const ts = tabs();
    let tp = "";
    let ta = "";
    ts.forEach((t, i) => {
      const label = ` ${plain(t.label)} `;
      tp += `${i === tab ? `[${label}]` : ` ${label} `} `;
      ta += `${i === tab ? `${ESC}7;1m[${label}]${ESC}27;22m` : ` ${label} `} `;
    });
    head.push(displayWidth(tp) <= width ? { plain: tp.trimEnd(), ansi: ta } : renderLine(text(`${ts[tab]!.label}（${tab + 1}/${ts.length}）  左右で切り替え`), width, false));
    head.push({ plain: "", ansi: "" });

    // 下: 知らせ・キーの説明（折り返す）・入力欄
    const ls = bodyLines();
    const sel = selectable(ls);
    if (mode.kind === "members") mode.cursor = Math.min(mode.cursor, Math.max(0, sel.length - 1));
    else cursor = Math.min(cursor, Math.max(0, sel.length - 1));
    const curIndex = mode.kind === "members" ? mode.cursor : cursor;
    const current = sel[curIndex];
    const foot: string[] = [""];
    if (offline) foot.push(...wrap(`! ${offline}`, width, "\u0000"));
    if (mode.kind === "prompt") foot.push(...wrap(`${mode.label}: ${mode.value}_`, width, "\u0000"), "（Enter で決める / Esc でやめる）");
    else if (mode.kind === "confirm") foot.push(...mode.summary.split("\n").flatMap((x) => wrap(x, width, "\u0000")), "y で実行 / それ以外のキーでやめる");
    else foot.push(...wrap(helpText(current?.row), width));
    if (message) foot.push(...message.split("\n").flatMap((x) => wrap(x, width, "\u0000")));

    // 真ん中: 選んでいる行が見えるように送る
    let room = Math.max(3, height - head.length - foot.length);
    // 収まらないときは、何行目を見ているかの行を1つ足す
    if (ls.length > room) room = Math.max(3, room - 1);
    const at = current ? ls.indexOf(current) : 0;
    if (at < scroll) scroll = at;
    if (at >= scroll + room) scroll = at - room + 1;
    scroll = Math.max(0, Math.min(scroll, Math.max(0, ls.length - room)));
    // 見出しの直後の行を選んだときは、見出しも見えるようにする
    if (at > 0 && at === scroll && !ls[at - 1]?.row) scroll = Math.max(0, scroll - 1);
    const visible = ls.slice(scroll, scroll + room).map((l) => renderLine(l, width, l === current));
    const more = ls.length > room ? `  (${scroll + 1}-${Math.min(ls.length, scroll + room)} / ${ls.length} 行)` : "";
    while (visible.length < room) visible.push({ plain: "", ansi: "" });
    if (more) visible.push({ plain: more, ansi: `${SGR.dim[0]}${more}${SGR.dim[1]}` });

    const all = [...head, ...visible, ...foot.map((f) => ({ plain: f, ansi: f }))].slice(0, height);
    lastScreen = all.map((x) => x.plain).join("\n");
    out.write(`${ESC}H${all.map((x) => `${x.ansi}${ESC}K`).join("\r\n")}${ESC}J`);
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

  function switchTab(delta: number): void {
    const n = tabs().length;
    tab = (tab + delta + n) % n;
    cursor = 0;
    scroll = 0;
  }

  async function onListKey(str: string | undefined, key: Key): Promise<void> {
    const sel = selectable(bodyLines());
    const row = sel[cursor]?.row;
    const name = key.name;
    const pr = currentProject();
    if (name === "up" || str === "k") cursor = Math.max(0, cursor - 1);
    else if (name === "down" || str === "j") cursor = Math.min(sel.length - 1, cursor + 1);
    else if (name === "left") switchTab(-1);
    else if (name === "right" || name === "tab") switchTab(1);
    else if (str === "q") return close();
    else if (str === "R") {
      message = "再読み込みしました";
      await reload();
    } else if (pr !== null) {
      // プロジェクトのタブ
      if (str === "p") {
        prompt("新しいプロジェクトの名前", "", (n) =>
          prompt("結び付けるディレクトリ（空にすると付けない）", opts.cwd ?? process.cwd(), (d) =>
            attempt(async () => {
              await perform(ops.projectAdd(n, d.trim() ? [d.trim()] : []));
              const i = tabs().findIndex((t) => t.project === n.trim());
              if (i >= 0) tab = i;
            }),
          ),
        );
      } else if (str === "D" && pr !== DEFAULT_PROJECT) {
        await attempt(async () => perform(ops.projectDelete(pr), { destructive: true }));
      } else if (row?.kind === "policy" && (name === "return" || str === "e")) {
        prompt("共有方針（空にすると消します）", state.projects[pr]?.policy?.text ?? "", (t) =>
          attempt(async () => perform(t.trim() ? ops.policySet(t, pr) : ops.policyClear(pr))),
        );
      } else if (row?.kind === "addDir" && (name === "return" || str === "a")) {
        prompt("足すディレクトリ", opts.cwd ?? process.cwd(), (d) => attempt(async () => perform(ops.projectDirs(pr, [d.trim()], []))));
      } else if (row?.kind === "dir" && str === "x") {
        await attempt(async () => perform(ops.projectDirs(pr, [], [row.dir])));
      } else if (row?.kind === "share" && (name === "space" || name === "return")) {
        await attempt(async () => perform(ops.setAccess(row.id, nextRule(state.projects[pr]?.access.agents[row.id]), pr)));
      } else if (row?.kind === "shareGroup" && (name === "space" || name === "return")) {
        await attempt(async () => perform(ops.setAccess(`group:${row.id}`, nextRule(state.projects[pr]?.access.groups[row.id]), pr)));
      }
    } else if (str === "c") {
      prompt("接続する相手の Agent ID", "", (id) => prompt("この人の呼び名", "", (n) => attempt(async () => perform(ops.connect(id.trim(), n)))));
    } else if (str === "g") {
      prompt("新しいグループの名前", "", (n) => attempt(async () => perform(ops.groupCreate(freeGroupId(), n))));
    } else if (row?.kind === "request") {
      if (str === "a") prompt("この人の呼び名", "", (n) => attempt(async () => perform(ops.accept(row.id, n))));
      else if (str === "r") await attempt(async () => perform(ops.reject(row.id), { destructive: true }));
      else if (str === "b") await attempt(async () => perform(ops.disconnect(row.id, { block: true }), { destructive: true }));
    } else if (row?.kind === "contact" || row?.kind === "unnamed") {
      if (str === "n") prompt("呼び名", state.contacts[row.id]?.name ?? "", (n) => attempt(async () => perform(ops.rename(row.id, n))));
      else if (str === "x") await attempt(async () => perform(ops.disconnect(row.id), { destructive: true }));
      else if (str === "b") await attempt(async () => perform(ops.disconnect(row.id, { block: true }), { destructive: true }));
    } else if (row?.kind === "outgoing") {
      if (str === "x") await attempt(async () => perform(ops.disconnect(row.id), { destructive: true }));
    } else if (row?.kind === "group") {
      if (str === "m" || name === "return") mode = { kind: "members", groupId: row.id, cursor: 0, selected: new Set(state.groups[row.id]?.members ?? []) };
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
      out.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
      message = "読み込んでいます";
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
    /** 最後に描いた画面（色を除いたもの。テスト用） */
    screen: () => lastScreen,
    /** 端末の大きさが変わったときに描き直す */
    render: () => render(),
    close,
  };
}

export async function runRelayTui(opts: TuiOptions): Promise<void> {
  if (!opts.input && !(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new Error("souieba relay ui は端末で実行してください（主人が自分で操作する画面です。エージェントは souieba relay の各コマンドを使います）");
  }
  const ui = createRelayTui(opts);
  const onResize = () => ui.render();
  process.stdout.on("resize", onResize);
  try {
    await ui.start();
  } finally {
    process.stdout.off("resize", onResize);
  }
}
