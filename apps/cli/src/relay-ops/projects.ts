/** プロジェクト・ディレクトリの規則・メモの振り分けの操作 */
import { findInstructionLike, isValidDisplayName, sanitizeContent } from "@souieba/core";
import { resolve } from "node:path";
import { DEFAULT_PROJECT, MAX_PROJECTS, MAX_PROJECT_DESCRIPTION, NotesStore, allowedSet, emptyProject, requireProjectName } from "@souieba/sdk";
import { type Change, OpError, requireProject, projectLabel, dirArg, HOLD, describeDiff, dirScopes } from "./helpers.ts";
import type { OpsEnv } from "./env.ts";

export function projectOps({ ctx, p, load, mutation, dirShifts }: OpsEnv) {
  return {
    /**
     * プロジェクトを作る。共有先は空で始まる（copyDefault なら既定のプロジェクトの共有先と Policy を写す）。
     * ディレクトリを渡せば結び付ける。そのディレクトリのメモが届く相手が増えるなら、広げる操作
     */
    projectAdd(rawName: string, dirs: string[], opts: { copyDefault?: boolean } = {}): Change {
      const s = load();
      let name: string;
      try {
        name = requireProjectName(rawName, s);
      } catch (err) {
        throw new OpError(err instanceof Error ? err.message : String(err));
      }
      if (Object.keys(s.projects).length >= MAX_PROJECTS) throw new OpError(`プロジェクトは ${MAX_PROJECTS} 個までです`);
      const canon = [...new Set(dirs.map(dirArg))];
      const def = s.projects[DEFAULT_PROJECT]!;
      const where = canon.length ? `（ディレクトリ: ${canon.join("、")}）` : "";
      const how = opts.copyDefault ? "既定のプロジェクトの共有先と共有方針を写して" : "共有先を空で";
      return mutation(
        `プロジェクト「${name}」を${how}作ります${where}`,
        (st) => {
          const pr = emptyProject(name, ctx.now().toISOString(), canon);
          if (opts.copyDefault) {
            pr.access = structuredClone(def.access);
            pr.policy = def.policy ? { ...def.policy } : null;
          }
          for (const other of Object.values(st.projects)) other.dirs = other.dirs.filter((d) => !canon.includes(d));
          st.projects[name] = pr;
        },
        `プロジェクト「${name}」を作りました`,
        { shifts: dirShifts(canon) },
      );
    },

    /** ディレクトリを付ける・外す。ほかのプロジェクトに付いていたディレクトリは、そちらから外して付け替える */
    projectDirs(ref: string, add: string[], remove: string[]): Change {
      const s = load();
      const pr = requireProject(s, ref);
      if (pr.name === DEFAULT_PROJECT) throw new OpError("既定のプロジェクトにはディレクトリを付けられません（どのプロジェクトにも入らないディレクトリが既定になります）");
      const addDirs = [...new Set(add.map(dirArg))];
      const removeDirs = remove.map((d) => {
        const hit = pr.dirs.find((x) => x === d || x === resolve(d));
        if (hit) return hit;
        const c = dirArg(d);
        if (!pr.dirs.includes(c)) throw new OpError(`プロジェクト「${pr.name}」にディレクトリ「${d}」は付いていません`);
        return c;
      });
      if (addDirs.length + removeDirs.length === 0) throw new OpError("付ける・外すディレクトリを指定してください");
      const what = [
        addDirs.length ? `プロジェクト「${pr.name}」に ${addDirs.join("、")} を付けます` : "",
        removeDirs.length ? `プロジェクト「${pr.name}」から ${removeDirs.join("、")} を外します（ほかに合うプロジェクトがなければ既定になります）` : "",
      ]
        .filter(Boolean)
        .join("。");
      return mutation(
        what,
        (st) => {
          for (const other of Object.values(st.projects)) if (other.name !== pr.name) other.dirs = other.dirs.filter((d) => !addDirs.includes(d));
          const t = st.projects[pr.name]!;
          t.dirs = [...new Set([...t.dirs.filter((d) => !removeDirs.includes(d)), ...addDirs])];
        },
        `プロジェクト「${pr.name}」のディレクトリを変えました`,
        { shifts: dirShifts([...addDirs, ...removeDirs]), scopes: dirScopes(s, pr.name, addDirs) },
      );
    },

    /** プロジェクトを消す。そのディレクトリと、まだ送っていないメモは既定のプロジェクトになる */
    projectDelete(ref: string): Change {
      const s = load();
      const pr = requireProject(s, ref);
      if (pr.name === DEFAULT_PROJECT) throw new OpError("既定のプロジェクトは消せません");
      return mutation(
        `プロジェクト「${pr.name}」を消します（ディレクトリと、まだ送っていないメモは既定のプロジェクトになります）`,
        (st) => {
          delete st.projects[pr.name];
          st.delegations = (st.delegations ?? []).filter((d) => !("project" in d.scope && d.scope.project === pr.name));
        },
        `プロジェクト「${pr.name}」を消しました`,
        {
          shifts: () => [{ before: pr.name, after: DEFAULT_PROJECT, label: "このプロジェクトのメモ" }],
          after: () => void new NotesStore("", p.dir).move(DEFAULT_PROJECT, { from: pr.name }, ctx.now()),
        },
      );
    },

    /** プロジェクトの名前を変える。共有先・方針・ディレクトリ・メモ・任せた範囲はそのまま付いていく（届く相手は変わらないので、狭める扱い） */
    projectRename(ref: string, rawName: string): Change {
      const s = load();
      const pr = requireProject(s, ref);
      if (pr.name === DEFAULT_PROJECT) throw new OpError("既定のプロジェクトの名前は変えられません");
      let name: string;
      try {
        name = requireProjectName(rawName, s);
      } catch (err) {
        throw new OpError(err instanceof Error ? err.message : String(err));
      }
      return {
        summary: `プロジェクト「${pr.name}」の名前を「${name}」にします`,
        widens: false,
        apply: async () => {
          p.state.update((st) => {
            const t = st.projects[pr.name];
            if (!t) throw new OpError(`プロジェクト「${pr.name}」はありません`);
            if (st.projects[name]) throw new OpError(`プロジェクト「${name}」はすでにあります`);
            delete st.projects[pr.name];
            st.projects[name] = { ...t, name };
            for (const d of st.delegations ?? []) if ("project" in d.scope && d.scope.project === pr.name) d.scope.project = name;
          });
          new NotesStore("", p.dir).renameProject(pr.name, name);
          return `プロジェクト「${pr.name}」の名前を「${name}」にしました`;
        },
      };
    },

    /** プロジェクトの説明（エージェントがメモのプロジェクトを推定するときに読む）。推定を受け付けるプロジェクトで、届く相手がいれば広げる操作 */
    projectDescribe(ref: string, text: string): Change {
      const s = load();
      const pr = requireProject(s, ref);
      const t = sanitizeContent(text).trim().replace(/\s+/g, " ");
      // 説明はエージェントへの手引きに入るので、指示に見える文は断る
      if (findInstructionLike(t).length > 0) throw new OpError("説明に、エージェントへの指示に見える表現が含まれています。どんな作業かだけを短く書いてください");
      if (t.length > MAX_PROJECT_DESCRIPTION) throw new OpError(`説明は ${MAX_PROJECT_DESCRIPTION} 文字までにしてください`);
      const reach = pr.acceptInference !== false && allowedSet(s, pr.name).size > 0;
      return {
        summary: t
          ? `プロジェクト「${projectLabel(pr.name)}」の説明を「${t}」にします${reach ? "（エージェントの推定で、このプロジェクトに入るメモが変わることがあります）" : ""}`
          : `プロジェクト「${projectLabel(pr.name)}」の説明を消します`,
        widens: !!t && reach,
        scopes: [{ kind: "dirs", project: pr.name }],
        apply: async () => {
          p.state.update((st) => {
            const x = st.projects[pr.name];
            if (!x) throw new OpError(`プロジェクト「${pr.name}」はありません`);
            if (t) x.description = t;
            else delete x.description;
          });
          return t ? "説明を設定しました" : "説明を消しました";
        },
      };
    },

    /** エージェントの推定でこのプロジェクトに入れてよいか。入れてよいことにするのは、届く相手がいれば広げる操作（既定や保留より広いことがある） */
    projectInference(ref: string, on: boolean): Change {
      const s = load();
      const pr = requireProject(s, ref);
      const fallback = s.unresolved === "hold" ? HOLD : DEFAULT_PROJECT;
      const diff = on ? describeDiff(s, s, [{ before: fallback, after: pr.name, label: "推定で入るメモ" }]) : { widens: false, note: "" };
      return {
        summary: on
          ? `エージェントの推定で、メモをプロジェクト「${projectLabel(pr.name)}」に入れてよいことにします${diff.note}`
          : `エージェントの推定では、メモをプロジェクト「${projectLabel(pr.name)}」に入れないことにします（ディレクトリなどの規則や、会話ごとの指定では入ります）`,
        widens: on && (diff.widens || allowedSet(s, pr.name).size > 0),
        scopes: [{ kind: "dirs", project: pr.name }],
        apply: async () => {
          p.state.update((st) => {
            const x = st.projects[pr.name];
            if (!x) throw new OpError(`プロジェクト「${pr.name}」はありません`);
            if (on) delete x.acceptInference;
            else x.acceptInference = false;
          });
          return on ? "推定で入れてよいことにしました" : "推定では入れないことにしました";
        },
      };
    },

    /** MCP のクライアントごとの規則。project が null なら外す。決まらないときより届く相手が増えるなら広げる操作 */
    clientRule(rawClient: string, project: string | null): Change {
      const s = load();
      const client = rawClient.trim();
      if (!client || client.length > 80 || !isValidDisplayName(client)) throw new OpError("クライアント名は1〜80文字の名前にしてください（MCP の clientInfo.name。例: claude-ai）");
      const fallback = s.unresolved === "hold" ? HOLD : DEFAULT_PROJECT;
      const cur = s.clients?.[client];
      if (project === null) {
        if (!cur) throw new OpError(`クライアント「${client}」の規則はありません`);
        const diff = describeDiff(s, s, [{ before: cur, after: fallback, label: `${client} のメモ` }]);
        return {
          summary: `MCP クライアント「${client}」の規則（→ ${projectLabel(cur)}）を外します${diff.note}`,
          widens: diff.widens,
          scopes: [{ kind: "dirs", project: fallback === HOLD ? DEFAULT_PROJECT : fallback }],
          apply: async () => {
            p.state.update((st) => {
              if (st.clients) delete st.clients[client];
            });
            return "規則を外しました";
          },
        };
      }
      const pr = requireProject(s, project).name;
      const diff = describeDiff(s, s, [{ before: cur ?? fallback, after: pr, label: `${client} のメモ` }]);
      return {
        summary: `MCP クライアント「${client}」からのメモを、プロジェクト「${projectLabel(pr)}」に入れます${diff.note}`,
        widens: diff.widens,
        scopes: [{ kind: "dirs", project: pr }],
        apply: async () => {
          p.state.update((st) => {
            if (!st.projects[pr]) throw new OpError(`プロジェクト「${pr}」はありません`);
            st.clients = { ...(st.clients ?? {}), [client]: pr };
          });
          return `「${client}」のメモを「${projectLabel(pr)}」に入れることにしました`;
        },
      };
    },

    /** どのプロジェクトにも決まらないメモの扱い。保留から既定に戻すのは、既定の共有先がいれば広げる操作 */
    unresolvedMode(mode: "default" | "hold"): Change {
      const s = load();
      const cur = s.unresolved === "hold" ? "hold" : "default";
      const diff = mode === "default" && cur === "hold" ? describeDiff(s, s, [{ before: HOLD, after: DEFAULT_PROJECT, label: "決まらないメモ" }]) : { widens: false, note: "" };
      return {
        summary:
          mode === "hold"
            ? "どのプロジェクトにも決まらないメモは、主人が振り分けるまで保留にします（送りません）"
            : `どのプロジェクトにも決まらないメモは、既定のプロジェクトに入れます${diff.note}`,
        widens: diff.widens,
        apply: async () => {
          p.state.update((st) => void (st.unresolved = mode));
          return mode === "hold" ? "保留にすることにしました" : "既定に入れることにしました";
        },
      };
    },

    /**
     * 会話ごとの指定（pin）。主人が「この会話は仕事」と言ったときだけ使う。project が null なら外す。
     * baseline は、指定がなければこの会話のメモが入るプロジェクト（null なら保留）。それより届く相手が増えるなら広げる操作（任せることはできない）
     */
    pin(project: string | null, baseline: string | null, set: (project: string | null) => void): Change {
      const s = load();
      const base = baseline && s.projects[baseline] ? baseline : baseline === null ? HOLD : DEFAULT_PROJECT;
      if (project === null) {
        return {
          summary: "この会話のプロジェクトの指定を外します",
          widens: false,
          apply: async () => {
            set(null);
            return "この会話のプロジェクトの指定を外しました";
          },
        };
      }
      const pr = requireProject(s, project).name;
      const diff = describeDiff(s, s, [{ before: base, after: pr, label: "この会話のメモ" }]);
      return {
        summary: `この会話のメモを、プロジェクト「${projectLabel(pr)}」に入れます（ディレクトリや MCP クライアントの規則が当てはまるときは、そちらが優先）${diff.note}`,
        widens: diff.widens,
        apply: async () => {
          set(pr);
          return `この会話のメモを「${projectLabel(pr)}」に入れることにしました`;
        },
      };
    },

    /** まだ送っていないメモを別のプロジェクトに付け替える（souieba note move）。届く相手が増えるなら広げる操作 */
    noteMove(to: string, opts: { from?: string; periodStart?: string; held?: boolean; ts?: string }): Change {
      const s = load();
      const target = requireProject(s, to).name;
      const from = opts.from !== undefined ? requireProject(s, opts.from).name : undefined;
      const sources = opts.held ? [HOLD] : from !== undefined ? [from] : Object.keys(s.projects).filter((n) => n !== target);
      const label = (n: string) => (n === DEFAULT_PROJECT ? "既定" : `「${n}」`);
      const diff = describeDiff(
        s,
        s,
        sources.map((n) => ({ before: n, after: target, label: n === HOLD ? "保留のメモ" : `${label(n)}のメモ` })),
      );
      const what = `${opts.held ? "保留の" : from !== undefined ? `プロジェクト${label(from)}の` : ""}${opts.ts ? `${opts.ts} の` : opts.periodStart ? `${opts.periodStart} からの時間帯の` : ""}まだ送っていないメモを、プロジェクト${label(target)}に移します`;
      return {
        summary: `${what}${diff.note}`,
        widens: diff.widens,
        apply: async () => {
          const n = new NotesStore("", p.dir).move(target, { from, periodStart: opts.periodStart, held: opts.held, ts: opts.ts }, ctx.now());
          return n > 0 ? `${n} 件のメモをプロジェクト${label(target)}に移しました` : "移すメモはありませんでした";
        },
      };
    },
  };
}
