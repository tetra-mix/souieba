import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { parseArgs } from "node:util";
import * as agentCmd from "./agent.ts";
import {
  GROUP_INVITE_CODE_LENGTH,
  type KeyDirectory,
  type KeyPair,
  type PostEnvelope,
  type TrustProblem,
  codeHash,
  fingerprint,
  generateEncryptionKey,
  generateSigningKey,
  inviteCommit,
  newCode,
  normalizeFingerprint,
  openPost,
  signText,
  signedText,
  verifyText,
} from "@souieba/core";
import {
  type ClientConfig,
  HttpClient,
  Keyring,
  SetLogApiError,
  configPath,
  loadClientConfig,
  saveClientConfig,
} from "@souieba/sdk";

const USAGE = `使い方: souieba <command>

  login <サーバURL> --code <コード> [--verify <指紋>] [--handle <h> --name <表示名>]
                                   ログインコードまたは招待コードで参加する
  whoami                           ログイン中のユーザーと、自分の鍵の指紋
  groups                           所属しているグループの一覧
  groups create <名前>             グループを作る
  groups join <コード> [--verify <指紋>]   招待コードで別のグループに参加する
  groups members [<グループ>]      メンバーと指紋・検証の状態
  groups leave <グループ> | remove <グループ> <handle> | rename <グループ> <新しい名前>
  invite [--group <グループ>]      グループへの招待コードを発行する
  identity                         自分の Identity 鍵の指紋
  identity export | import <文字列>  Identity 鍵を別の PC へ移す
  identity accept <handle> --verify <指紋>   鍵を作り直した相手を、指紋を確認したうえで信頼し直す
  agent add <名前> [--provider <p>]  Agent を登録し、トークンと鍵を保存する
  agent list | agent revoke <id>
  posts mine                       自分について書かれた投稿（この PC の Agent の鍵で復号する）
  posts delete <id>
  export                           自分のデータを JSON で出力する
  doctor                           接続・トークン・鍵・設定ファイルの権限を確認する

エージェント用（Skill から呼ぶ。--agent または環境変数 SOUIEBA_AGENT で Agent を選ぶ。--json で JSON 出力）:
  tell [--reserve]                 会話の始めに呼ぶ。伝える近況が1件あれば表示する
  told <postId> | release <postId> --reserve で予約したものを確定・解除する
  note <メモ>                      主人について知ったことをローカルに書き溜める
  compose [--skip <periodStart>]   投稿待ちの時間帯とメモを表示する
  publish [--period previous|current|<ISO>] <本文>   1時間分の投稿をする

<グループ> は名前か ID。設定ファイル: ${configPath()}（環境変数 SOUIEBA_HOME で場所を変更できます）`;

type Me = { id: string; handle: string; displayName: string; role: string; identityKey: string | null };
type Group = { id: string; name: string; role: string; memberCount: number };
type JoinResult = {
  group: { id: string; name: string } | null;
  inviter: { id: string; handle: string; displayName: string; identityKey: string } | null;
};

function userClient(): HttpClient {
  const cfg = loadClientConfig();
  if (!cfg.serverUrl || !cfg.userToken) throw new Error("未ログインです。`souieba login` を実行してください");
  return new HttpClient({ baseUrl: cfg.serverUrl, token: cfg.userToken, timeoutMs: 10_000 });
}

async function publicGet<T>(baseUrl: string, path: string): Promise<T> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** この PC にある、ログイン中のユーザーの Identity 鍵 */
function localIdentity(cfg: ClientConfig): { userId: string } & KeyPair {
  if (!cfg.user) throw new Error("未ログインです。`souieba login` を実行してください");
  if (!cfg.identity || cfg.identity.userId !== cfg.user.id) {
    throw new Error(
      "この PC には Identity 鍵がありません。元の PC で `souieba identity export` を実行し、ここで `souieba identity import <文字列>` を実行してください",
    );
  }
  return cfg.identity;
}

