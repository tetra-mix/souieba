/**
 * v2（Relay）の設定と確認のコマンド（souieba relay ...）。docs/v2-design.md §14・docs/v2-relay-plan.md
 *
 * ユーザー操作は原則として既存の LLM を通して行う（§1.1）。確認系のコマンドはエージェントがそのまま実行してよい。
 * 共有の境界を変えるコマンド（接続・承認・グループ・アクセス権限・Policy）は、エージェントが自分の判断で変えないよう（§6.2・§7.1）、
 * ターミナルで主人が「y」と答えたときだけ実行する。エージェントが（端末のない）シェルから呼ぶと、主人に実行を頼む案内を出して止まる。
 * これはエージェントの暴走を防ぐ柵で、同じユーザー権限で動くプログラムへのセキュリティ境界ではない（設定ファイルは同じユーザーが書ける）。
 */
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  type RelayIdentity,
  generateRelayIdentity,
  isAgentId,
  isValidDisplayName,
} from "@souieba/core";
import {
  type AccessRule,
  type Contact,
  MAX_LOCAL_GROUPS,
  MAX_POLICY_LENGTH,
  RelayHttp,
  RelayInboxStore,
  type RelayState,
  RelayStateError,
  RelayStateStore,
  RelayTransport,
  type ResolvedRelayAgent,
  accessFor,
  agentNameTaken,
  findContact,
  findGroup,
  isGroupId,
  loadClientConfig,
  requireContactName,
  resolveRelayAgent,
  saveClientConfig,
  souiebaHome,
} from "@souieba/sdk";
import { CLI_VERSION } from "./version.ts";

export type RelayIo = {
  log: (line: string) => void;
  /** 共有の境界を変える前に、主人に確かめる。false なら実行しない */
  confirm: (summary: string, command: string) => Promise<boolean>;
  now: () => Date;
};

/** 主人が端末で操作していないときに投げる。エージェントへの案内つき */
export class NeedsOwnerError extends Error {}

