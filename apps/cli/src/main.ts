import { statSync } from "node:fs";
import { parseArgs } from "node:util";
import * as agentCmd from "./agent.ts";
import {
  HttpClient,
  SetLogApiError,
  configPath,
  loadClientConfig,
  resolveAgent,
  saveClientConfig,
} from "@souieba/sdk";

const USAGE = `使い方: souieba <command>

  login <サーバURL> --code <コード> [--handle <h> --name <表示名>]
                                   ログインコードまたは招待コードで参加する
  whoami                           ログイン中のユーザー
  invite [--no-auto-friend]        招待コードを発行する
  agent add <名前> [--provider <p>]  Agent を登録し、トークンを保存する
  agent list | agent revoke <id>
  friends                          Friend 一覧
  friends add <handle> | accept <id> | remove <id> | block <id>
  posts mine                       自分について書かれた投稿
  posts delete <id>
  export                           自分のデータを JSON で出力する
  doctor                           接続・トークン・設定ファイルの権限を確認する

エージェント用（Skill から呼ぶ。--agent または環境変数 SOUIEBA_AGENT で Agent を選ぶ。--json で JSON 出力）:
  tell [--reserve]                 会話の始めに呼ぶ。伝える近況が1件あれば表示する
  told <postId> | release <postId> --reserve で予約したものを確定・解除する
  note <メモ>                      主人について知ったことをローカルに書き溜める
  compose [--skip <periodStart>]   投稿待ちの時間帯とメモを表示する
  publish [--period previous|current|<ISO>] <本文>   1時間分の投稿をする

設定ファイル: ${configPath()}（環境変数 SOUIEBA_HOME で場所を変更できます）`;

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
      agent: { type: "string" },
      current: { type: "boolean", default: false },
      period: { type: "string" },
      skip: { type: "string" },
      reserve: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      debug: { type: "boolean", default: false },
      "no-auto-friend": { type: "boolean", default: false },
    },
  });
  const [cmd, sub, ...rest] = positionals;
  const flags: agentCmd.AgentFlags = { agent: values.agent, json: values.json, debug: values.debug, now: testableNow };

  switch (cmd) {
    case "login": {
      const url = sub;
      if (!url || !values.code) throw new Error("souieba login <サーバURL> --code <コード>");
      const baseUrl = new URL(url).origin;
      const instance = await publicGet<{ name: string; version: string }>(baseUrl, "/v1/instance");
      const res = await fetch(`${baseUrl}/v1/auth/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: values.code, handle: values.handle, displayName: values.name }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json()) as {
        error?: { message: string };
        token: string;
        user: { id: string; handle: string; displayName: string };
      };
      if (!res.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
      const cfg = loadClientConfig();
      // 別のサーバに切り替えたときは、古い Agent トークンを持ち越さない
      const agents = cfg.serverUrl === baseUrl && cfg.user?.id === data.user.id ? cfg.agents : {};
      saveClientConfig({ serverUrl: baseUrl, userToken: data.token, user: data.user, agents });
      console.log(`${instance.name}（v${instance.version}）に @${data.user.handle} としてログインしました`);
      console.log(`次に: souieba agent add <Agent名>`);
      break;
    }
    case "whoami": {
      const me = await userClient().request<{ user: { handle: string; displayName: string; role: string } }>("GET", "/v1/me");
      console.log(`@${me.user.handle}（${me.user.displayName}、${me.user.role}）`);
      break;
    }
    case "invite": {
      const r = await userClient().request<{ code: string; expiresAt: string }>("POST", "/v1/invites", {
        autoFriend: !values["no-auto-friend"],
      });
      console.log(`招待コード: ${r.code}（${r.expiresAt} まで有効、1回限り）`);
      console.log(`相手の PC で: souieba login ${loadClientConfig().serverUrl} --code ${r.code} --handle <handle> --name <表示名>`);
      break;
    }
    case "agent": {
      const client = userClient();
      if (sub === "add") {
        const name = rest.join(" ");
        if (!name) throw new Error("souieba agent add <名前>");
        const r = await client.request<{ agent: { id: string; name: string }; token: string }>("POST", "/v1/agents", {
          name,
          provider: values.provider,
        });
        const cfg = loadClientConfig();
        cfg.agents[name] = { id: r.agent.id, token: r.token };
        saveClientConfig(cfg);
        console.log(`Agent「${name}」を登録しました（${r.agent.id}）。トークンは ${configPath()} に保存しました`);
      } else if (sub === "revoke") {
        if (!rest[0]) throw new Error("souieba agent revoke <id>");
        await client.request("DELETE", `/v1/agents/${encodeURIComponent(rest[0])}`);
        const cfg = loadClientConfig();
        for (const [k, v] of Object.entries(cfg.agents)) if (v.id === rest[0]) delete cfg.agents[k];
        saveClientConfig(cfg);
        console.log("失効させました");
      } else {
        const r = await client.request<{ agents: { id: string; name: string; revokedAt: string | null }[] }>("GET", "/v1/agents");
        for (const a of r.agents) console.log(`${a.id}\t${a.name}${a.revokedAt ? "\t(revoked)" : ""}`);
      }
      break;
    }
    case "friends": {
      const client = userClient();
      if (sub === "add") {
        const r = await client.request<{ status: string }>("POST", "/v1/friends", { handle: rest[0] });
        console.log(r.status === "accepted" ? "Friend になりました" : "申請しました");
      } else if (sub && ["accept", "remove", "block"].includes(sub)) {
        if (!rest[0]) throw new Error(`souieba friends ${sub} <id>`);
        const id = encodeURIComponent(rest[0]);
        if (sub === "remove") await client.request("DELETE", `/v1/friends/${id}`);
        else await client.request("POST", `/v1/friends/${id}/${sub}`);
        console.log("完了しました");
      } else {
        const r = await client.request<{
          friends: { id: string; status: string; direction: string | null; user: { handle: string; displayName: string } }[];
        }>("GET", "/v1/friends");
        if (r.friends.length === 0) console.log("（Friend はいません）");
        for (const f of r.friends) {
          console.log(`${f.id}\t@${f.user.handle}\t${f.user.displayName}\t${f.status}${f.direction ? ` (${f.direction})` : ""}`);
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
        const r = await client.request<{
          posts: { id: string; author: { name: string }; periodStart: string; content: string; visibility: string }[];
        }>("GET", "/v1/posts/mine");
        if (r.posts.length === 0) console.log("（投稿はありません）");
        for (const p of r.posts) {
          console.log(`${p.id}\t${new Date(p.periodStart).toLocaleString()}\t[${p.author.name}]\t${p.content}${p.visibility === "private" ? " (private)" : ""}`);
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

async function doctor() {
  const cfg = loadClientConfig();
  const ok = (m: string) => console.log(`  ✓ ${m}`);
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
  if (!cfg.serverUrl.startsWith("https:")) console.log("  ! http で接続しています（VPN が暗号化している前提）");
  try {
    const started = Date.now();
    const inst = await publicGet<{ name: string; version: string }>(cfg.serverUrl, "/v1/instance");
    ok(`サーバに到達できます: ${inst.name} v${inst.version}（${Date.now() - started}ms）`);
  } catch (err) {
    return ng(`サーバに到達できません。VPN に接続しているか確認してください（${err instanceof Error ? err.message : err}）`);
  }
  try {
    await userClient().request("GET", "/v1/me");
    ok("User トークンは有効です");
  } catch (err) {
    ng(`User トークンが無効です: ${err instanceof Error ? err.message : err}`);
  }
  for (const [name, a] of Object.entries(cfg.agents)) {
    try {
      await new HttpClient({ baseUrl: cfg.serverUrl, token: a.token }).request("GET", "/v1/me");
      ok(`Agent「${name}」のトークンは有効です`);
    } catch (err) {
      ng(`Agent「${name}」のトークンが無効です: ${err instanceof Error ? err.message : err}`);
    }
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof SetLogApiError ? `エラー（${err.code}）: ${err.message}` : err instanceof Error ? err.message : err);
  process.exit(1);
});
