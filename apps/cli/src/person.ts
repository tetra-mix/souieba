/**
 * souieba init / souieba device: v2 の人（Person 鍵）と端末（エージェントごとの鍵）を作る・足す・取り消す（docs/v2-design.md §4）。
 *
 * - init: Person 鍵と最初の端末を作り、Relay に登録する。--from <2.0.0 の Agent 名> なら、その Agent の設定（プロジェクト・グループ・方針・任せた範囲）を移す
 * - device add: この PC に端末（エージェント）を足す。Person 鍵で端末証明書に署名する
 * - device revoke: 端末を取り消す（Person 鍵で署名した取り消しを Relay に置く。友人の Client はその端末に送らなくなる）
 * 端末の名前は手元だけのもので、Relay にも友人にも送らない。
 * ほかの PC の端末を足す（device link）は今後。Person 鍵はこの PC にだけある。
 */
import { join } from "node:path";
import {
  type DeviceIdentity,
  type PersonKeys,
  certifyDevice,
  generateDevice,
  generatePerson,
  isValidDisplayName,
  revokeDevice,
} from "@souieba/core";
import {
  type ClientConfig,
  type DeviceEntry,
  RelayHttp,
  RelayStateStore,
  agentNameTaken,
  deviceDir,
  loadClientConfig,
  migrateAgentState,
  personDir,
  readStateJson,
  resolveRelayAgent,
  saveClientConfig,
  souiebaHome,
} from "@souieba/sdk";
import { CLI_VERSION } from "./version.ts";

export type PersonIo = { log: (line: string) => void; now: () => Date };

export const DEVICE_USAGE = `使い方: souieba device <command>（v2: この PC のエージェントごとの端末）
  list                    端末の一覧（名前は手元だけのもので、友人には見えません）
  add <名前>              端末を足す（エージェントを足したとき。--agent <名前> か SOUIEBA_AGENT=<名前> で選ぶ）
  revoke <名前>           端末を取り消す（その端末の鍵では、もう近況を受け取れません）
  link                    （今後）ほかの PC の端末を足す`;

/** セッショントークンを平文で流さないよう、http は手元で動かす開発用（localhost / 127.0.0.1）だけにする */
function relayOrigin(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && (host === "localhost" || host === "127.0.0.1" || host === "::1"))) {
    throw new Error("Relay の URL は https にしてください（http は手元で動かす開発用の localhost / 127.0.0.1 だけ）");
  }
  return parsed.origin;
}

function requireDeviceName(cfg: ClientConfig, name: string, allowLegacy?: string): string {
  const n = name.trim();
  if (!isValidDisplayName(n)) throw new Error("端末の名前は1〜40文字で、日本語・英数字・一部の記号だけにしてください");
  // 2.0.0 の Agent から移すときは、同じ名前のまま使える（SOUIEBA_AGENT を変えずに済むように）
  const legacyOnly = allowLegacy === n && !(n in cfg.agents) && !(n in (cfg.person?.devices ?? {}));
  if (!legacyOnly && agentNameTaken(cfg, n)) throw new Error(`「${n}」はほかの Agent か端末の名前です。--name で別の名前にしてください`);
  return n;
}

function newDevice(person: PersonKeys, now: Date): DeviceIdentity & { entry: DeviceEntry } {
  const d = generateDevice(person.personId, now.toISOString());
  const cert = certifyDevice(person, d);
  return { ...d, cert, entry: { deviceId: d.deviceId, sign: d.sign, enc: d.enc, encKeyVersion: d.encKeyVersion, createdAt: d.createdAt, cert } };
}

function personKeys(cfg: ClientConfig): PersonKeys {
  const p = cfg.person;
  if (!p) throw new Error("v2 の ID がまだありません。souieba init <Relay の URL> を実行してください");
  if (!p.person.priv) throw new Error("この PC には Person 鍵がありません（端末を足せるのは、最初に souieba init した PC だけです）");
  return { personId: p.personId, person: { pub: p.person.pub, priv: p.person.priv } };
}