/** 端末で主人に y/N を聞く。端末がなければ（エージェントが実行した）主人に頼む案内を出して止める */
export async function ttyConfirm(summary: string, command: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new NeedsOwnerError(
      `souieba: この操作（${summary}）は主人の確認が必要なので、エージェントからは実行できません。` +
        `主人に、ターミナルで次のコマンドを実行するよう伝えてください（あなたが別の方法で実行してはいけません）:\n  ${command}`,
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${summary}\nよろしいですか？ [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export const RELAY_USAGE = `使い方: souieba relay <command>（v2: Relay 経由で、エージェントごとの鍵で共有する）

  init <Relay の URL> [--name <Agent名>]   Identity を作って Relay に登録する（初回セットアップ）
  id                                      自分の Agent ID（友人に伝えて、接続してもらう）
  lookup <Agent ID>                       Agent ID が Relay にあるかを確かめる
  contacts                                接続済みの相手・届いた接続要求・送った接続要求
  status                                  設定の一覧（連絡先・グループ・アクセス権限・Policy）
  inbox                                   受け取った近況（利用期限内）
  sent                                    送った近況の配送状態

主人の確認が必要（ターミナルで y と答える。エージェントは実行できません）:
  connect <Agent ID> --name <呼び名>      接続を要求する（相手が承認すると接続になる）
  accept <Agent ID> --name <呼び名>       届いた接続要求を承認する
  reject <Agent ID>                       届いた接続要求を断る
  rename <相手> <新しい呼び名>            呼び名を変える（呼び名のない接続済みの相手に付けるのにも使う）
  disconnect <相手> | block <相手> | unblock <Agent ID>
  groups [list] | groups create <ID> <名前> | groups add <グループ> <相手...> | groups remove <グループ> <相手...> | groups delete <グループ>
  allow <相手|group:<グループ>> | deny <相手|group:<グループ>> | unset <相手|group:<グループ>>
                                          共有してよいか（既定はすべて禁止。個人の設定はグループより優先、グループ同士は deny が優先）
  policy | policy set <方針の文章> | policy clear
                                          共有方針（自然言語）。エージェントが投稿前に読んで判断する

<相手> は呼び名か Agent ID。<グループ> は ID か名前`;

function agentDir(agentId: string): string {
  return join(souiebaHome(), "agents", agentId);
}

function requireRelayAgent(name?: string): ResolvedRelayAgent {
  const r = resolveRelayAgent(name);
  if (!r) {
    const names = Object.keys(loadClientConfig().relayAgents ?? {});
    throw new Error(
      names.length === 0
        ? "v2 の Agent がありません。souieba relay init <Relay の URL> を実行してください"
        : `v2 の Agent を指定してください（--agent または環境変数 SOUIEBA_AGENT）。登録済み: ${names.join(", ")}`,
    );
  }
  return r;
}

export function relayParts(r: ResolvedRelayAgent, now: () => Date) {
  const dir = agentDir(r.identity.agentId);
  const http = new RelayHttp({
    relayUrl: r.relayUrl,
    identity: r.identity,
    sessionPath: join(dir, "relay-session.json"),
    clientVersion: CLI_VERSION,
    now,
  });
  const state = new RelayStateStore(dir);
  const inbox = new RelayInboxStore(dir);
  return { dir, http, state, inbox, transport: (opts: Partial<ConstructorParameters<typeof RelayTransport>[0]> = {}) => new RelayTransport({ http, identity: r.identity, state, inbox, now, ...opts }) };
}

const short = (id: string) => `${id.slice(0, 10)}…`;

function who(state: RelayState, id: string): string {
  const c = state.contacts[id];
  return c ? `${c.name}（${id}）` : id;
}

function requireContact(state: RelayState, ref: string | undefined): Contact {
  if (!ref) throw new Error("相手（呼び名か Agent ID）を指定してください");
  const c = findContact(state, ref);
  if (!c) throw new Error(`連絡先に「${ref}」がありません（souieba relay contacts で確認できます）`);
  return c;
}

/** 実行するコマンドを、主人がそのまま貼れる形にする */
function commandLine(args: string[], agent: string | undefined): string {
  return ["souieba", "relay", ...args.map(shellQuote), ...(agent ? ["--agent", shellQuote(agent)] : [])].join(" ");
}

/** シェルで特別な意味を持つ文字があるときだけ、シングルクォートで囲む */
function shellQuote(a: string): string {
  return a.length > 0 && !/[\s'"$`\\!*?;&|<>(){}[\]#~=%]/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

export type RelayArgs = { sub: string | undefined; rest: string[]; name?: string; agent?: string; raw: string[] };

export async function relayCommand(a: RelayArgs, io: RelayIo): Promise<void> {
  const { sub, rest } = a;
  if (sub === undefined || sub === "help") {
    io.log(RELAY_USAGE);
    return;
  }
  if (sub === "init") return init(a, io);

  const r = requireRelayAgent(a.agent);
  const p = relayParts(r, io.now);
  const cmd = commandLine(a.raw, a.agent);
  const confirm = async (summary: string) => {
    if (!(await io.confirm(summary, cmd))) throw new Error("取りやめました");
  };
  // 相手が承認して接続になった人を連絡先に入れてから、呼び名で引けるようにする（通信できなければ手元のまま）
  if (["status", "rename", "disconnect", "block", "groups", "allow", "deny", "unset"].includes(sub)) {
    await p
      .transport()
      .syncContacts()
      .catch(() => {});
  }

  switch (sub) {
    case "id": {
      io.log(`Agent ID: ${r.identity.agentId}`);
      io.log(`Relay: ${r.relayUrl}`);
      io.log("友人にこの Agent ID を伝え、souieba relay connect <この ID> --name <呼び名> で接続を要求してもらってください。");
      io.log("（Agent ID は鍵から作るので、ID が合っていれば相手は本物の鍵で暗号化できます。ID は信頼できる経路で伝えてください）");
      return;
    }
    case "lookup": {
      const id = rest[0];
      if (!id || !isAgentId(id)) throw new Error("souieba relay lookup <Agent ID>");
      const [e] = await p.http.lookup([id]);
      io.log(e ? `${id} は登録されています（鍵の版 ${e.encKeyVersion}）` : `${id} は見つかりません`);
      return;
    }
    case "contacts": {
      const t = p.transport();
      const { connections } = await t.syncContacts();
      const s = p.state.load();
      const { blocked } = await p.http.connections();
      const by = (st: string) => connections.filter((c) => c.status === st);
      io.log("## 接続済み");
      for (const c of by("accepted")) {
        const contact = s.contacts[c.peer];
        io.log(`- ${contact ? contact.name : "（呼び名なし。souieba relay rename で付けてください）"}  ${c.peer}  共有: ${accessFor(s, c.peer).allowed ? "許可" : "禁止"}`);
      }
      io.log("## 届いた接続要求（承認: souieba relay accept <ID> --name <呼び名>）");
      for (const c of by("incoming")) io.log(`- ${c.peer}（${c.createdAt}）`);
      io.log("## 送った接続要求（相手の承認待ち）");
      for (const c of by("outgoing")) io.log(`- ${s.pendingNames[c.peer] ?? ""} ${c.peer}`);
      if (blocked.length) io.log(`## ブロック中\n${blocked.map((b) => `- ${b}`).join("\n")}`);
      return;
    }
    case "status": {
      const s = p.state.load();
      io.log(`Agent ID: ${r.identity.agentId}（${r.name}、Relay: ${r.relayUrl}）`);
      io.log(`連絡先: ${Object.values(s.contacts).map((c) => `${c.name}${accessFor(s, c.agentId).allowed ? "（共有可）" : ""}`).join("、") || "なし"}`);
      io.log(`グループ: ${Object.values(s.groups).map((g) => `${g.name}[${g.id}]（${g.members.length}人${s.access.groups[g.id] ? `、${s.access.groups[g.id]}` : ""}）`).join("、") || "なし"}`);
      const rules = Object.entries(s.access.agents).map(([id, rule]) => `${who(s, id)}: ${rule}`);
      io.log(`個人のアクセス権限: ${rules.join("、") || "なし"}`);
      io.log(`Policy: ${s.policy ? s.policy.text : "未設定（souieba relay policy set <方針> で設定）"}`);
      return;
    }
    case "inbox": {
      const t = p.transport();
      await t.sync().catch((err) => io.log(`（Relay から受け取れませんでした: ${err instanceof Error ? err.message : err}）`));
      const f = p.inbox.load();
      const s = p.state.load();
      if (f.items.length === 0) io.log("受け取った近況はありません");
      for (const i of f.items) {
        io.log(`- ${who(s, i.sender)} ${i.createdAt}: ${i.message.content}${i.toldAt ? "（伝えた）" : ""}（${i.message.useExpiresAt} まで）`);
      }
      return;
    }
    case "sent": {
      const s = p.state.load();
      const sent = await p.http.sent();
      if (sent.length === 0) io.log("配送期限内の送信はありません");
      for (const m of sent) {
        const st = m.recipients.map((x) => `${s.contacts[x.agentId]?.name ?? short(x.agentId)}: ${x.status === "delivered" ? "受信済み" : "未受信"}`);
        io.log(`- ${m.messageId} ${m.createdAt}（${m.visibleAt} から配送、${m.deliveryExpiresAt} まで）: ${st.join("、")}`);
      }
      return;
    }
    case "connect": {
      const id = rest[0];
      if (!id || !isAgentId(id)) throw new Error("souieba relay connect <Agent ID> --name <呼び名>");
      if (id === r.identity.agentId) throw new Error("自分自身には接続できません");
      const name = requireContactName(a.name ?? "");
      const [e] = await p.http.lookup([id]);
      if (!e) throw new Error(`${id} は Relay に登録されていません`);
      await confirm(`Agent ${id} に接続を要求し、呼び名を「${name}」にします（共有はまだ始まりません。共有するには allow が必要です）`);
      p.state.update((s) => void (s.pendingNames[id] = name));
      const c = await p.http.connect(id);
      await p.transport().syncContacts();
      io.log(c.status === "accepted" ? `「${name}」と接続しました` : `「${name}」に接続を要求しました。相手が承認すると接続になります`);
      return;
    }
    case "accept": {
      const id = rest[0];
      if (!id || !isAgentId(id)) throw new Error("souieba relay accept <Agent ID> --name <呼び名>");
      const name = requireContactName(a.name ?? "");
      await confirm(`Agent ${id} からの接続要求を承認し、呼び名を「${name}」にします（相手からの近況が届くようになります）`);
      p.state.update((s) => void (s.pendingNames[id] = name));
      await p.http.accept(id);
      await p.transport().syncContacts();
      io.log(`「${name}」と接続しました。こちらから近況を共有するには souieba relay allow ${commandArg(name)} が必要です`);
      return;
    }
    case "reject": {
      const id = rest[0];
      if (!id || !isAgentId(id)) throw new Error("souieba relay reject <Agent ID>");
      await confirm(`Agent ${id} からの接続要求を断ります`);
      await p.http.reject(id);
      io.log("断りました（相手には知らせません）");
      return;
    }
    case "rename": {
      const [ref, ...nameParts] = rest;
      const name = requireContactName(nameParts.join(" "));
      if (!ref) throw new Error("souieba relay rename <相手> <新しい呼び名>");
      const s = p.state.load();
      const c = findContact(s, ref);
      if (!c && !isAgentId(ref)) throw new Error(`連絡先に「${ref}」がありません`);
      const id = c?.agentId ?? ref;
      await confirm(`${who(s, id)} の呼び名を「${name}」にします`);
      p.state.update((st) => {
        if (st.contacts[id]) st.contacts[id]!.name = name;
        else st.pendingNames[id] = name;
      });
      if (!c) await p.transport().syncContacts();
      io.log(`呼び名を「${name}」にしました`);
      return;
    }
    case "disconnect":
    case "block": {
      const s = p.state.load();
      const ref = rest[0];
      const id = ref && isAgentId(ref) ? ref : requireContact(s, ref).agentId;
      await confirm(
        sub === "block"
          ? `${who(s, id)} をブロックします（接続を解除し、この相手からの接続要求も届かなくなります）`
          : `${who(s, id)} との接続を解除します（まだ届いていない近況は、どちら向きも届きません）`,
      );
      if (sub === "block") await p.http.block(id);
      else await p.http.disconnect(id);
      p.state.update((st) => forget(st, id));
      io.log(sub === "block" ? "ブロックしました" : "接続を解除しました");
      return;
    }
    case "unblock": {
      const id = rest[0];
      if (!id || !isAgentId(id)) throw new Error("souieba relay unblock <Agent ID>");
      await confirm(`${id} のブロックを解除します`);
      await p.http.unblock(id);
      io.log("ブロックを解除しました");
      return;
    }
    case "groups":
      return groups(a, io, p.state, confirm);
    case "allow":
    case "deny":
    case "unset": {
      const ref = rest[0];
      if (!ref) throw new Error(`souieba relay ${sub} <相手|group:<グループ>>`);
      const s = p.state.load();
      const g = ref.startsWith("group:") ? findGroup(s, ref) : undefined;
      if (ref.startsWith("group:") && !g) throw new Error(`グループ「${ref.slice(6)}」はありません`);
      const target = g ? `グループ「${g.name}」（${g.members.length}人）` : who(s, requireContact(s, ref).agentId);
      const verb = sub === "allow" ? "に近況を共有してよいことにします" : sub === "deny" ? "には近況を共有しないことにします" : "の個別の設定を消します";
      await confirm(`${target}${verb}`);
      p.state.update((st) => {
        const table = g ? st.access.groups : st.access.agents;
        const key = g ? g.id : requireContact(st, ref).agentId;
        if (sub === "unset") delete table[key];
        else table[key] = sub as AccessRule;
      });
      io.log(`${target}${verb.replace("ことにします", "ことにしました").replace("消します", "消しました")}`);
      return;
    }
    case "policy": {
      const s = p.state.load();
      const action = rest[0];
      if (action === undefined) {
        io.log(s.policy ? `共有方針（${s.policy.updatedAt} に設定）:\n${s.policy.text}` : "共有方針は未設定です");
        return;
      }
      if (action === "clear") {
        await confirm("共有方針を消します");
        p.state.update((st) => void (st.policy = null));
        io.log("共有方針を消しました");
        return;
      }
      if (action !== "set") throw new Error("souieba relay policy [set <方針> | clear]");
      const text = rest.slice(1).join(" ").trim();
      if (!text) throw new Error("souieba relay policy set <方針の文章>");
      if (text.length > MAX_POLICY_LENGTH) throw new Error(`共有方針は ${MAX_POLICY_LENGTH} 文字までにしてください`);
      await confirm(`共有方針を次の内容にします:\n  ${text}`);
      p.state.update((st) => void (st.policy = { text, updatedAt: io.now().toISOString() }));
      io.log("共有方針を設定しました。エージェントは投稿の前にこの方針を読んで判断します");
      return;
    }
    default:
      throw new Error(`不明なコマンドです: relay ${sub}\n${RELAY_USAGE}`);
  }
}

const commandArg = (s: string) => shellQuote(s);

/** 接続を解除・ブロックした相手を、連絡先・グループ・アクセス権限から外す */
function forget(s: RelayState, id: string): void {
  delete s.contacts[id];
  delete s.pendingNames[id];
  delete s.access.agents[id];
  for (const g of Object.values(s.groups)) g.members = g.members.filter((m) => m !== id);
}

async function init(a: RelayArgs, io: RelayIo): Promise<void> {
  const url = a.rest[0];
  if (!url) throw new Error("souieba relay init <Relay の URL> [--name <Agent名>]");
  const relayUrl = new URL(url).origin;
  const name = a.name ?? "relay";
  if (!isValidDisplayName(name)) throw new Error("Agent 名は1〜40文字で、日本語・英数字・一部の記号だけにしてください");
  const cfg = loadClientConfig();
  if (agentNameTaken(cfg, name)) throw new Error(`Agent「${name}」はすでにあります。--name で別の名前を指定してください`);
  const identity: RelayIdentity = generateRelayIdentity();
  const http = new RelayHttp({ relayUrl, identity, clientVersion: CLI_VERSION, now: io.now });
  await http.register();
  // 登録した鍵でセッションを得られるか（Relay の URL が正しいか）を確かめる
  await http.connections();
  cfg.relayAgents = {
    ...(cfg.relayAgents ?? {}),
    [name]: {
      relayUrl,
      agentId: identity.agentId,
      identity: identity.identity,
      enc: identity.enc,
      encKeyVersion: identity.encKeyVersion,
      createdAt: io.now().toISOString(),
    },
  };
  saveClientConfig(cfg);
  io.log(`v2 の Agent「${name}」を作り、${relayUrl} に登録しました。`);
  io.log(`Agent ID: ${identity.agentId}`);
  io.log("次に:");
  io.log("  1. 友人と Agent ID を伝え合い、souieba relay connect <相手の ID> --name <呼び名> で接続を要求する（相手が承認すると接続）");
  io.log("  2. 共有してよい相手を決める: souieba relay allow <呼び名> または groups create → allow group:<グループ>（既定はすべて禁止）");
  io.log("  3. 共有方針を決める: souieba relay policy set <方針>（例: 友達には最近の活動や趣味は話してよい。仕事の秘密や個人的な相談は共有しない）");
  io.log("この3つは主人の確認が必要なので、ターミナルで実行してください。");
}

async function groups(a: RelayArgs, io: RelayIo, store: RelayStateStore, confirm: (s: string) => Promise<void>): Promise<void> {
  const [action, ...args] = a.rest;
  const s = store.load();
  const resolveMembers = (refs: string[]) => refs.map((ref) => requireContact(s, ref));
  const requireGroup = (ref: string | undefined) => {
    const g = ref ? findGroup(s, ref) : undefined;
    if (!g) throw new Error(`グループ「${ref ?? ""}」はありません`);
    return g;
  };
  switch (action) {
    case undefined:
    case "list": {
      if (Object.keys(s.groups).length === 0) io.log("グループはありません");
      for (const g of Object.values(s.groups)) {
        io.log(`- ${g.name} [${g.id}]（共有: ${s.access.groups[g.id] ?? "未設定"}）: ${g.members.map((m) => s.contacts[m]?.name ?? short(m)).join("、") || "メンバーなし"}`);
      }
      return;
    }
    case "create": {
      const [id, ...nameParts] = args;
      const name = nameParts.join(" ").trim() || id;
      if (!id || !isGroupId(id)) throw new Error("souieba relay groups create <ID（英小文字・数字・-_）> <名前>");
      if (!name || !isValidDisplayName(name)) throw new Error("グループ名は1〜40文字で、日本語・英数字・一部の記号だけにしてください");
      if (s.groups[id]) throw new Error(`グループ「${id}」はすでにあります`);
      if (Object.keys(s.groups).length >= MAX_LOCAL_GROUPS) throw new Error(`グループは ${MAX_LOCAL_GROUPS} 個までです`);
      await confirm(`グループ「${name}」[${id}] を作ります（この PC だけのグループで、相手には共有されません）`);
      store.update((st) => void (st.groups[id] = { id, name, members: [], createdAt: io.now().toISOString() }));
      io.log(`グループ「${name}」を作りました。メンバーを足す: souieba relay groups add ${id} <相手...>`);
      return;
    }
    case "add":
    case "remove": {
      const g = requireGroup(args[0]);
      const members = resolveMembers(args.slice(1));
      if (members.length === 0) throw new Error(`souieba relay groups ${action} <グループ> <相手...>`);
      const names = members.map((m) => m.name).join("、");
      await confirm(
        action === "add"
          ? `グループ「${g.name}」に ${names} を加えます${s.access.groups[g.id] === "allow" ? "（このグループは共有が許可されているので、この人たちにも近況が届くようになります）" : ""}`
          : `グループ「${g.name}」から ${names} を外します`,
      );
      store.update((st) => {
        const grp = st.groups[g.id]!;
        const ids = members.map((m) => m.agentId);
        grp.members = action === "add" ? [...new Set([...grp.members, ...ids])] : grp.members.filter((m) => !ids.includes(m));
      });
      io.log(action === "add" ? `${names} を加えました` : `${names} を外しました`);
      return;
    }
    case "delete": {
      const g = requireGroup(args[0]);
      await confirm(`グループ「${g.name}」を消します（このグループへの共有の設定も消えます）`);
      store.update((st) => {
        delete st.groups[g.id];
        delete st.access.groups[g.id];
      });
      io.log(`グループ「${g.name}」を消しました`);
      return;
    }
    default:
      throw new RelayStateError("souieba relay groups [list | create | add | remove | delete]");
  }
}
