import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG, COMMAND_NAMES, renderRelayUsage, renderUsage, usageFamily, usageOf } from "../src/commands/catalog.ts";
import { COMMANDS } from "../src/commands/index.ts";

const root = join(import.meta.dirname, "../../..");

/** コマンドの実装がなくても、ドキュメントに書いてよいもの */
const EXTRA = ["relay help", "version"];

function files(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, ext, out);
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

const DOC_FILES = [
  join(root, "README.md"),
  join(root, "apps/cli/README.md"),
  join(root, "skills/souieba/SKILL.md"),
  join(root, "apps/site/PRODUCT.md"),
  ...files(join(root, "docs"), /\.md$/),
  ...files(join(root, "apps/cli/skill"), /\.md$/),
  ...files(join(root, "apps/site/src"), /\.(md|mdx|astro)$/),
];

/** コードブロックの行と、インラインコードから、`souieba <コマンド> …` を取り出す */
function commandsIn(text: string): string[][] {
  const found: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    const t = line.replace(/^\s*\$\s*/, "").trim();
    if (fenced && /^souieba(\s|$)/.test(t)) found.push(t);
    for (const m of line.matchAll(/`(souieba [^`]*)`/g)) found.push(m[1]!);
  }
  return found.map((cmd) => {
    const words: string[] = [];
    for (const tok of cmd.split(/\s+/).slice(1)) {
      if (!/^[a-z][a-z0-9-]*$/.test(tok)) break;
      words.push(tok);
    }
    return words;
  });
}

describe("コマンドのカタログ", () => {
  it("使い方を引ける。サブコマンドの一覧も作れる", () => {
    expect(usageOf("relay connect")).toBe("souieba relay connect <Person ID> --name <呼び名>");
    expect(usageFamily("relay groups")).toBe("souieba relay groups [list | create | add | remove | delete]");
    expect(() => usageOf("relay nothing")).toThrow();
  });

  it("名前が重複していない", () => {
    expect(new Set(COMMAND_NAMES).size).toBe(COMMAND_NAMES.length);
  });

  it("トップレベルのコマンドは、すべて実装がある（relay 以外）", () => {
    const tops = new Set(CATALOG.map((c) => c.name.split(" ")[0]!));
    for (const top of tops) {
      if (top === "relay") continue;
      expect(Object.hasOwn(COMMANDS, top), `${top} の実装（commands/index.ts）がありません`).toBe(true);
    }
    expect(Object.hasOwn(COMMANDS, "relay")).toBe(true);
  });

  it("ヘルプには、カタログのコマンドがすべて出る", () => {
    const vars = { topics: "a / b", hooks: "x|y" };
    const top = renderUsage(vars, "/home/.souieba/config.json");
    const relay = renderRelayUsage(vars);
    for (const c of CATALOG) {
      const shown = c.name.startsWith("relay ") ? relay : top;
      const label = c.name.replace(/^relay /, "");
      expect(shown, `${c.name} がヘルプに出ていません`).toContain(label);
    }
  });
});

describe("ドキュメントのコマンド例", () => {
  const known = [...COMMAND_NAMES, ...EXTRA];

  it("README・スキル・サイトの `souieba …` は、カタログにあるコマンドだけ", () => {
    const unknown: string[] = [];
    for (const file of DOC_FILES) {
      for (const words of commandsIn(readFileSync(file, "utf8"))) {
        if (words.length === 0) continue;
        const ok = known.some((name) => {
          const n = name.split(" ");
          // コマンド名で始まる（引数つき）か、`souieba relay` のようにコマンドのグループだけを指している
          return n.length <= words.length ? n.every((w, i) => w === words[i]) : words.every((w, i) => w === n[i]);
        });
        if (!ok) unknown.push(`${file.replace(root + "/", "")}: souieba ${words.join(" ")}`);
      }
    }
    expect(unknown, "カタログにないコマンドが書かれています（コマンドを足したなら commands/catalog.ts にも足してください）").toEqual([]);
  });
});
