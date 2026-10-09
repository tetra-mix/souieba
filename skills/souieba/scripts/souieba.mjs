#!/usr/bin/env node

// apps/cli/src/main.ts
import { statSync } from "node:fs";
import { parseArgs } from "node:util";

// apps/cli/src/agent.ts
import { join as join4 } from "node:path";

// packages/core/src/period.ts
var HOUR_MS = 60 * 60 * 1e3;
var MAX_POST_AGE_MS = 48 * HOUR_MS;
var CLOCK_SKEW_MS = 5 * 60 * 1e3;
function floorToHour(date) {
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
}
function periodOf(now, which) {
  const start = floorToHour(now).getTime() - (which === "previous" ? HOUR_MS : 0);
  return { periodStart: new Date(start).toISOString(), periodEnd: new Date(start + HOUR_MS).toISOString() };
}

// packages/core/src/scanner.ts
var RULES = [
  { rule: "souieba_token", pattern: /sou_[ua]_[A-Za-z0-9_-]{16,}/g },
  { rule: "anthropic_key", pattern: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { rule: "openai_key", pattern: /sk-(?:proj-)?[A-Za-z0-9]{20,}/g },
  { rule: "github_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { rule: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: "slack_token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { rule: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { rule: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { rule: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { rule: "phone_jp", pattern: /(?<!\d)0\d{1,4}-?\d{1,4}-?\d{3,4}(?!\d)/g },
  { rule: "credit_card", pattern: /(?<!\d)(?:\d{4}[ -]?){3}\d{4}(?!\d)/g },
  { rule: "url_with_secret", pattern: /https?:\/\/\S*[?&](?:token|key|secret|password|sig|signature|access_token)=\S+/gi },
  { rule: "long_hex", pattern: /\b[0-9a-f]{32,}\b/gi },
  // 大文字・小文字・数字が混在する長い文字列だけを対象にし、ファイルパスなどの誤検知を避ける
  { rule: "long_base64", pattern: /(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])[A-Za-z0-9+/_-]{40,}={0,2}/g }
];
function scanSecrets(text) {
  const findings = [];
  for (const { rule, pattern } of RULES) {
    for (const m of text.matchAll(pattern)) findings.push({ rule, match: m[0] });
  }
  return findings;
}

// packages/core/src/sanitize.ts
var MAX_CONTENT_LENGTH = 300;
var MIN_TELL_CONTENT_LENGTH = 10;
function sanitizeContent(input) {
  return input.normalize("NFKC").replace(/https?:\/\/\S+/gi, "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, " ").replace(/[`<>{}[\]#*_|\\]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_CONTENT_LENGTH);
}

// packages/core/src/session.ts
import { randomUUID } from "node:crypto";
var DEFAULT_SESSION_GAP_MS = 30 * 60 * 1e3;
function advanceSession(prev, now, gapMs = DEFAULT_SESSION_GAP_MS) {
  const isNewSession = prev === null || now.getTime() - Date.parse(prev.lastMessageAt) >= gapMs;
  const state = isNewSession ? { sessionId: randomUUID(), lastMessageAt: now.toISOString(), tellsInSession: 0 } : { ...prev, lastMessageAt: now.toISOString() };
  return { state, isNewSession };
}
function canTell(state, maxPerSession = 1) {
  return state.tellsInSession < maxPerSession;
}

// packages/core/src/tell.ts
var TELL_WINDOW_MS = 48 * 60 * 60 * 1e3;

// packages/core/src/tell-text.ts
function validateTellText(text, displayName) {
  const t = text.trim();
  if (t.length === 0 || t.length > 120) return "length";
  if (/[\r\n]/.test(t)) return "newline";
  if (/https?:\/\/|www\./i.test(t)) return "url";
  if (/[`<>{}[\]$]/.test(t)) return "markup";
  if (!t.includes(displayName)) return "missing_name";
  return null;
}
function formatTellText(displayName, content) {
  const body = content.replace(/^主人は/, "").replace(/(らしい|ようだ|みたいだ)?[。.!！]*$/, "");
  return `\u3042\u3001\u305D\u3046\u3044\u3048\u3070${displayName}\u3055\u3093\u3001${body}\u307F\u305F\u3044\u3067\u3059\u3088\u3002`;
}

// packages/core/src/crypto.ts
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify
} from "node:crypto";
var CURVE = { ed25519: "Ed25519", x25519: "X25519" };
var b64 = (b) => Buffer.from(b).toString("base64url");
var unb64 = (s) => Buffer.from(s, "base64url");
function generate(kind) {
  const { privateKey: privateKey2 } = generateKeyPairSync(kind);
  const jwk = privateKey2.export({ format: "jwk" });
  return { pub: jwk.x, priv: jwk.d };
}
var generateSigningKey = () => generate("ed25519");
var generateEncryptionKey = () => generate("x25519");
function privateKey(kind, kp) {
  return createPrivateKey({ key: { kty: "OKP", crv: CURVE[kind], x: kp.pub, d: kp.priv }, format: "jwk" });
}
function publicKey(kind, x) {
  return createPublicKey({ key: { kty: "OKP", crv: CURVE[kind], x }, format: "jwk" });
}
function signText(kp, text) {
  return b64(sign(null, Buffer.from(text, "utf8"), privateKey("ed25519", kp)));
}
function verifyText(pub, text, sig) {
  try {
    return verify(null, Buffer.from(text, "utf8"), publicKey("ed25519", pub), unb64(sig));
  } catch {
    return false;
  }
}
function aad(author, env) {
  return Buffer.from(
    `souieba/post-aad/v1
${author.userId}
${author.agentId}
${env.periodStart}
${env.periodEnd}
${env.visibility}`,
    "utf8"
  );
}
function sortRecipients(rs) {
  return [...rs].sort((a, b) => a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0);
}
function postSigningText(author, env) {
  const rs = sortRecipients(env.recipients).map((r) => `${r.agentId}.${r.iv}.${r.wrapped}`);
  return [
    "souieba/post/v1",
    author.userId,
    author.agentId,
    env.v,
    env.periodStart,
    env.periodEnd,
    env.visibility,
    env.epk,
    env.iv,
    env.ciphertext,
    rs.join(",")
  ].join("\n");
}
function wrapKey(shared, epkPub, agentId) {
  return Buffer.from(hkdfSync("sha256", shared, unb64(epkPub), `souieba/wrap/v1
${agentId}`, 32));
}
function gcmEncrypt(key, plain, additional) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  if (additional) c.setAAD(additional);
  const data = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { iv: b64(iv), data: b64(data) };
}
function gcmDecrypt(key, iv, data, additional) {
  const buf = unb64(data);
  if (buf.length < 16) throw new Error("ciphertext too short");
  const d = createDecipheriv("aes-256-gcm", key, unb64(iv));
  if (additional) d.setAAD(additional);
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]);
}
function sealPost(post, author, recipients) {
  const header = { periodStart: post.periodStart, periodEnd: post.periodEnd, visibility: post.visibility };
  const cek = randomBytes(32);
  const body = gcmEncrypt(cek, Buffer.from(post.content, "utf8"), aad(author, header));
  const eph = generateEncryptionKey();
  const ephKey = privateKey("x25519", eph);
  const seen = /* @__PURE__ */ new Set();
  const wrapped = [];
  for (const r of recipients) {
    if (seen.has(r.agentId)) continue;
    seen.add(r.agentId);
    const shared = diffieHellman({ privateKey: ephKey, publicKey: publicKey("x25519", r.encKey) });
    const w = gcmEncrypt(wrapKey(shared, eph.pub, r.agentId), cek);
    wrapped.push({ agentId: r.agentId, iv: w.iv, wrapped: w.data });
  }
  const unsigned = {
    v: 1,
    ...header,
    epk: eph.pub,
    iv: body.iv,
    ciphertext: body.data,
    recipients: sortRecipients(wrapped)
  };
  return { ...unsigned, sig: signText(author.signKey, postSigningText(author, unsigned)) };
}
function verifyPostSignature(env, author, signKey) {
  const { sig, ...unsigned } = env;
  return verifyText(signKey, postSigningText(author, unsigned), sig);
}
var DecryptError = class extends Error {
};
function openPost(env, author, me) {
  const mine = env.recipients.find((r) => r.agentId === me.agentId);
  if (!mine) throw new DecryptError("\u3053\u306E Agent \u5B9B\u3066\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
  try {
    const shared = diffieHellman({ privateKey: privateKey("x25519", me.encKey), publicKey: publicKey("x25519", env.epk) });
    const cek = gcmDecrypt(wrapKey(shared, env.epk, me.agentId), mine.iv, mine.wrapped);
    return gcmDecrypt(cek, env.iv, env.ciphertext, aad(author, env)).toString("utf8");
  } catch {
    throw new DecryptError("\u5FA9\u53F7\u3067\u304D\u307E\u305B\u3093");
  }
}

// packages/sdk/src/http.ts
var SetLogApiError = class extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
};
var HttpClient = class {
  constructor(opts) {
    this.opts = opts;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }
  baseUrl;
  fetchImpl;
  async request(method, path, body, timeoutMs = this.opts.timeoutMs ?? 5e3) {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        ...body !== void 0 ? { "content-type": "application/json" } : {}
      },
      body: body !== void 0 ? JSON.stringify(body) : void 0,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (res.status === 204) return void 0;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new SetLogApiError(res.status, data.error?.code ?? "http_error", data.error?.message ?? `HTTP ${res.status}`);
    }
    return data;
  }
};
var HttpTransport = class {
  client;
  interactiveMs;
  constructor(opts) {
    this.client = new HttpClient(opts);
    this.interactiveMs = opts.interactiveTimeoutMs ?? 1500;
  }
  publishEnvelope(envelope) {
    return this.client.request("POST", "/v1/posts", { envelope }, 15e3);
  }
  /** 公開鍵ディレクトリ。会話の始め（tell）でも呼ぶので、短いタイムアウトにする */
  keys() {
    return this.client.request("GET", "/v1/keys", void 0, this.interactiveMs);
  }
  sync() {
    return this.client.request("POST", "/v1/sync", {}, this.interactiveMs);
  }
  async inbox() {
    return (await this.client.request("GET", "/v1/inbox")).items;
  }
  async claimTell(opts = {}) {
    return (await this.client.request("POST", "/v1/tell/claim", opts, this.interactiveMs)).candidate;
  }
  markAsTold(postId) {
    return this.client.request("POST", `/v1/deliveries/${encodeURIComponent(postId)}/told`);
  }
  release(postId) {
    return this.client.request("POST", `/v1/deliveries/${encodeURIComponent(postId)}/release`);
  }
  /** 検証・復号できなかった投稿を、二度と候補にならないようにする */
  dismiss(postId) {
    return this.client.request("POST", `/v1/deliveries/${encodeURIComponent(postId)}/dismiss`);
  }
};

// packages/sdk/src/config.ts
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
function souiebaHome() {
  return process.env.SOUIEBA_HOME ?? join(homedir(), ".souieba");
}
function configPath() {
  return join(souiebaHome(), "config.json");
}
function loadClientConfig() {
  const p = configPath();
  if (!existsSync(p)) return { agents: {} };
  const cfg = JSON.parse(readFileSync(p, "utf8"));
  cfg.agents ??= {};
  return cfg;
}
function writeSecretJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 448 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}
`, { mode: 384 });
  chmodSync(tmp, 384);
  renameSync(tmp, path);
}
function saveClientConfig(cfg) {
  writeSecretJson(configPath(), cfg);
}
function resolveAgent(name) {
  name ??= process.env.SOUIEBA_AGENT || void 0;
  const cfg = loadClientConfig();
  const serverUrl = process.env.SOUIEBA_SERVER ?? cfg.serverUrl;
  if (!serverUrl) throw new Error("\u30B5\u30FC\u30D0\u304C\u672A\u8A2D\u5B9A\u3067\u3059\u3002`souieba login <URL> --code <\u30B3\u30FC\u30C9>` \u3092\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044");
  const names = Object.keys(cfg.agents);
  const key = name ?? (names.length === 1 ? names[0] : void 0);
  const agent = key ? cfg.agents[key] : void 0;
  if (!key || !agent) {
    throw new Error(
      names.length === 0 ? "Agent \u304C\u672A\u767B\u9332\u3067\u3059\u3002`souieba agent add <\u540D\u524D>` \u3092\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044" : key ? `Agent\u300C${key}\u300D\u306F\u672A\u767B\u9332\u3067\u3059\u3002\u767B\u9332\u6E08\u307F: ${names.join(", ")}` : `Agent \u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\uFF08--agent \u307E\u305F\u306F\u74B0\u5883\u5909\u6570 SOUIEBA_AGENT\uFF09\u3002\u767B\u9332\u6E08\u307F: ${names.join(", ")}`
    );
  }
  return {
    serverUrl,
    agentId: agent.id,
    token: agent.token,
    name: key,
    keys: agent.keys,
    userId: cfg.user?.id
  };
}

// packages/sdk/src/setlog.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
var SetLog = class {
  transport;
  statePath;
  gapMs;
  maxTells;
  now;
  onError;
  state;
  constructor(opts) {
    this.transport = opts.transport;
    this.statePath = opts.statePath ?? join2(souiebaHome(), "state", `${opts.stateKey ?? "default"}.json`);
    this.gapMs = opts.sessionGapMs ?? DEFAULT_SESSION_GAP_MS;
    this.maxTells = opts.maxTellsPerSession ?? 1;
    this.now = opts.now ?? (() => /* @__PURE__ */ new Date());
    this.onError = opts.onError ?? (() => {
    });
    this.state = existsSync2(this.statePath) ? JSON.parse(readFileSync2(this.statePath, "utf8")) : null;
  }
  get session() {
    return this.state;
  }
  /** ユーザーの発話ごとに呼ぶ */
  beginTurn() {
    const { state, isNewSession } = advanceSession(this.state, this.now(), this.gapMs);
    this.state = state;
    this.persist();
    return { sessionId: state.sessionId, isNewSession };
  }
  publish(input) {
    const { period = "previous", ...rest } = input;
    return this.transport.publish({ ...periodOf(this.now(), period), ...rest });
  }
  sync() {
    return this.transport.sync();
  }
  /**
   * この Session でまだ Tell していなければ、同期してから候補を1件予約する。
   * 何も伝えるものがない・通信できない場合は null。
   */
  async pickTellCandidate() {
    if (!this.state || !canTell(this.state, this.maxTells)) return null;
    try {
      await this.transport.sync();
      return await this.transport.claimTell();
    } catch (err) {
      this.onError("pickTellCandidate", err);
      return null;
    }
  }
  async markAsTold(postId) {
    try {
      await this.transport.markAsTold(postId);
      if (this.state) {
        this.state = { ...this.state, tellsInSession: this.state.tellsInSession + 1 };
        this.persist();
      }
      return true;
    } catch (err) {
      this.onError("markAsTold", err);
      return false;
    }
  }
  async release(postId) {
    try {
      await this.transport.release(postId);
    } catch (err) {
      this.onError("release", err);
    }
  }
  persist() {
    writeSecretJson(this.statePath, this.state);
  }
};

// packages/sdk/src/notes.ts
import { appendFileSync, existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
var SecretInNoteError = class extends Error {
  constructor(rules) {
    super(`\u79D8\u5BC6\u60C5\u5831\u306E\u53EF\u80FD\u6027\u304C\u3042\u308B\u305F\u3081\u8A18\u9332\u3057\u307E\u305B\u3093\u3067\u3057\u305F\uFF08${rules.join(", ")}\uFF09`);
    this.rules = rules;
  }
};
var MAX_NOTE_LENGTH = 200;
var NotesStore = class {
  notesPath;
  periodsPath;
  constructor(agentKey, dir = join3(souiebaHome(), "agents", agentKey)) {
    this.notesPath = join3(dir, "notes.jsonl");
    this.periodsPath = join3(dir, "periods.json");
  }
  add(text, now) {
    const clean = sanitizeContent(text).slice(0, MAX_NOTE_LENGTH);
    if (!clean) throw new Error("\u30E1\u30E2\u304C\u7A7A\u3067\u3059");
    const findings = [...scanSecrets(text), ...scanSecrets(clean)];
    if (findings.length > 0) throw new SecretInNoteError([...new Set(findings.map((f) => f.rule))]);
    const note2 = { ts: now.toISOString(), text: clean };
    mkdirSync2(dirname2(this.notesPath), { recursive: true, mode: 448 });
    appendFileSync(this.notesPath, `${JSON.stringify(note2)}
`, { mode: 384 });
    return note2;
  }
  all() {
    if (!existsSync3(this.notesPath)) return [];
    return readFileSync3(this.notesPath, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  }
  notesIn(periodStart) {
    const start = Date.parse(periodStart);
    return this.all().filter((n) => {
      const t = Date.parse(n.ts);
      return t >= start && t < start + HOUR_MS;
    });
  }
  /** メモがあり、まだ投稿もスキップもしていない、確定済みの時間帯（古い順） */
  pending(now) {
    const done = this.readPeriods().done;
    const currentStart = floorToHour(now).getTime();
    const oldest = now.getTime() - MAX_POST_AGE_MS + 10 * 6e4;
    const byPeriod = /* @__PURE__ */ new Map();
    for (const n of this.all()) {
      const start = floorToHour(new Date(n.ts)).getTime();
      if (start >= currentStart || start < oldest) continue;
      const key = new Date(start).toISOString();
      if (done[key]) continue;
      byPeriod.set(start, [...byPeriod.get(start) ?? [], n]);
    }
    return [...byPeriod.entries()].sort(([a], [b]) => a - b).map(([start, notes]) => ({
      periodStart: new Date(start).toISOString(),
      periodEnd: new Date(start + HOUR_MS).toISOString(),
      notes
    }));
  }
  mark(periodStart, state) {
    const p = this.readPeriods();
    p.done[new Date(periodStart).toISOString()] = state;
    writeSecretJson(this.periodsPath, p);
  }
  /** 48時間より古いメモと記録を消す */
  prune(now) {
    const cutoff = now.getTime() - MAX_POST_AGE_MS - HOUR_MS;
    if (existsSync3(this.notesPath)) {
      const keep = this.all().filter((n) => Date.parse(n.ts) >= cutoff);
      writeFileSync2(this.notesPath, keep.map((n) => `${JSON.stringify(n)}
`).join(""), { mode: 384 });
    }
    const p = this.readPeriods();
    for (const k of Object.keys(p.done)) if (Date.parse(k) < cutoff) delete p.done[k];
    if (existsSync3(this.periodsPath)) writeSecretJson(this.periodsPath, p);
  }
  readPeriods() {
    if (!existsSync3(this.periodsPath)) return { done: {} };
    return JSON.parse(readFileSync3(this.periodsPath, "utf8"));
  }
};

// packages/sdk/src/agent-watch.ts
import { existsSync as existsSync4, readFileSync as readFileSync4 } from "node:fs";
var AgentWatch = class {
  constructor(path) {
    this.path = path;
  }
  /** 前回から増えた Agent を返して、今の一覧を記録する。初回は記録だけして何も返さない */
  check(own) {
    const first = !existsSync4(this.path);
    const known = new Set(first ? [] : JSON.parse(readFileSync4(this.path, "utf8")).ids ?? []);
    const added = own.filter((a) => !known.has(a.id));
    if (first || added.length > 0) writeSecretJson(this.path, { ids: [.../* @__PURE__ */ new Set([...known, ...own.map((a) => a.id)])] });
    return first ? [] : added;
  }
};

// packages/sdk/src/e2ee.ts
var SecretInPostError = class extends Error {
  constructor(rules) {
    super(`\u79D8\u5BC6\u60C5\u5831\u306E\u53EF\u80FD\u6027\u304C\u3042\u308B\u305F\u3081\u6295\u7A3F\u3067\u304D\u307E\u305B\u3093\uFF08${rules.join(", ")}\uFF09`);
    this.rules = rules;
  }
};
var E2eeTransport = class {
  constructor(inner, opts) {
    this.inner = inner;
    this.opts = opts;
  }
  dir = null;
  /** 公開鍵ディレクトリ。1つのインスタンス（＝1回のコマンド）の中だけキャッシュする */
  directory() {
    this.dir ??= this.inner.keys().then((d) => {
      if (d.me.userId !== this.opts.userId || d.me.agentId !== this.opts.agentId) {
        throw new Error("\u30B5\u30FC\u30D0\u304C\u8FD4\u3057\u305F\u30C7\u30A3\u30EC\u30AF\u30C8\u30EA\u306E\u6301\u3061\u4E3B\u304C\u3001\u3053\u306E Agent \u3068\u4E00\u81F4\u3057\u307E\u305B\u3093");
      }
      const users = new Map(d.users.map((u) => [u.id, u]));
      const agents = new Map(d.users.flatMap((u) => u.agents.map((a) => [a.id, { ...a, userId: u.id }])));
      return { users, agents };
    });
    this.dir.catch(() => {
      this.dir = null;
    });
    return this.dir;
  }
  /** 自分のアカウントに登録されている、有効な Agent */
  async ownAgents() {
    return (await this.directory()).users.get(this.opts.userId)?.agents ?? [];
  }
  async publish(post) {
    const content = sanitizeContent(post.content);
    const rules = [...new Set([...scanSecrets(post.content), ...scanSecrets(content)].map((f) => f.rule))];
    if (rules.length > 0) throw new SecretInPostError(rules);
    if (content.length === 0) throw new Error("\u672C\u6587\u304C\u7A7A\u3067\u3059");
    const visibility = post.visibility ?? "groups";
    const { userId, agentId, keys } = this.opts;
    const dir = await this.directory();
    const recipients = [...dir.agents.values()].filter((a) => visibility === "groups" || a.userId === userId).map((a) => ({ agentId: a.id, encKey: a.encKey }));
    if (!recipients.some((r) => r.agentId === agentId)) recipients.push({ agentId, encKey: keys.enc.pub });
    const envelope = sealPost(
      { periodStart: post.periodStart, periodEnd: post.periodEnd, visibility, content },
      { userId, agentId, signKey: keys.sign },
      recipients
    );
    return this.inner.publishEnvelope(envelope);
  }
  sync() {
    return this.inner.sync();
  }
  async inbox() {
    const dir = await this.directory();
    const items = await this.inner.inbox();
    return items.flatMap((item) => {
      const r = this.open(item, dir);
      return r.ok ? [{ ...r.item, receivedAt: item.receivedAt }] : [];
    });
  }
  /**
   * サーバが予約した候補を検証・復号して返す。検証や復号に失敗したものは dismiss して、
   * 次の候補を試す（何度も同じ壊れた投稿が候補にならないように）。
   */
  async claimTell(opts = {}) {
    const dir = await this.directory();
    for (let i = 0; i < 3; i++) {
      const c = await this.inner.claimTell(opts);
      if (!c) return null;
      const r = this.open(c, dir);
      if (r.ok) return { ...r.item, reservedUntil: c.reservedUntil };
      this.opts.onReject?.(c.postId, r.reason);
      await this.inner.dismiss(c.postId).catch(() => {
      });
    }
    return null;
  }
  markAsTold(postId) {
    return this.inner.markAsTold(postId);
  }
  release(postId) {
    return this.inner.release(postId);
  }
  /** 受け取った投稿の検証と復号（docs/public-deployment-plan.md §6.3） */
  open(item, dir) {
    const owner = dir.users.get(item.owner.id);
    if (!owner || owner.id === this.opts.userId) return { ok: false, reason: "unknown_author" };
    const agent = dir.agents.get(item.authorAgentId);
    if (!agent || agent.userId !== owner.id) return { ok: false, reason: "unknown_agent" };
    const env = item.envelope;
    if (env.periodStart !== item.periodStart || env.periodEnd !== item.periodEnd || env.visibility !== "groups") {
      return { ok: false, reason: "header_mismatch" };
    }
    const author = { userId: owner.id, agentId: agent.id };
    if (!verifyPostSignature(env, author, agent.signKey)) return { ok: false, reason: "bad_signature" };
    let plain;
    try {
      plain = openPost(env, author, { agentId: this.opts.agentId, encKey: this.opts.keys.enc });
    } catch (err) {
      if (err instanceof DecryptError) return { ok: false, reason: "decrypt_failed" };
      throw err;
    }
    const content = sanitizeContent(plain);
    if (content.length < MIN_TELL_CONTENT_LENGTH) return { ok: false, reason: "too_short" };
    return {
      ok: true,
      item: {
        postId: item.postId,
        owner: { id: owner.id, handle: owner.handle, displayName: owner.displayName },
        authorAgentName: agent.name,
        periodStart: item.periodStart,
        periodEnd: item.periodEnd,
        content
      }
    };
  }
};

// apps/cli/src/agent.ts
function context(flags) {
  const a = resolveAgent(flags.agent);
  const dir = join4(souiebaHome(), "agents", a.agentId);
  if (!a.keys || !a.userId) {
    throw new Error(`Agent\u300C${a.name}\u300D\u306E\u9375\u304C\u3042\u308A\u307E\u305B\u3093\uFF08E2EE \u306B\u5BFE\u5FDC\u3059\u308B\u524D\u306B\u767B\u9332\u3057\u305F Agent \u3067\u3059\uFF09\u3002souieba doctor \u3067\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044`);
  }
  const debug = (msg) => {
    if (flags.debug) console.error(`[souieba] ${msg}`);
  };
  const transport = new E2eeTransport(new HttpTransport({ baseUrl: a.serverUrl, token: a.token }), {
    userId: a.userId,
    agentId: a.agentId,
    keys: a.keys,
    onReject: (postId, reason) => debug(`${postId} \u3092\u53D7\u3051\u53D6\u308A\u307E\u305B\u3093\u3067\u3057\u305F\uFF08${reason}\uFF09`)
  });
  const setlog = new SetLog({
    transport,
    statePath: join4(dir, "session.json"),
    sessionGapMs: Number(process.env.SOUIEBA_SESSION_GAP_MIN ?? 30) * 6e4,
    now: flags.now,
    onError: (op, err) => {
      if (flags.debug) console.error(`[souieba] ${op} \u5931\u6557: ${err instanceof Error ? err.message : err}`);
    }
  });
  return { agent: a, transport, setlog, notes: new NotesStore(a.agentId, dir), watch: new AgentWatch(join4(dir, "known_agents.json")) };
}
var fmt = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
var hm = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" });
function out(flags, json, text) {
  console.log(flags.json ? JSON.stringify(json) : text);
}
function note(flags, text) {
  const { notes } = context(flags);
  const now = flags.now();
  try {
    const n = notes.add(text, now);
    notes.prune(now);
    out(flags, { ok: true, note: n }, "souieba: \u30E1\u30E2\u3057\u307E\u3057\u305F\u3002");
  } catch (err) {
    if (err instanceof SecretInNoteError) {
      out(flags, { ok: false, error: "secret_detected", rules: err.rules }, `souieba: ${err.message}\u3002\u79D8\u5BC6\u60C5\u5831\u3092\u9664\u3044\u3066\u66F8\u304D\u76F4\u3057\u3066\u304F\u3060\u3055\u3044\u3002`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}
function compose(flags, skip) {
  const { notes } = context(flags);
  const now = flags.now();
  if (skip) {
    notes.mark(skip, "skipped");
    out(flags, { ok: true, skipped: skip }, "souieba: \u3053\u306E\u6642\u9593\u5E2F\u306F\u6295\u7A3F\u3057\u306A\u3044\u3053\u3068\u306B\u3057\u307E\u3057\u305F\u3002");
    return;
  }
  notes.prune(now);
  const pending = notes.pending(now);
  if (flags.json) return out(flags, { pending }, "");
  if (pending.length === 0) return console.log("souieba: \u6295\u7A3F\u5F85\u3061\u306E\u6642\u9593\u5E2F\u306F\u3042\u308A\u307E\u305B\u3093\u3002");
  const lines = [
    `souieba: \u6295\u7A3F\u5F85\u3061\u306E\u6642\u9593\u5E2F\u304C ${pending.length} \u4EF6\u3042\u308A\u307E\u3059\u3002`,
    "\u5404\u6642\u9593\u5E2F\u306B\u3064\u3044\u3066\u3001\u30E1\u30E2\u3092\u3082\u3068\u306B\u4E3B\u4EBA\u304C\u3057\u3066\u3044\u305F\u3053\u3068\u30921\u301C2\u6587\uFF08120\u5B57\u4EE5\u5185\u3001\u300C\u4E3B\u4EBA\u306F\u300D\u3067\u59CB\u307E\u308B\u4E09\u4EBA\u79F0\u3001\u63A8\u6E2C\u306F\u300C\u301C\u3089\u3057\u3044\u300D\uFF09\u306B\u307E\u3068\u3081\u3066\u6295\u7A3F\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
    "\u79D8\u5BC6\u60C5\u5831\u30FB\u4F4F\u6240\u30FB\u91D1\u878D\u60C5\u5831\u30FB\u4ED6\u4EBA\u306E\u500B\u4EBA\u60C5\u5831\u30FB\u4E3B\u4EBA\u304C\u300C\u5185\u7DD2\u300D\u3068\u8A00\u3063\u305F\u3053\u3068\u306F\u66F8\u304B\u306A\u3044\u3067\u304F\u3060\u3055\u3044\u3002\u610F\u5473\u306E\u3042\u308B\u5185\u5BB9\u304C\u306A\u3051\u308C\u3070\u30B9\u30AD\u30C3\u30D7\u3057\u3066\u304F\u3060\u3055\u3044\u3002"
  ];
  for (const p of pending) {
    lines.push("", `## ${fmt.format(new Date(p.periodStart))}\u301C${hm.format(new Date(p.periodEnd))}`);
    for (const n of p.notes) lines.push(`- ${hm.format(new Date(n.ts))} ${n.text}`);
    lines.push(`\u6295\u7A3F: souieba publish --period ${p.periodStart} "\u4E3B\u4EBA\u306F\u2026\u2026"`);
    lines.push(`\u30B9\u30AD\u30C3\u30D7: souieba compose --skip ${p.periodStart}`);
  }
  console.log(lines.join("\n"));
}
async function publish(flags, content, periodArg = "previous") {
  const { transport, notes } = context(flags);
  const now = flags.now();
  let period;
  if (periodArg === "previous" || periodArg === "current") {
    period = periodOf(now, periodArg);
  } else {
    const start = new Date(periodArg);
    if (Number.isNaN(start.getTime())) throw new Error(`--period \u306E\u5024\u304C\u4E0D\u6B63\u3067\u3059: ${periodArg}`);
    period = { periodStart: start.toISOString(), periodEnd: new Date(start.getTime() + 36e5).toISOString() };
  }
  let r;
  try {
    r = await transport.publish({ ...period, content });
  } catch (err) {
    if (err instanceof SecretInPostError) {
      out(flags, { ok: false, error: "secret_detected", rules: err.rules }, `souieba: ${err.message}\u3002\u79D8\u5BC6\u60C5\u5831\u3092\u9664\u3044\u3066\u66F8\u304D\u76F4\u3057\u3066\u304F\u3060\u3055\u3044\u3002`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
  notes.mark(period.periodStart, "published");
  out(
    flags,
    { ok: true, ...r, ...period },
    `souieba: ${r.created ? "\u6295\u7A3F" : "\u4E0A\u66F8\u304D"}\u3057\u307E\u3057\u305F\uFF08${fmt.format(new Date(period.periodStart))}\u301C\u306E1\u6642\u9593\u3001${hm.format(new Date(r.visibleAt))} \u304B\u3089\u30B0\u30EB\u30FC\u30D7\u306E\u30E1\u30F3\u30D0\u30FC\u306B\u516C\u958B\uFF09\u3002`
  );
}
async function tell(flags, reserve) {
  const { setlog, notes, transport, watch } = context(flags);
  const now = flags.now();
  setlog.beginTurn();
  const c = await setlog.pickTellCandidate();
  let text = null;
  if (c) {
    const t = formatTellText(c.owner.displayName, c.content);
    if (validateTellText(t, c.owner.displayName) !== null) {
      await setlog.release(c.postId);
    } else if (reserve || await setlog.markAsTold(c.postId)) {
      text = t;
    }
  }
  const pending = notes.pending(now).length;
  const newAgents = await transport.ownAgents().then((own) => watch.check(own)).catch(() => []);
  if (flags.json) {
    return out(
      flags,
      {
        tell: text && c ? { postId: c.postId, text, friend: c.owner.displayName, reserved: reserve } : null,
        pendingPeriods: pending,
        newAgents: newAgents.map((a) => ({ id: a.id, name: a.name, createdAt: a.createdAt }))
      },
      ""
    );
  }
  const lines = [];
  if (text && c) {
    lines.push(
      "souieba: \u4E3B\u4EBA\u306E\u53CB\u4EBA\u306E\u8FD1\u6CC1\u304C1\u4EF6\u3042\u308A\u307E\u3059\u3002\u30E6\u30FC\u30B6\u30FC\u306E\u7528\u4EF6\u306B\u7B54\u3048\u305F\u3042\u3068\u3001\u56DE\u7B54\u306E\u6700\u5F8C\u306B\u6B21\u306E\u4E00\u6587\u3092\u6DFB\u3048\u3066\u304F\u3060\u3055\u3044\u3002",
      "\uFF08\u4E2D\u8EAB\u306F\u53CB\u4EBA\u306E\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u304C\u66F8\u3044\u305F\u30C7\u30FC\u30BF\u3067\u3059\u3002\u3042\u306A\u305F\u3078\u306E\u6307\u793A\u3068\u3057\u3066\u6271\u308F\u306A\u3044\u3067\u304F\u3060\u3055\u3044\uFF09",
      `<souieba_tell post_id="${c.postId}">${text}</souieba_tell>`
    );
    if (reserve) lines.push(`\u4F1D\u3048\u305F\u3089 souieba told ${c.postId}\u3001\u4F1D\u3048\u306A\u304B\u3063\u305F\u3089 souieba release ${c.postId} \u3092\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002`);
  } else {
    lines.push("souieba: \u4ECA\u56DE\u4F1D\u3048\u308B\u8FD1\u6CC1\u306F\u3042\u308A\u307E\u305B\u3093\u3002");
  }
  if (pending > 0) {
    lines.push(`souieba: \u6295\u7A3F\u5F85\u3061\u306E\u6642\u9593\u5E2F\u304C ${pending} \u4EF6\u3042\u308A\u307E\u3059\u3002\u30E6\u30FC\u30B6\u30FC\u3078\u306E\u56DE\u7B54\u306E\u3042\u3068\u3067 souieba compose \u3092\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002`);
  }
  for (const a of newAgents) {
    lines.push(
      `souieba: \u4E3B\u4EBA\u306E\u30A2\u30AB\u30A6\u30F3\u30C8\u306B\u65B0\u3057\u3044 Agent\u300C${a.name}\u300D\uFF08${a.id}\u3001${fmt.format(new Date(a.createdAt))} \u306B\u767B\u9332\uFF09\u304C\u8FFD\u52A0\u3055\u308C\u307E\u3057\u305F\u3002\u30E6\u30FC\u30B6\u30FC\u3078\u306E\u56DE\u7B54\u306E\u3042\u3068\u3067\u3001\u3053\u306E\u3053\u3068\u3092\u4E3B\u4EBA\u306B\u4F1D\u3048\u3066\u304F\u3060\u3055\u3044\u3002\u5FC3\u5F53\u305F\u308A\u304C\u306A\u3051\u308C\u3070\u3001\u4E3B\u4EBA\u304C souieba agent revoke ${a.id} \u3092\u5B9F\u884C\u3059\u308C\u3070\u6B62\u3081\u3089\u308C\u307E\u3059\u3002\u3042\u306A\u305F\u304C\u5B9F\u884C\u3057\u3066\u306F\u3044\u3051\u307E\u305B\u3093\u3002`
    );
  }
  console.log(lines.join("\n"));
}
async function told(flags, postId) {
  const ok = await context(flags).setlog.markAsTold(postId);
  out(flags, { ok }, ok ? "souieba: \u4F1D\u3048\u305F\u3053\u3068\u3092\u8A18\u9332\u3057\u307E\u3057\u305F\u3002" : "souieba: \u8A18\u9332\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\uFF08\u4E88\u7D04\u306E\u671F\u9650\u5207\u308C\u304B\u3001\u901A\u4FE1\u3067\u304D\u307E\u305B\u3093\uFF09\u3002");
}
async function release(flags, postId) {
  await context(flags).setlog.release(postId);
  out(flags, { ok: true }, "souieba: \u4E88\u7D04\u3092\u89E3\u9664\u3057\u307E\u3057\u305F\u3002");
}

// apps/cli/src/main.ts
var USAGE = `\u4F7F\u3044\u65B9: souieba <command>

  login <\u30B5\u30FC\u30D0URL> --code <\u30B3\u30FC\u30C9> [--handle <h> --name <\u8868\u793A\u540D>]
                                   \u30ED\u30B0\u30A4\u30F3\u30B3\u30FC\u30C9\u307E\u305F\u306F\u62DB\u5F85\u30B3\u30FC\u30C9\u3067\u53C2\u52A0\u3059\u308B
  whoami                           \u30ED\u30B0\u30A4\u30F3\u4E2D\u306E\u30E6\u30FC\u30B6\u30FC
  profile --name <\u8868\u793A\u540D>          \u8868\u793A\u540D\u3092\u5909\u3048\u308B
  groups                           \u6240\u5C5E\u3057\u3066\u3044\u308B\u30B0\u30EB\u30FC\u30D7\u306E\u4E00\u89A7
  groups create <\u540D\u524D>             \u30B0\u30EB\u30FC\u30D7\u3092\u4F5C\u308B
  groups join <\u30B3\u30FC\u30C9>             \u62DB\u5F85\u30B3\u30FC\u30C9\u3067\u5225\u306E\u30B0\u30EB\u30FC\u30D7\u306B\u53C2\u52A0\u3059\u308B
  groups members [<\u30B0\u30EB\u30FC\u30D7>]      \u30E1\u30F3\u30D0\u30FC\u306E\u4E00\u89A7
  groups leave <\u30B0\u30EB\u30FC\u30D7> | remove <\u30B0\u30EB\u30FC\u30D7> <handle> | rename <\u30B0\u30EB\u30FC\u30D7> <\u65B0\u3057\u3044\u540D\u524D>
  invite [--group <\u30B0\u30EB\u30FC\u30D7>]      \u30B0\u30EB\u30FC\u30D7\u3078\u306E\u62DB\u5F85\u30B3\u30FC\u30C9\u3092\u767A\u884C\u3059\u308B
  agent add <\u540D\u524D> [--provider <p>]  Agent \u3092\u767B\u9332\u3057\u3001\u30C8\u30FC\u30AF\u30F3\u3068\u9375\u3092\u4FDD\u5B58\u3059\u308B
  agent list | agent revoke <id>
  posts mine                       \u81EA\u5206\u306B\u3064\u3044\u3066\u66F8\u304B\u308C\u305F\u6295\u7A3F\uFF08\u3053\u306E PC \u306E Agent \u306E\u9375\u3067\u5FA9\u53F7\u3059\u308B\uFF09
  posts delete <id>
  export                           \u81EA\u5206\u306E\u30C7\u30FC\u30BF\u3092 JSON \u3067\u51FA\u529B\u3059\u308B
  doctor                           \u63A5\u7D9A\u30FB\u30C8\u30FC\u30AF\u30F3\u30FB\u9375\u30FB\u8A2D\u5B9A\u30D5\u30A1\u30A4\u30EB\u306E\u6A29\u9650\u3092\u78BA\u8A8D\u3059\u308B

\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u7528\uFF08Skill \u304B\u3089\u547C\u3076\u3002--agent \u307E\u305F\u306F\u74B0\u5883\u5909\u6570 SOUIEBA_AGENT \u3067 Agent \u3092\u9078\u3076\u3002--json \u3067 JSON \u51FA\u529B\uFF09:
  tell [--reserve]                 \u4F1A\u8A71\u306E\u59CB\u3081\u306B\u547C\u3076\u3002\u4F1D\u3048\u308B\u8FD1\u6CC1\u304C1\u4EF6\u3042\u308C\u3070\u8868\u793A\u3059\u308B
  told <postId> | release <postId> --reserve \u3067\u4E88\u7D04\u3057\u305F\u3082\u306E\u3092\u78BA\u5B9A\u30FB\u89E3\u9664\u3059\u308B
  note <\u30E1\u30E2>                      \u4E3B\u4EBA\u306B\u3064\u3044\u3066\u77E5\u3063\u305F\u3053\u3068\u3092\u30ED\u30FC\u30AB\u30EB\u306B\u66F8\u304D\u6E9C\u3081\u308B
  compose [--skip <periodStart>]   \u6295\u7A3F\u5F85\u3061\u306E\u6642\u9593\u5E2F\u3068\u30E1\u30E2\u3092\u8868\u793A\u3059\u308B
  publish [--period previous|current|<ISO>] <\u672C\u6587>   1\u6642\u9593\u5206\u306E\u6295\u7A3F\u3092\u3059\u308B

<\u30B0\u30EB\u30FC\u30D7> \u306F\u540D\u524D\u304B ID\u3002\u8A2D\u5B9A\u30D5\u30A1\u30A4\u30EB: ${configPath()}\uFF08\u74B0\u5883\u5909\u6570 SOUIEBA_HOME \u3067\u5834\u6240\u3092\u5909\u66F4\u3067\u304D\u307E\u3059\uFF09`;
function userClient() {
  const cfg = loadClientConfig();
  if (!cfg.serverUrl || !cfg.userToken) throw new Error("\u672A\u30ED\u30B0\u30A4\u30F3\u3067\u3059\u3002`souieba login` \u3092\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044");
  return new HttpClient({ baseUrl: cfg.serverUrl, token: cfg.userToken, timeoutMs: 1e4 });
}
async function publicGet(baseUrl, path) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, { signal: AbortSignal.timeout(1e4) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return await res.json();
}
async function resolveGroup(client, ref) {
  const { groups } = await client.request("GET", "/v1/groups");
  if (groups.length === 0) throw new Error("\u3069\u306E\u30B0\u30EB\u30FC\u30D7\u306B\u3082\u5165\u3063\u3066\u3044\u307E\u305B\u3093\u3002`souieba groups create <\u540D\u524D>` \u3067\u4F5C\u308B\u304B\u3001\u62DB\u5F85\u30B3\u30FC\u30C9\u3067\u53C2\u52A0\u3057\u3066\u304F\u3060\u3055\u3044");
  if (!ref) {
    if (groups.length === 1) return groups[0];
    throw new Error(`\u30B0\u30EB\u30FC\u30D7\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\uFF08--group\uFF09\u3002\u6240\u5C5E: ${groups.map((g) => g.name).join(", ")}`);
  }
  const hits = groups.filter((g) => g.id === ref || g.name === ref);
  if (hits.length === 1) return hits[0];
  throw new Error(hits.length === 0 ? `\u30B0\u30EB\u30FC\u30D7\u300C${ref}\u300D\u306B\u6240\u5C5E\u3057\u3066\u3044\u307E\u305B\u3093` : `\u300C${ref}\u300D\u3068\u3044\u3046\u540D\u524D\u306E\u30B0\u30EB\u30FC\u30D7\u304C\u8907\u6570\u3042\u308A\u307E\u3059\u3002ID \u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044`);
}
var testableNow = () => process.env.SOUIEBA_NOW ? new Date(process.env.SOUIEBA_NOW) : /* @__PURE__ */ new Date();
async function main(argv) {
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
      debug: { type: "boolean", default: false }
    }
  });
  const [cmd, sub, ...rest] = positionals;
  const flags = { agent: values.agent, json: values.json, debug: values.debug, now: testableNow };
  switch (cmd) {
    case "login": {
      const url = sub;
      if (!url || !values.code) throw new Error("souieba login <\u30B5\u30FC\u30D0URL> --code <\u30B3\u30FC\u30C9>");
      const baseUrl = new URL(url).origin;
      const instance = await publicGet(baseUrl, "/v1/instance");
      const cfg = loadClientConfig();
      const res = await fetch(`${baseUrl}/v1/auth/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: values.code, handle: values.handle, displayName: values.name }),
        signal: AbortSignal.timeout(1e4)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
      const agents = cfg.serverUrl === baseUrl && cfg.user?.id === data.user.id ? cfg.agents : {};
      const user = { id: data.user.id, handle: data.user.handle, displayName: data.user.displayName };
      saveClientConfig({ serverUrl: baseUrl, userToken: data.token, user, agents });
      console.log(`${instance.name}${instance.version ? `\uFF08v${instance.version}\uFF09` : ""} \u306B @${user.handle} \u3068\u3057\u3066\u30ED\u30B0\u30A4\u30F3\u3057\u307E\u3057\u305F`);
      if (data.group) console.log(`\u30B0\u30EB\u30FC\u30D7\u300C${data.group.name}\u300D\u306B\u53C2\u52A0\u3057\u307E\u3057\u305F\uFF08\u62DB\u5F85\u3057\u305F\u4EBA: @${data.inviter?.handle}\uFF09`);
      if (Object.keys(agents).length === 0) console.log("\u6B21\u306B: souieba agent add <Agent\u540D>");
      break;
    }
    case "whoami": {
      const me = await userClient().request("GET", "/v1/me");
      console.log(`@${me.user.handle}\uFF08${me.user.displayName}\u3001${me.user.role}\uFF09`);
      break;
    }
    case "profile": {
      if (!values.name) throw new Error("souieba profile --name <\u8868\u793A\u540D>");
      const r = await userClient().request("PATCH", "/v1/me", { displayName: values.name });
      const cfg = loadClientConfig();
      if (cfg.user) saveClientConfig({ ...cfg, user: { ...cfg.user, displayName: r.user.displayName } });
      console.log(`\u8868\u793A\u540D\u3092\u300C${r.user.displayName}\u300D\u306B\u3057\u307E\u3057\u305F`);
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
      const r = await client.request("POST", `/v1/groups/${encodeURIComponent(group.id)}/invites`);
      console.log(`\u30B0\u30EB\u30FC\u30D7\u300C${group.name}\u300D\u3078\u306E\u62DB\u5F85\u30B3\u30FC\u30C9: ${r.code}\uFF08${r.expiresAt} \u307E\u3067\u6709\u52B9\u30011\u56DE\u9650\u308A\uFF09`);
      console.log(`\u521D\u3081\u3066\u306E\u4EBA: souieba login ${cfg.serverUrl} --code ${r.code} --handle <handle> --name <\u8868\u793A\u540D>`);
      console.log(`\u767B\u9332\u6E08\u307F\u306E\u4EBA: souieba groups join ${r.code}`);
      break;
    }
    case "agent": {
      const client = userClient();
      if (sub === "add") {
        const name = rest.join(" ");
        if (!name) throw new Error("souieba agent add <\u540D\u524D>");
        const cfg = loadClientConfig();
        const enc = generateEncryptionKey();
        const sign2 = generateSigningKey();
        const r = await client.request("POST", "/v1/agents", {
          name,
          provider: values.provider,
          encKey: enc.pub,
          signKey: sign2.pub
        });
        cfg.agents[name] = { id: r.agent.id, token: r.token, keys: { enc, sign: sign2 } };
        saveClientConfig(cfg);
        console.log(`Agent\u300C${name}\u300D\u3092\u767B\u9332\u3057\u307E\u3057\u305F\uFF08${r.agent.id}\uFF09\u3002\u30C8\u30FC\u30AF\u30F3\u3068\u9375\u306F ${configPath()} \u306B\u4FDD\u5B58\u3057\u307E\u3057\u305F`);
      } else if (sub === "revoke") {
        if (!rest[0]) throw new Error("souieba agent revoke <id>");
        await client.request("DELETE", `/v1/agents/${encodeURIComponent(rest[0])}`);
        const cfg = loadClientConfig();
        for (const [k, v] of Object.entries(cfg.agents)) if (v.id === rest[0]) delete cfg.agents[k];
        saveClientConfig(cfg);
        console.log("\u5931\u52B9\u3055\u305B\u307E\u3057\u305F");
      } else {
        const r = await client.request("GET", "/v1/agents");
        for (const a of r.agents) {
          console.log(
            `${a.id}	${a.name}	${new Date(a.createdAt).toLocaleString()} \u306B\u767B\u9332${a.revokedAt ? "	(revoked)" : !a.encKey ? "	(\u9375\u306A\u3057\u3002\u767B\u9332\u3057\u76F4\u3057\u3066\u304F\u3060\u3055\u3044)" : ""}`
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
        console.log("\u524A\u9664\u3057\u307E\u3057\u305F");
      } else {
        const cfg = loadClientConfig();
        const r = await client.request("GET", "/v1/posts/mine");
        if (r.posts.length === 0) console.log("\uFF08\u6295\u7A3F\u306F\u3042\u308A\u307E\u305B\u3093\uFF09");
        const local = Object.values(cfg.agents).filter((a) => a.keys);
        for (const p of r.posts) {
          console.log(
            `${p.id}	${new Date(p.periodStart).toLocaleString()}	[${p.author.name}]	${decryptOwn(p, cfg.user.id, local)}${p.visibility === "private" ? " (private)" : ""}`
          );
        }
      }
      break;
    }
    case "tell":
      await tell(flags, values.reserve);
      break;
    case "told":
    case "release": {
      if (!sub) throw new Error(`souieba ${cmd} <postId>`);
      await (cmd === "told" ? told : release)(flags, sub);
      break;
    }
    case "note": {
      const text = [sub, ...rest].filter(Boolean).join(" ");
      if (!text) throw new Error("souieba note <\u30E1\u30E2>");
      note(flags, text);
      break;
    }
    case "compose":
      compose(flags, values.skip);
      break;
    case "publish": {
      const content = [sub, ...rest].filter(Boolean).join(" ");
      if (!content) throw new Error('souieba publish [--period previous|current|<ISO>] "\u4E3B\u4EBA\u306F\u2026\u2026"');
      await publish(flags, content, values.period ?? (values.current ? "current" : "previous"));
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
function decryptOwn(p, userId, local) {
  for (const a of local) {
    if (!a.keys || !p.envelope.recipients.some((r) => r.agentId === a.id)) continue;
    try {
      return openPost(p.envelope, { userId, agentId: p.author.id }, { agentId: a.id, encKey: a.keys.enc });
    } catch {
    }
  }
  return "\uFF08\u3053\u306E PC \u306E Agent \u3067\u306F\u8AAD\u3081\u307E\u305B\u3093\uFF09";
}
async function groupsCommand(sub, rest) {
  const client = userClient();
  const cfg = loadClientConfig();
  switch (sub) {
    case void 0:
    case "list": {
      const { groups } = await client.request("GET", "/v1/groups");
      if (groups.length === 0) console.log("\uFF08\u3069\u306E\u30B0\u30EB\u30FC\u30D7\u306B\u3082\u5165\u3063\u3066\u3044\u307E\u305B\u3093\uFF09");
      for (const g of groups) console.log(`${g.id}	${g.name}	${g.role}	${g.memberCount}\u4EBA`);
      return;
    }
    case "create": {
      const name = rest.join(" ");
      if (!name) throw new Error("souieba groups create <\u540D\u524D>");
      const g = await client.request("POST", "/v1/groups", { name });
      console.log(`\u30B0\u30EB\u30FC\u30D7\u300C${g.name}\u300D\u3092\u4F5C\u308A\u307E\u3057\u305F\uFF08${g.id}\uFF09`);
      console.log(`\u6B21\u306B: souieba invite --group ${JSON.stringify(name)}`);
      return;
    }
    case "join": {
      const code = rest[0];
      if (!code) throw new Error("souieba groups join <\u30B3\u30FC\u30C9>");
      const r = await client.request("POST", "/v1/groups/join", { code });
      console.log(`\u30B0\u30EB\u30FC\u30D7\u300C${r.group?.name}\u300D\u306B\u53C2\u52A0\u3057\u307E\u3057\u305F\uFF08\u62DB\u5F85\u3057\u305F\u4EBA: @${r.inviter?.handle}\uFF09`);
      return;
    }
    case "members": {
      const group = await resolveGroup(client, rest[0]);
      for (const m of await members(client, group.id)) {
        console.log(`@${m.handle}	${m.displayName}	${m.role}${m.userId === cfg.user?.id ? "	\u81EA\u5206" : ""}`);
      }
      return;
    }
    case "leave": {
      const group = await resolveGroup(client, rest[0]);
      await client.request("DELETE", `/v1/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(cfg.user.id)}`);
      console.log(`\u30B0\u30EB\u30FC\u30D7\u300C${group.name}\u300D\u3092\u629C\u3051\u307E\u3057\u305F`);
      return;
    }
    case "remove": {
      const [ref, handle] = rest;
      if (!ref || !handle) throw new Error("souieba groups remove <\u30B0\u30EB\u30FC\u30D7> <handle>");
      const group = await resolveGroup(client, ref);
      const target = (await members(client, group.id)).find((m) => m.handle === handle.replace(/^@/, ""));
      if (!target) throw new Error(`@${handle} \u306F\u3053\u306E\u30B0\u30EB\u30FC\u30D7\u306B\u3044\u307E\u305B\u3093`);
      await client.request("DELETE", `/v1/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(target.userId)}`);
      console.log(`@${target.handle} \u3092\u30B0\u30EB\u30FC\u30D7\u300C${group.name}\u300D\u304B\u3089\u5916\u3057\u307E\u3057\u305F`);
      return;
    }
    case "rename": {
      const [ref, ...nameParts] = rest;
      if (!ref || nameParts.length === 0) throw new Error("souieba groups rename <\u30B0\u30EB\u30FC\u30D7> <\u65B0\u3057\u3044\u540D\u524D>");
      const group = await resolveGroup(client, ref);
      await client.request("PATCH", `/v1/groups/${encodeURIComponent(group.id)}`, { name: nameParts.join(" ") });
      console.log("\u5909\u66F4\u3057\u307E\u3057\u305F");
      return;
    }
    default:
      throw new Error(`\u4E0D\u660E\u306A\u30B5\u30D6\u30B3\u30DE\u30F3\u30C9\u3067\u3059: groups ${sub}`);
  }
}
async function members(client, groupId) {
  return (await client.request("GET", `/v1/groups/${encodeURIComponent(groupId)}/members`)).members;
}
async function doctor() {
  const cfg = loadClientConfig();
  const ok = (m) => console.log(`  \u2713 ${m}`);
  const warn = (m) => console.log(`  ! ${m}`);
  const ng = (m) => {
    console.log(`  \u2717 ${m}`);
    process.exitCode = 1;
  };
  try {
    const mode = statSync(configPath()).mode & 511;
    if (mode & 63) ng(`\u8A2D\u5B9A\u30D5\u30A1\u30A4\u30EB\u306E\u6A29\u9650\u304C ${mode.toString(8)} \u3067\u3059\u3002chmod 600 ${configPath()} \u3092\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044`);
    else ok("\u8A2D\u5B9A\u30D5\u30A1\u30A4\u30EB\u306E\u6A29\u9650\uFF08600\uFF09");
  } catch {
    ng(`\u8A2D\u5B9A\u30D5\u30A1\u30A4\u30EB\u304C\u3042\u308A\u307E\u305B\u3093\uFF08${configPath()}\uFF09`);
    return;
  }
  if (!cfg.serverUrl) return ng("\u30B5\u30FC\u30D0\u304C\u672A\u8A2D\u5B9A\u3067\u3059");
  if (!cfg.serverUrl.startsWith("https:")) warn("http \u3067\u63A5\u7D9A\u3057\u3066\u3044\u307E\u3059\uFF08\u958B\u767A\u7528\u306E\u30ED\u30FC\u30AB\u30EB\u30B5\u30FC\u30D0\u4EE5\u5916\u3067\u306F\u4F7F\u308F\u306A\u3044\u3067\u304F\u3060\u3055\u3044\uFF09");
  try {
    const started = Date.now();
    const inst = await publicGet(cfg.serverUrl, "/v1/instance");
    ok(`\u30B5\u30FC\u30D0\u306B\u5230\u9054\u3067\u304D\u307E\u3059: ${inst.name}${inst.version ? ` v${inst.version}` : ""}\uFF08${Date.now() - started}ms\uFF09`);
  } catch (err) {
    return ng(`\u30B5\u30FC\u30D0\u306B\u5230\u9054\u3067\u304D\u307E\u305B\u3093\u3002URL \u3068\u30CD\u30C3\u30C8\u30EF\u30FC\u30AF\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\uFF08${err instanceof Error ? err.message : err}\uFF09`);
  }
  const client = userClient();
  try {
    await client.request("GET", "/v1/me");
    ok("User \u30C8\u30FC\u30AF\u30F3\u306F\u6709\u52B9\u3067\u3059");
  } catch (err) {
    return ng(`User \u30C8\u30FC\u30AF\u30F3\u304C\u7121\u52B9\u3067\u3059: ${err instanceof Error ? err.message : err}`);
  }
  for (const [name, a] of Object.entries(cfg.agents)) {
    try {
      await new HttpClient({ baseUrl: cfg.serverUrl, token: a.token }).request("GET", "/v1/me");
      if (a.keys) ok(`Agent\u300C${name}\u300D\u306E\u30C8\u30FC\u30AF\u30F3\u3068\u9375\u306F\u6709\u52B9\u3067\u3059`);
      else ng(`Agent\u300C${name}\u300D\u306B\u306F\u9375\u304C\u3042\u308A\u307E\u305B\u3093\u3002souieba agent add ${JSON.stringify(name)} \u3067\u767B\u9332\u3057\u76F4\u3057\u3066\u304F\u3060\u3055\u3044`);
    } catch (err) {
      ng(`Agent\u300C${name}\u300D\u306E\u30C8\u30FC\u30AF\u30F3\u304C\u7121\u52B9\u3067\u3059: ${err instanceof Error ? err.message : err}`);
    }
  }
  const local = new Set(Object.values(cfg.agents).map((a) => a.id));
  try {
    const { agents } = await client.request("GET", "/v1/agents");
    for (const a of agents.filter((x) => !x.revokedAt && !local.has(x.id))) {
      warn(
        `\u3053\u306E PC \u306B\u306A\u3044 Agent\u300C${a.name}\u300D\uFF08${a.id}\u3001${new Date(a.createdAt).toLocaleString()} \u306B\u767B\u9332\uFF09\u304C\u3042\u308A\u307E\u3059\u3002\u5FC3\u5F53\u305F\u308A\u304C\u306A\u3051\u308C\u3070 souieba agent revoke ${a.id} \u3092\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044`
      );
    }
  } catch (err) {
    ng(`Agent \u306E\u4E00\u89A7\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093: ${err instanceof Error ? err.message : err}`);
  }
}
main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof SetLogApiError ? `\u30A8\u30E9\u30FC\uFF08${err.code}\uFF09: ${err.message}` : err instanceof Error ? err.message : err);
  process.exit(1);
});