/** souieba init <Relay の URL> [--name <端末名>] [--from <2.0.0 の Agent 名>] */
export async function initCommand(a: { url?: string; name?: string; from?: string }, io: PersonIo): Promise<void> {
  const cfg = loadClientConfig();
  if (cfg.person) {
    throw new Error(`v2 の ID（${cfg.person.personId}）はもうあります。エージェントを足すときは souieba device add <名前> を使ってください`);
  }
  const legacy = a.from !== undefined ? cfg.relayAgents?.[a.from] : undefined;
  if (a.from !== undefined && !legacy) {
    const names = Object.keys(cfg.relayAgents ?? {});
    throw new Error(`2.0.0 の v2 Agent「${a.from}」はありません${names.length ? `（あるもの: ${names.join(", ")}）` : ""}`);
  }
  const url = a.url ?? legacy?.relayUrl;
  if (!url) throw new Error("souieba init <Relay の URL> [--name <端末名>]（2.0.0 の Agent から移すときは --from <Agent名>）");
  const relayUrl = relayOrigin(url);
  const name = requireDeviceName(cfg, a.name ?? a.from ?? "relay", a.from);
  const now = io.now();
  const person = generatePerson();
  const dev = newDevice(person, now);
  const http = new RelayHttp({ relayUrl, device: dev, sessionPath: join(deviceDir(dev.deviceId), "relay-session.json"), clientVersion: CLI_VERSION, now: io.now });
  await http.register(person.person.pub);
  // 登録した鍵でセッションを得られるか（Relay の URL が正しいか）を確かめる
  await http.connections();

  // 2.0.0 の Agent の設定を移す（古いファイルは消さない）
  let migrated: ReturnType<typeof migrateAgentState> = null;
  if (legacy) {
    const raw = readStateJson<unknown>(join(souiebaHome(), "agents", legacy.agentId, "relay-state.json"));
    migrated = raw ? migrateAgentState(raw, now) : null;
    if (migrated) new RelayStateStore(personDir()).save(migrated.state);
  }

  cfg.person = {
    relayUrl,
    personId: person.personId,
    person: person.person,
    createdAt: now.toISOString(),
    devices: { [name]: dev.entry },
    ...(a.from !== undefined ? { migratedFrom: a.from } : {}),
  };
  saveClientConfig(cfg);
  io.log(`v2 の ID を作り、${relayUrl} に登録しました。`);
  io.log(`ID: ${person.personId}（この PC のどのエージェントでも同じです。友人にはこの ID を伝えます）`);
  io.log(`この端末の名前: ${name}（手元だけの名前です。友人には見えません。--agent ${JSON.stringify(name)} か SOUIEBA_AGENT で選びます）`);
  if (legacy) {
    io.log("");
    io.log(`2.0.0 の Agent「${a.from}」（${legacy.agentId}）から移しました。古い鍵とファイル（~/.souieba/agents/${legacy.agentId}/）は消していません。`);
    if (!migrated) io.log("（その Agent の設定ファイルが見つからなかったので、設定は移していません）");
    else {
      const projects = Object.keys(migrated.state.projects).filter((p) => p !== "default");
      io.log(`移した設定: プロジェクト ${projects.length ? projects.join("、") : "なし"}・グループ ${Object.keys(migrated.state.groups).length} 個・共有方針・任せた範囲 ${migrated.state.delegations?.length ?? 0} 件`);
      for (const d of migrated.dropped) io.log(`移せなかったもの: ${d}`);
      if (migrated.oldContacts.length) {
        io.log("ID が変わったので、次の相手とは接続し直してください（相手も souieba 2.1.0 で init し、新しい ID を伝え合います）:");
        for (const c of migrated.oldContacts) io.log(`  - ${c.name}（古い ID: ${c.agentId}）`);
      }
    }
    io.log("まだ送っていない 2.0.0 のメモは移していません。");
  } else if (Object.keys(cfg.relayAgents ?? {}).length > 0) {
    io.log("（2.0.0 の v2 Agent の設定は移していません。移したいときは、~/.souieba/config.json の person を消してから souieba init --from <Agent名> で作り直せます）");
  }
  io.log("次に:");
  io.log("  1. 友人と ID を伝え合い、souieba relay connect <相手の ID> --name <呼び名> で接続を要求する（相手が承認すると接続）");
  io.log("  2. 共有してよい相手を決める: souieba relay allow <呼び名>（既定はすべて禁止）");
  io.log("  3. ほかのエージェントも使うなら: souieba device add <名前>（同じ ID のまま、エージェントごとに鍵を分けます）");
  io.log("souieba relay ui で、これらを画面で見ながら設定することもできます。");
}

