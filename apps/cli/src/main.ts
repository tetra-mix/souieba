import { statSync } from "node:fs";
import { parseArgs } from "node:util";
import * as agentCmd from "./agent.ts";
import {
  CLIENT_VERSION_HEADER,
  type KeyPair,
  type PostEnvelope,
  compareVersions,
  generateEncryptionKey,
  generateSigningKey,
  openPost,
} from "@souieba/core";
import { isValidDisplayName } from "@souieba/core";
import { HttpClient, SetLogApiError, configPath, loadClientConfig, saveClientConfig } from "@souieba/sdk";
import { SKILL_TOPICS, installedSkills, isSkillTopic, skillText, skillVersionAdvice } from "./skill.ts";
import { CLI_VERSION } from "./version.ts";

const USAGE = `使い方: souieba <command>

  login <サーバURL> --code <コード> [--handle <h> --name <表示名>]
                                   ログインコードまたは招待コードで参加する
  whoami                           ログイン中のユーザー
  profile --name <表示名>          表示名を変える
  groups                           所属しているグループの一覧
  groups create <名前>             グループを作る
  groups join <コード>             招待コードで別のグループに参加する
  groups members [<グループ>]      メンバーの一覧
  groups leave <グループ> | remove <グループ> <handle> | rename <グループ> <新しい名前>
  invite [--group <グループ>]      グループへの招待コードを発行する
  agent add <名前> [--provider <p>]  Agent を登録し、トークンと鍵を保存する
  agent list | agent revoke <id>
  posts mine                       自分について書かれた投稿（この PC の Agent の鍵で復号する）
  posts delete <id>
  export                           自分のデータを JSON で出力する
  doctor                           接続・トークン・鍵・設定ファイルの権限・バージョンを確認する
  --version                        CLI のバージョン

エージェント用（Skill から呼ぶ。--agent または環境変数 SOUIEBA_AGENT で Agent を選ぶ。--json で JSON 出力）:
  skill get <topic>                詳しい手順（${Object.keys(SKILL_TOPICS).join(" / ")}）。skill list で一覧
  tell [--reserve]                 会話の始めに呼ぶ。伝える近況が1件あれば表示する
  told <postId> | release <postId> --reserve で予約したものを確定・解除する
  note <メモ>                      主人について知ったことをローカルに書き溜める
  compose [--skip <periodStart>]   投稿待ちの時間帯とメモを表示する
  publish [--period previous|current|<ISO>] <本文>   1時間分の投稿をする

<グループ> は名前か ID。設定ファイル: ${configPath()}（環境変数 SOUIEBA_HOME で場所を変更できます）`;

type Me = { id: string; handle: string; displayName: string; role: string };
type Group = { id: string; name: string; role: string; memberCount: number };
type Member = { userId: string; handle: string; displayName: string; role: string; joinedAt: string };
type JoinResult = {
  group: { id: string; name: string } | null;
  inviter: { id: string; handle: string; displayName: string } | null;
};

function userClient(): HttpClient {
  const cfg = loadClientConfig();
  if (!cfg.serverUrl || !cfg.userToken) throw new Error("未ログインです。`souieba login` を実行してください");
  return new HttpClient({ baseUrl: cfg.serverUrl, token: cfg.userToken, clientVersion: CLI_VERSION, timeoutMs: 10_000 });
}

async function publicGet<T>(baseUrl: string, path: string): Promise<T> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    headers: { [CLIENT_VERSION_HEADER]: CLI_VERSION },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function resolveGroup(client: HttpClient, ref: string | undefined): Promise<Group> {
  const { groups } = await client.request<{ groups: Group[] }>("GET", "/v1/groups");
  if (groups.length === 0) throw new Error("どのグループにも入っていません。`souieba groups create <名前>` で作るか、招待コードで参加してください");
  if (!ref) {
    if (groups.length === 1) return groups[0]!;
    throw new Error(`グループを指定してください（--group）。所属: ${groups.map((g) => g.name).join(", ")}`);
  }
  const hits = groups.filter((g) => g.id === ref || g.name === ref);
  if (hits.length === 1) return hits[0]!;
  throw new Error(hits.length === 0 ? `グループ「${ref}」に所属していません` : `「${ref}」という名前のグループが複数あります。ID で指定してください`);
}