/** サーバに登録されている Identity 鍵が、この PC のものと同じかを確かめる（未登録なら登録する） */
async function ensureServerIdentity(client: HttpClient, identity: { pub: string }): Promise<void> {
  const { user } = await client.request<{ user: Me }>("GET", "/v1/me");
  if (!user.identityKey) {
    await client.request("PUT", "/v1/me/identity", { identityKey: identity.pub });
  } else if (user.identityKey !== identity.pub) {
    throw new Error(
      "サーバに登録されている Identity 鍵が、この PC のものと違います。サーバが鍵をすり替えている可能性があります。管理者に確認してください",
    );
  }
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

/** 公開鍵ディレクトリを取得し、サーバを信頼せずに検証する */
async function trustReport(client: HttpClient, cfg: ClientConfig) {
  const identity = localIdentity(cfg);
  const dir = await client.request<KeyDirectory>("GET", "/v1/keys");
  return { dir, trust: new Keyring().evaluate(dir, identity.pub) };
}

function describeProblem(p: TrustProblem): string {
  switch (p.kind) {
    case "identity_changed":
      return `@${p.handle} の Identity 鍵が、以前に見たものから変わっています。本人に指紋を確認し、正しければ souieba identity accept ${p.handle} --verify <指紋> を実行してください。それまで @${p.handle} とは近況をやり取りしません`;
    case "self_identity_mismatch":
      return "サーバが配っている自分の Identity 鍵が、この PC のものと違います。サーバが鍵をすり替えている可能性があります";
    case "unverified_member":
      return `グループ「${p.groupName}」の @${p.handle} は、所属を証明できません（招待の署名をたどれない）。@${p.handle} には近況を送りません`;
    case "invalid_agent_cert":
      return `@${p.handle} の Agent「${p.agentName}」の証明書を検証できません。この Agent には近況を送りません`;
  }
}

/** 招待者の指紋を照合する。--verify がなければ何もしない */
function checkInviter(inviter: JoinResult["inviter"], verify: string | undefined): void {
  if (!verify) return;
  if (!inviter) throw new Error("--verify を指定しましたが、このコードには招待者がいません");
  const actual = fingerprint(inviter.identityKey);
  if (actual !== normalizeFingerprint(verify)) {
    throw new Error(
      `招待者 @${inviter.handle} の指紋が一致しません（受け取った指紋: ${normalizeFingerprint(verify)}、サーバが返した鍵の指紋: ${actual}）。` +
        "サーバが鍵をすり替えている可能性があります。招待した人に連絡してください",
    );
  }
}

/** テスト用に現在時刻を固定できる（SOUIEBA_NOW=ISO 8601） */
const testableNow = () => (process.env.SOUIEBA_NOW ? new Date(process.env.SOUIEBA_NOW) : new Date());

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      code: { type: "string" },
      verify: { type: "string" },
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
    },
  });
  const [cmd, sub, ...rest] = positionals;
  const flags: agentCmd.AgentFlags = { agent: values.agent, json: values.json, debug: values.debug, now: testableNow };

  switch (cmd) {
    case "login": {
      const url = sub;
      if (!url || !values.code) throw new Error("souieba login <サーバURL> --code <コード>");
      const baseUrl = new URL(url).origin;
      const instance = await publicGet<{ name: string; version?: string }>(baseUrl, "/v1/instance");
      const cfg = loadClientConfig();
      // 新しいアカウントなら新しい鍵を作る。ログインコードなら、この PC の鍵があればそれを使う
      const reuse = !values.handle && cfg.serverUrl === baseUrl && cfg.identity;
      const candidate: KeyPair = reuse ? { pub: cfg.identity!.pub, priv: cfg.identity!.priv } : generateSigningKey();
      const res = await fetch(`${baseUrl}/v1/auth/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: values.code,
          handle: values.handle,
          displayName: values.name,
          identityKey: candidate.pub,
          joinSig: signText(candidate, signedText.join(values.code)),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json()) as { error?: { message: string }; token: string; user: Me } & JoinResult;
      if (!res.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
      checkInviter(data.inviter, values.verify);

      let identity: ClientConfig["identity"];
      if (data.user.identityKey === candidate.pub) identity = { userId: data.user.id, ...candidate };
      else if (cfg.identity?.userId === data.user.id && cfg.identity.pub === data.user.identityKey) identity = cfg.identity;
      // 別のサーバ・別のユーザーに切り替えたときは、古い Agent を持ち越さない
      const agents = cfg.serverUrl === baseUrl && cfg.user?.id === data.user.id ? cfg.agents : {};
      const user = { id: data.user.id, handle: data.user.handle, displayName: data.user.displayName };
      saveClientConfig({ serverUrl: baseUrl, userToken: data.token, user, identity, agents });
      if (data.inviter && values.verify) new Keyring().pinIdentity(data.inviter.id, data.inviter.identityKey);

      console.log(`${instance.name}${instance.version ? `（v${instance.version}）` : ""} に @${user.handle} としてログインしました`);
      if (data.group) console.log(`グループ「${data.group.name}」に参加しました（招待した人: @${data.inviter?.handle}）`);
      if (identity) {
        console.log(`あなたの Identity 鍵の指紋: ${fingerprint(identity.pub)}`);
        console.log("次に: souieba agent add <Agent名>");
      } else {
        console.log(
          "この PC には Identity 鍵がありません。元の PC で `souieba identity export` を実行し、ここで `souieba identity import <文字列>` を実行してください",
        );
      }
      break;
    }
    case "whoami": {
      const me = await userClient().request<{ user: Me }>("GET", "/v1/me");
      console.log(`@${me.user.handle}（${me.user.displayName}、${me.user.role}）`);
      if (me.user.identityKey) console.log(`Identity 鍵の指紋: ${fingerprint(me.user.identityKey)}`);
      break;
    }
    case "groups": {
      await groupsCommand(sub, rest, values);
      break;
    }
    case "invite": {
      const cfg = loadClientConfig();
      const identity = localIdentity(cfg);
      const client = userClient();
      await ensureServerIdentity(client, identity);
      const group = await resolveGroup(client, values.group);
      // コードは手元で作り、サーバにはハッシュと署名だけを送る（サーバに偽のメンバーを作らせないため）
      const code = newCode(GROUP_INVITE_CODE_LENGTH);
      const commit = inviteCommit(group.id, code);
      const r = await client.request<{ expiresAt: string }>("POST", `/v1/groups/${encodeURIComponent(group.id)}/invites`, {
        codeHash: codeHash(code),
        commit,
        inviteSig: signText(identity, signedText.invite(group.id, identity.userId, commit)),
      });
      const fp = fingerprint(identity.pub);
      console.log(`グループ「${group.name}」への招待コード: ${code}（${r.expiresAt} まで有効、1回限り）`);
      console.log(`あなたの指紋: ${fp}（コードと一緒に、サーバを通さずに相手へ伝えてください）`);
      console.log(`初めての人: souieba login ${cfg.serverUrl} --code ${code} --verify ${fp} --handle <handle> --name <表示名>`);
      console.log(`登録済みの人: souieba groups join ${code} --verify ${fp}`);
      break;
    }
    case "identity": {
      await identityCommand(sub, rest, values);
      break;
    }
    case "agent": {
      const client = userClient();
      if (sub === "add") {
        const name = rest.join(" ");
        if (!name) throw new Error("souieba agent add <名前>");
        const cfg = loadClientConfig();
        const identity = localIdentity(cfg);
        await ensureServerIdentity(client, identity);
        const enc = generateEncryptionKey();
        const sign = generateSigningKey();
        const r = await client.request<{ agent: { id: string; name: string }; token: string }>("POST", "/v1/agents", {
          name,
          provider: values.provider,
          encKey: enc.pub,
          signKey: sign.pub,
          cert: signText(identity, signedText.agentCert(identity.userId, enc.pub, sign.pub)),
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
        const r = await client.request<{ agents: { id: string; name: string; encKey: string | null; revokedAt: string | null }[] }>(
          "GET",
          "/v1/agents",
        );
        for (const a of r.agents) {
          console.log(`${a.id}\t${a.name}${a.revokedAt ? "\t(revoked)" : !a.encKey ? "\t(鍵なし。登録し直してください)" : ""}`);
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

async function groupsCommand(sub: string | undefined, rest: string[], values: { verify?: string }) {
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
      const identity = localIdentity(cfg);
      await ensureServerIdentity(client, identity);
      // ID は手元で作る（作成の署名に含めるため）
      const id = `grp_${randomBytes(16).toString("base64url")}`;
      await client.request("POST", "/v1/groups", {
        id,
        name,
        createSig: signText(identity, signedText.groupCreate(id, identity.userId)),
      });
      console.log(`グループ「${name}」を作りました（${id}）`);
      console.log(`次に: souieba invite --group ${JSON.stringify(name)}`);
      return;
    }
    case "join": {
      const code = rest[0];
      if (!code) throw new Error("souieba groups join <コード> [--verify <指紋>]");
      const identity = localIdentity(cfg);
      await ensureServerIdentity(client, identity);
      const r = await client.request<JoinResult>("POST", "/v1/groups/join", { code, joinSig: signText(identity, signedText.join(code)) });
      try {
        checkInviter(r.inviter, values.verify);
      } catch (err) {
        // 指紋が合わないグループには留まらない
        if (r.group) await client.request("DELETE", `/v1/groups/${encodeURIComponent(r.group.id)}/members/${encodeURIComponent(identity.userId)}`);
        throw err;
      }
      if (r.inviter && values.verify) new Keyring().pinIdentity(r.inviter.id, r.inviter.identityKey);
      console.log(`グループ「${r.group?.name}」に参加しました（招待した人: @${r.inviter?.handle}）`);
      return;
    }
    case "members": {
      const group = await resolveGroup(client, rest[0]);
      const { trust } = await trustReport(client, cfg);
      const view = trust.groups.find((g) => g.id === group.id);
      for (const m of view?.members ?? []) {
        if (!m.active) continue;
        const state = m.userId === cfg.user?.id ? "自分" : m.verified ? "検証済み" : "未検証";
        console.log(`@${m.handle}\t${m.displayName}\t${m.role}\t${m.identityKey ? fingerprint(m.identityKey) : "（鍵なし）"}\t${state}`);
      }
      for (const p of trust.problems) console.log(`! ${describeProblem(p)}`);
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
      const dir = await client.request<KeyDirectory>("GET", "/v1/keys");
      const target = dir.users.find((u) => u.handle === handle.replace(/^@/, ""));
      if (!target) throw new Error(`@${handle} はこのグループにいません`);
      await client.request("DELETE", `/v1/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(target.id)}`);
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

const EXPORT_PREFIX = "souieba-identity:";

async function identityCommand(sub: string | undefined, rest: string[], values: { verify?: string }) {
  const cfg = loadClientConfig();
  switch (sub) {
    case undefined: {
      const identity = localIdentity(cfg);
      console.log(`@${cfg.user!.handle} の Identity 鍵の指紋: ${fingerprint(identity.pub)}`);
      return;
    }
    case "export": {
      const identity = localIdentity(cfg);
      console.error("※ これは秘密鍵です。自分の別の PC に移す目的以外で、他人やチャットに貼らないでください。");
      console.log(`${EXPORT_PREFIX}${Buffer.from(JSON.stringify(identity)).toString("base64url")}`);
      return;
    }
    case "import": {
      const blob = rest[0];
      if (!blob?.startsWith(EXPORT_PREFIX)) throw new Error(`souieba identity import ${EXPORT_PREFIX}…`);
      const identity = JSON.parse(Buffer.from(blob.slice(EXPORT_PREFIX.length), "base64url").toString()) as ClientConfig["identity"];
      if (!identity || !cfg.user || identity.userId !== cfg.user.id) throw new Error("ログイン中のユーザーの鍵ではありません");
      // 公開鍵と秘密鍵の組が正しいか、署名して確かめる
      if (!verifyText(identity.pub, "check", signText(identity, "check"))) throw new Error("鍵が壊れています");
      await ensureServerIdentity(userClient(), identity);
      saveClientConfig({ ...cfg, identity });
      console.log(`Identity 鍵を取り込みました（指紋: ${fingerprint(identity.pub)}）。次に: souieba agent add <Agent名>`);
      return;
    }
    case "accept": {
      const handle = rest[0]?.replace(/^@/, "");
      if (!handle || !values.verify) throw new Error("souieba identity accept <handle> --verify <指紋>");
      const dir = await userClient().request<KeyDirectory>("GET", "/v1/keys");
      const u = dir.users.find((x) => x.handle === handle);
      if (!u?.identityKey) throw new Error(`@${handle} は同じグループにいません`);
      if (fingerprint(u.identityKey) !== normalizeFingerprint(values.verify)) {
        throw new Error(`指紋が一致しません（サーバが返した鍵の指紋: ${fingerprint(u.identityKey)}）`);
      }
      const keyring = new Keyring();
      keyring.forgetIdentity(u.id);
      keyring.pinIdentity(u.id, u.identityKey);
      console.log(`@${handle} の新しい鍵を信頼しました`);
      return;
    }
    default:
      throw new Error(`不明なサブコマンドです: identity ${sub}`);
  }
}

async function doctor() {
  const cfg = loadClientConfig();
  const ok = (m: string) => console.log(`  ✓ ${m}`);
  const warn = (m: string) => console.log(`  ! ${m}`);
  const ng = (m: string) => {
    console.log(`  ✗ ${m}`);
    process.exitCode = 1;
  };
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
    const inst = await publicGet<{ name: string; version?: string }>(cfg.serverUrl, "/v1/instance");
    ok(`サーバに到達できます: ${inst.name}${inst.version ? ` v${inst.version}` : ""}（${Date.now() - started}ms）`);
  } catch (err) {
    return ng(`サーバに到達できません。URL とネットワークを確認してください（${err instanceof Error ? err.message : err}）`);
  }
  const client = userClient();
  try {
    await client.request("GET", "/v1/me");
    ok("User トークンは有効です");
  } catch (err) {
    return ng(`User トークンが無効です: ${err instanceof Error ? err.message : err}`);
  }
  try {
    const identity = localIdentity(cfg);
    await ensureServerIdentity(client, identity);
    ok(`Identity 鍵（指紋 ${fingerprint(identity.pub)}）`);
  } catch (err) {
    ng(err instanceof Error ? err.message : String(err));
  }
  for (const [name, a] of Object.entries(cfg.agents)) {
    try {
      await new HttpClient({ baseUrl: cfg.serverUrl, token: a.token }).request("GET", "/v1/me");
      if (a.keys) ok(`Agent「${name}」のトークンと鍵は有効です`);
      else ng(`Agent「${name}」には鍵がありません。souieba agent add ${JSON.stringify(name)} で登録し直してください`);
    } catch (err) {
      ng(`Agent「${name}」のトークンが無効です: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (cfg.identity) {
    try {
      const { trust } = await trustReport(client, cfg);
      const others = trust.users.size - 1;
      ok(`グループ ${trust.groups.length} 件、近況をやり取りする相手 ${others} 人（署名を検証済み）`);
      for (const p of trust.problems) warn(describeProblem(p));
    } catch (err) {
      ng(`公開鍵ディレクトリを検証できません: ${err instanceof Error ? err.message : err}`);
    }
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof SetLogApiError ? `エラー（${err.code}）: ${err.message}` : err instanceof Error ? err.message : err);
  process.exit(1);
});