export async function deviceCommand(a: { sub?: string; rest: string[] }, io: PersonIo): Promise<void> {
  const cfg = loadClientConfig();
  switch (a.sub) {
    case undefined:
    case "help":
      io.log(DEVICE_USAGE);
      return;
    case "list": {
      const p = cfg.person;
      if (!p) throw new Error("v2 の ID がまだありません。souieba init <Relay の URL> を実行してください");
      let current: string | null = null;
      try {
        current = resolveRelayAgent()?.name ?? null;
      } catch {
        // 選べなくても一覧は出す
      }
      io.log(`ID: ${p.personId}（Relay: ${p.relayUrl}）`);
      for (const [n, d] of Object.entries(p.devices)) {
        io.log(`- ${n}${n === current ? "（この端末）" : ""}  ${d.deviceId.slice(0, 12)}…  ${d.createdAt} に追加${d.revokedAt ? `  取り消し済み（${d.revokedAt}）` : ""}`);
      }
      io.log("（端末の名前は手元だけのものです。友人には、あなたの ID と、端末があることだけが見えます）");
      return;
    }
    case "add":
      for (const l of await addDevice(a.rest.join(" "), io.now)) io.log(l);
      return;
    case "revoke":
      for (const l of await revokeDeviceNamed(a.rest.join(" "), io.now)) io.log(l);
      return;
    case "link":
      io.log("ほかの PC の端末を足す（device link）は、まだできません（今後の予定です）。今は Person 鍵がこの PC にだけあり、端末を足せるのもこの PC だけです。");
      return;
    default:
      throw new Error(`不明なコマンドです: device ${a.sub}\n${DEVICE_USAGE}`);
  }
}

/** 端末を足す（CLI と TUI）。結果の文を返す */
export async function addDevice(rawName: string, now: () => Date): Promise<string[]> {
  const cfg = loadClientConfig();
  const person = personKeys(cfg);
  const name = requireDeviceName(cfg, rawName);
  const dev = newDevice(person, now());
  const http = new RelayHttp({ relayUrl: cfg.person!.relayUrl, device: dev, sessionPath: join(deviceDir(dev.deviceId), "relay-session.json"), clientVersion: CLI_VERSION, now });
  await http.register(person.person.pub);
  cfg.person!.devices[name] = dev.entry;
  saveClientConfig(cfg);
  return [
    `端末「${name}」を足しました（同じ ID のまま、この端末の鍵で送受信します）。`,
    `このエージェントでは --agent ${JSON.stringify(name)} か SOUIEBA_AGENT=${JSON.stringify(name)} で選びます。連絡先・プロジェクト・メモはこの PC のほかの端末と共有します。`,
  ];
}

/** 端末を取り消す（CLI と TUI）。Person 鍵で署名した取り消しを Relay に置く。結果の文を返す */
export async function revokeDeviceNamed(name: string, now: () => Date): Promise<string[]> {
  const cfg = loadClientConfig();
  const person = personKeys(cfg);
  const d = cfg.person!.devices[name];
  if (!d) throw new Error(`端末「${name}」はありません（souieba device list で確かめられます）`);
  if (d.revokedAt) throw new Error(`端末「${name}」はもう取り消してあります`);
  const at = now().toISOString();
  // 取り消しは Person 鍵の署名で通るので、取り消す端末自身のセッションは要らない
  const http = new RelayHttp({ relayUrl: cfg.person!.relayUrl, device: { ...d, personId: person.personId }, clientVersion: CLI_VERSION, now });
  await http.revoke(revokeDevice(person, d.deviceId, at));
  d.revokedAt = at;
  saveClientConfig(cfg);
  const out = [`端末「${name}」を取り消しました。友人の Client は、次に近況を送るときから、この端末には鍵を包みません。`];
  if (!Object.values(cfg.person!.devices).some((x) => !x.revokedAt)) out.push("使える端末がなくなりました。souieba device add <名前> で足してください。");
  return out;
}