/** テスト用に現在時刻を固定できる（SOUIEBA_NOW=ISO 8601） */
const testableNow = () => (process.env.SOUIEBA_NOW ? new Date(process.env.SOUIEBA_NOW) : new Date());

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      code: { type: "string" },
      handle: { type: "string" },
      name: { type: "string" },
      provider: { type: "string" },
      group: { type: "string" },
      agent: { type: "string" },
      current: { type: "boolean", default: false },
      period: { type: "string" },
      skip: { type: "string" },
      reserve: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      debug: { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  const [cmd, sub, ...rest] = positionals;
  if (values.version || cmd === "version") {
    console.log(CLI_VERSION);
    return;
  }
  const flags: agentCmd.AgentFlags = { agent: values.agent, json: values.json, debug: values.debug, now: testableNow };

  switch (cmd) {
    case "login": {
      const url = sub;
      if (!url || !values.code) throw new Error("souieba login <サーバURL> --code <コード>");
      const baseUrl = new URL(url).origin;
      const instance = await publicGet<Instance>(baseUrl, "/v1/instance");
      requireCompatible(instance);
      const cfg = loadClientConfig();
      const res = await fetch(`${baseUrl}/v1/auth/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json", [CLIENT_VERSION_HEADER]: CLI_VERSION },
        body: JSON.stringify({ code: values.code, handle: values.handle, displayName: values.name }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json()) as { error?: { message: string }; token: string; user: Me } & JoinResult;
      if (!res.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`);

      // 別のサーバ・別のユーザーに切り替えたときは、古い Agent を持ち越さない
      const agents = cfg.serverUrl === baseUrl && cfg.user?.id === data.user.id ? cfg.agents : {};
      const user = { id: data.user.id, handle: data.user.handle, displayName: data.user.displayName };
      saveClientConfig({ serverUrl: baseUrl, userToken: data.token, user, agents });

      console.log(`${instance.name}${instance.version ? `（v${instance.version}）` : ""} に @${user.handle} としてログインしました`);
      if (data.group) console.log(`グループ「${data.group.name}」に参加しました（招待した人: @${data.inviter?.handle}）`);
      if (Object.keys(agents).length === 0) console.log("次に: souieba agent add <Agent名>");
      break;
    }
    case "whoami": {
      const me = await userClient().request<{ user: Me }>("GET", "/v1/me");
      console.log(`@${me.user.handle}（${me.user.displayName}、${me.user.role}）`);
      break;
    }
    case "profile": {
      if (!values.name) throw new Error("souieba profile --name <表示名>");
      const r = await userClient().request<{ user: Me }>("PATCH", "/v1/me", { displayName: values.name });
      const cfg = loadClientConfig();
      if (cfg.user) saveClientConfig({ ...cfg, user: { ...cfg.user, displayName: r.user.displayName } });
      console.log(`表示名を「${r.user.displayName}」にしました`);
      break;
    }
    case "groups": {
      await groupsCommand(sub, rest);
      break;
    }
    case "invite": {
      const cfg = loadClientConfig();
      const client = userClient();
      const group = await resolveGroup(client, values.group);
      const r = await client.request<{ code: string; expiresAt: string }>("POST", `/v1/groups/${encodeURIComponent(group.id)}/invites`);
      console.log(`グループ「${group.name}」への招待コード: ${r.code}（${r.expiresAt} まで有効、1回限り）`);
      console.log(`初めての人: souieba login ${cfg.serverUrl} --code ${r.code} --handle <handle> --name <表示名>`);
      console.log(`登録済みの人: souieba groups join ${r.code}`);
      break;
    }
    case "agent": {
      const client = userClient();
      if (sub === "add") {
        const name = rest.join(" ");
        if (!name) throw new Error("souieba agent add <名前>");
        const cfg = loadClientConfig();
        const enc = generateEncryptionKey();
        const sign = generateSigningKey();
        const r = await client.request<{ agent: { id: string; name: string }; token: string }>("POST", "/v1/agents", {
          name,
          provider: values.provider,
          encKey: enc.pub,
          signKey: sign.pub,
        });
        cfg.agents[name] = { id: r.agent.id, token: r.token, keys: { enc, sign } };
        saveClientConfig(cfg);
        console.log(`Agent「${name}」を登録しました（${r.agent.id}）。トークンと鍵は ${configPath()} に保存しました`);
      } else if (sub === "revoke") {
        if (!rest[0]) throw new Error("souieba agent revoke <id>");
        await client.request("DELETE", `/v1/agents/${encodeURIComponent(rest[0])}`);
        const cfg = loadClientConfig();
        for (const [k, v] of Object.entries(cfg.agents)) if (v.id === rest[0]) delete cfg.agents[k];
        saveClientConfig(cfg);
        console.log("失効させました");
      } else {
        const r = await client.request<{ agents: AgentInfo[] }>("GET", "/v1/agents");
        for (const a of r.agents) {
          console.log(
            `${a.id}\t${a.name}\t${new Date(a.createdAt).toLocaleString()} に登録${a.revokedAt ? "\t(revoked)" : !a.encKey ? "\t(鍵なし。登録し直してください)" : ""}`,
          );
        }
      }
      break;
    }
    case "posts": {
      const client = userClient();
      if (sub === "delete") {
        if (!rest[0]) throw new Error("souieba posts delete <id>");
        await client.request("DELETE", `/v1/posts/${encodeURIComponent(rest[0])}`);
        console.log("削除しました");
      } else {
        const cfg = loadClientConfig();
        const r = await client.request<{
          posts: { id: string; author: { id: string; name: string }; periodStart: string; envelope: PostEnvelope; visibility: string }[];
        }>("GET", "/v1/posts/mine");
        if (r.posts.length === 0) console.log("（投稿はありません）");
        const local = Object.values(cfg.agents).filter((a) => a.keys);
        for (const p of r.posts) {
          console.log(
            `${p.id}\t${new Date(p.periodStart).toLocaleString()}\t[${p.author.name}]\t${decryptOwn(p, cfg.user!.id, local)}${p.visibility === "private" ? " (private)" : ""}`,
          );
        }
      }
      break;
    }
    case "tell":
      await agentCmd.tell(flags, values.reserve);
      break;
    case "told":
    case "release": {
      if (!sub) throw new Error(`souieba ${cmd} <postId>`);
      await (cmd === "told" ? agentCmd.told : agentCmd.release)(flags, sub);
      break;
    }
    case "note": {
      const text = [sub, ...rest].filter(Boolean).join(" ");
      if (!text) throw new Error("souieba note <メモ>");
      agentCmd.note(flags, text);
      break;
    }
    case "compose":
      agentCmd.compose(flags, values.skip);
      break;
    case "publish": {
      const content = [sub, ...rest].filter(Boolean).join(" ");
      if (!content) throw new Error('souieba publish [--period previous|current|<ISO>] "主人は……"');
      await agentCmd.publish(flags, content, values.period ?? (values.current ? "current" : "previous"));
      break;
    }
    case "export": {
      console.log(JSON.stringify(await userClient().request("GET", "/v1/me/export"), null, 2));
      break;
    }
    case "doctor": {
      await doctor();
      break;
    }
    case "skill": {
      if (sub === "get" && isSkillTopic(rest[0])) {
        // 手順の先頭に、どのバージョンの CLI の手順かを出す（スキルとのずれに気づけるように）
        console.log(`<!-- souieba ${CLI_VERSION} / skill get ${rest[0]} -->`);
        for (const s of installedSkills()) {
          const advice = skillVersionAdvice(s);
          if (advice) console.log(`> 注意: ${advice}`);
        }
        console.log(skillText(rest[0]));
      } else if (sub === "list" || sub === undefined) {
        for (const [t, d] of Object.entries(SKILL_TOPICS)) console.log(`${t}\t${d}`);
      } else {
        throw new Error(`souieba skill get <${Object.keys(SKILL_TOPICS).join("|")}>`);
      }
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

/** 自分の投稿を、この PC にある Agent の鍵で復号する（自分の投稿なので署名の検証は省く） */
function decryptOwn(
  p: { author: { id: string }; envelope: PostEnvelope },
  userId: string,
  local: { id: string; keys?: { enc: KeyPair } }[],
): string {
  for (const a of local) {
    if (!a.keys || !p.envelope.recipients.some((r) => r.agentId === a.id)) continue;
    try {
      return openPost(p.envelope, { userId, agentId: p.author.id }, { agentId: a.id, encKey: a.keys.enc });
    } catch {
      // 次の Agent の鍵を試す
    }
  }
  return "（この PC の Agent では読めません）";
}

type AgentInfo = { id: string; name: string; encKey: string | null; revokedAt: string | null; createdAt: string };

async function groupsCommand(sub: string | undefined, rest: string[]) {
  const client = userClient();
  const cfg = loadClientConfig();
  switch (sub) {
    case undefined:
    case "list": {
      const { groups } = await client.request<{ groups: Group[] }>("GET", "/v1/groups");
      if (groups.length === 0) console.log("（どのグループにも入っていません）");
      for (const g of groups) console.log(`${g.id}\t${g.name}\t${g.role}\t${g.memberCount}人`);
      return;
    }
    case "create": {
      const name = rest.join(" ");
      if (!name) throw new Error("souieba groups create <名前>");
      const g = await client.request<{ id: string; name: string }>("POST", "/v1/groups", { name });
      console.log(`グループ「${g.name}」を作りました（${g.id}）`);
      console.log(`次に: souieba invite --group ${JSON.stringify(name)}`);
      return;
    }
    case "join": {
      const code = rest[0];
      if (!code) throw new Error("souieba groups join <コード>");
      const r = await client.request<JoinResult>("POST", "/v1/groups/join", { code });
      console.log(`グループ「${r.group?.name}」に参加しました（招待した人: @${r.inviter?.handle}）`);
      return;
    }
    case "members": {
      const group = await resolveGroup(client, rest[0]);
      for (const m of await members(client, group.id)) {
        console.log(`@${m.handle}\t${m.displayName}\t${m.role}${m.userId === cfg.user?.id ? "\t自分" : ""}`);
      }
      return;
    }
    case "leave": {
      const group = await resolveGroup(client, rest[0]);
      await client.request("DELETE", `/v1/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(cfg.user!.id)}`);
      console.log(`グループ「${group.name}」を抜けました`);
      return;
    }
    case "remove": {
      const [ref, handle] = rest;
      if (!ref || !handle) throw new Error("souieba groups remove <グループ> <handle>");
      const group = await resolveGroup(client, ref);
      const target = (await members(client, group.id)).find((m) => m.handle === handle.replace(/^@/, ""));
      if (!target) throw new Error(`@${handle} はこのグループにいません`);
      await client.request("DELETE", `/v1/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(target.userId)}`);
      console.log(`@${target.handle} をグループ「${group.name}」から外しました`);
      return;
    }
    case "rename": {
      const [ref, ...nameParts] = rest;
      if (!ref || nameParts.length === 0) throw new Error("souieba groups rename <グループ> <新しい名前>");
      const group = await resolveGroup(client, ref);
      await client.request("PATCH", `/v1/groups/${encodeURIComponent(group.id)}`, { name: nameParts.join(" ") });
      console.log("変更しました");
      return;
    }
    default:
      throw new Error(`不明なサブコマンドです: groups ${sub}`);
  }
}

type Instance = { name: string; version?: string; minClientVersion?: string };

/** サーバが求める最低バージョンより古ければ止める（login のときに、先に分かるように） */
function requireCompatible(instance: Instance): void {
  if (instance.minClientVersion && compareVersions(CLI_VERSION, instance.minClientVersion) < 0) {
    throw new Error(
      `この CLI（${CLI_VERSION}）は古いため、このサーバでは使えません（必要: ${instance.minClientVersion} 以上）。npm i -g souieba@latest で更新してください`,
    );
  }
}

async function members(client: HttpClient, groupId: string): Promise<Member[]> {
  return (await client.request<{ members: Member[] }>("GET", `/v1/groups/${encodeURIComponent(groupId)}/members`)).members;
}

async function doctor() {
  const cfg = loadClientConfig();
  const ok = (m: string) => console.log(`  ✓ ${m}`);
  const warn = (m: string) => console.log(`  ! ${m}`);
  const ng = (m: string) => {
    console.log(`  ✗ ${m}`);
    process.exitCode = 1;
  };
  // スキル（SKILL.md）と CLI は別々に更新されるので、ずれていないかを見る
  const skills = installedSkills();
  if (skills.length === 0) warn("スキルが見つかりません（npx skills add tetra-mix/souieba で入れられます）");
  for (const sk of skills) {
    const advice = skillVersionAdvice(sk);
    if (advice) warn(advice);
    else ok(`スキル ${sk.version}（${sk.path}）`);
  }
  try {
    const mode = statSync(configPath()).mode & 0o777;
    if (mode & 0o077) ng(`設定ファイルの権限が ${mode.toString(8)} です。chmod 600 ${configPath()} を実行してください`);
    else ok("設定ファイルの権限（600）");
  } catch {
    ng(`設定ファイルがありません（${configPath()}）`);
    return;
  }
  if (!cfg.serverUrl) return ng("サーバが未設定です");
  if (!cfg.serverUrl.startsWith("https:")) warn("http で接続しています（開発用のローカルサーバ以外では使わないでください）");
  try {
    const started = Date.now();
    const inst = await publicGet<Instance>(cfg.serverUrl, "/v1/instance");
    ok(`サーバに到達できます: ${inst.name}${inst.version ? ` v${inst.version}` : ""}（${Date.now() - started}ms）`);
    try {
      requireCompatible(inst);
      ok(`CLI のバージョン ${CLI_VERSION}${inst.minClientVersion ? `（サーバが求めるのは ${inst.minClientVersion} 以上）` : ""}`);
    } catch (err) {
      return ng(err instanceof Error ? err.message : String(err));
    }
  } catch (err) {
    return ng(`サーバに到達できません。URL とネットワークを確認してください（${err instanceof Error ? err.message : err}）`);
  }
  const client = userClient();
  try {
    const me = await client.request<{ user: Me }>("GET", "/v1/me");
    ok("User トークンは有効です");
    if (isValidDisplayName(me.user.displayName)) ok(`表示名「${me.user.displayName}」`);
    else
      ng(
        `表示名「${me.user.displayName}」に使えない文字か表現が含まれているため、友人に近況が届きません。souieba profile --name <新しい表示名> で変えてください（日本語・英数字・一部の記号のみ）`,
      );
  } catch (err) {
    return ng(`User トークンが無効です: ${err instanceof Error ? err.message : err}`);
  }
  for (const [name, a] of Object.entries(cfg.agents)) {
    try {
      await new HttpClient({ baseUrl: cfg.serverUrl, token: a.token, clientVersion: CLI_VERSION }).request("GET", "/v1/me");
      if (a.keys) ok(`Agent「${name}」のトークンと鍵は有効です`);
      else ng(`Agent「${name}」には鍵がありません。souieba agent add ${JSON.stringify(name)} で登録し直してください`);
    } catch (err) {
      ng(`Agent「${name}」のトークンが無効です: ${err instanceof Error ? err.message : err}`);
    }
  }
  // 心当たりのない Agent は、User トークンが漏れて他人に足されたものかもしれない
  const local = new Set(Object.values(cfg.agents).map((a) => a.id));
  try {
    const { agents } = await client.request<{ agents: AgentInfo[] }>("GET", "/v1/agents");
    for (const a of agents.filter((x) => !x.revokedAt && !local.has(x.id))) {
      warn(
        `この PC にない Agent「${a.name}」（${a.id}、${new Date(a.createdAt).toLocaleString()} に登録）があります。心当たりがなければ souieba agent revoke ${a.id} を実行してください`,
      );
    }
  } catch (err) {
    ng(`Agent の一覧を取得できません: ${err instanceof Error ? err.message : err}`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof SetLogApiError ? `エラー（${err.code}）: ${err.message}` : err instanceof Error ? err.message : err);
  process.exit(1);
});
