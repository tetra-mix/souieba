/** 共有先（アクセス権限）・グループ・Policyの操作 */
import { isValidDisplayName } from "@souieba/core";
import { type AccessRule, DEFAULT_PROJECT, MAX_LOCAL_GROUPS, MAX_POLICY_LENGTH, findContact, findGroup, isGroupId } from "@souieba/sdk";
import { type Change, OpError, who, requireContact, requireProject, scope, requireGroup } from "./helpers.ts";
import type { OpsEnv } from "./env.ts";

export function accessOps({ ctx, load, mutation }: OpsEnv) {
  return {
    /** rule が null なら個別の設定を消す。project を省くと既定のプロジェクト */
    setAccess(ref: string, rule: AccessRule | null, project: string = DEFAULT_PROJECT): Change {
      const s = load();
      const pr = requireProject(s, project).name;
      const g = ref.startsWith("group:") || (!findContact(s, ref) && findGroup(s, ref)) ? requireGroup(s, ref) : undefined;
      const id = g ? g.id : requireContact(s, ref).personId;
      const target = g ? `グループ「${g.name}」（${g.members.length}人）` : who(s, id);
      const verb = rule === "allow" ? "に近況を共有してよいことにします" : rule === "deny" ? "には近況を共有しないことにします" : "の個別の設定を消します";
      return mutation(
        `${scope(s, pr)}${target}${verb}`,
        (st) => {
          const acc = st.projects[pr]!.access;
          const table = g ? acc.groups : acc.people;
          if (rule === null) delete table[id];
          else table[id] = rule;
        },
        `${scope(s, pr)}${target}${verb.replace("ことにします", "ことにしました").replace("消します", "消しました")}`,
        { scopes: [{ kind: "audience", project: pr }] },
      );
    },

    groupCreate(id: string, rawName: string): Change {
      const name = rawName.trim() || id;
      if (!isGroupId(id)) throw new OpError("グループの ID は英小文字・数字・-_ で、32文字までにしてください");
      if (!isValidDisplayName(name)) throw new OpError("グループ名は1〜40文字で、日本語・英数字・一部の記号だけにしてください");
      const s = load();
      if (s.groups[id]) throw new OpError(`グループ「${id}」はすでにあります`);
      if (Object.values(s.groups).some((g) => g.name === name) || Object.values(s.contacts).some((c) => c.name === name)) {
        throw new OpError(`「${name}」はほかのグループか連絡先の名前と同じです`);
      }
      if (Object.keys(s.groups).length >= MAX_LOCAL_GROUPS) throw new OpError(`グループは ${MAX_LOCAL_GROUPS} 個までです`);
      return mutation(
        `グループ「${name}」[${id}] を作ります（この PC だけのグループで、相手には共有されません）`,
        (st) => void (st.groups[id] = { id, name, members: [], createdAt: ctx.now().toISOString() }),
        `グループ「${name}」を作りました`,
      );
    },

    groupMembers(ref: string, add: string[], remove: string[]): Change {
      const s = load();
      const g = requireGroup(s, ref);
      const addIds = add.map((r) => requireContact(s, r).personId);
      const removeIds = remove.map((r) => requireContact(s, r).personId);
      if (addIds.length + removeIds.length === 0) throw new OpError("加える・外す相手を指定してください");
      const names = (ids: string[]) => ids.map((id) => s.contacts[id]!.name).join("、");
      const what =
        addIds.length && removeIds.length
          ? `グループ「${g.name}」に ${names(addIds)} を加え、${names(removeIds)} を外します`
          : addIds.length
            ? `グループ「${g.name}」に ${names(addIds)} を加えます`
            : `グループ「${g.name}」から ${names(removeIds)} を外します`;
      return mutation(
        what,
        (st) => {
          const grp = st.groups[g.id]!;
          grp.members = [...new Set([...grp.members.filter((m) => !removeIds.includes(m)), ...addIds])];
        },
        `グループ「${g.name}」のメンバーを変えました`,
        { scopes: [{ kind: "members", group: g.id }] },
      );
    },

    groupDelete(ref: string): Change {
      const s = load();
      const g = requireGroup(s, ref);
      return mutation(
        `グループ「${g.name}」を消します（このグループへの共有の設定も消えます）`,
        (st) => {
          delete st.groups[g.id];
          for (const pr of Object.values(st.projects)) delete pr.access.groups[g.id];
          st.delegations = (st.delegations ?? []).filter((d) => !(d.scope.kind === "members" && d.scope.group === g.id));
        },
        `グループ「${g.name}」を消しました`,
      );
    },

    /** Policy は意味の判断に使うもので、機械的には狭めたか広げたか分からないので、変えるときはいつも承認を取る */
    policySet(text: string, project: string = DEFAULT_PROJECT): Change {
      const t = text.trim();
      if (!t) throw new OpError("共有方針の文章を指定してください");
      if (t.length > MAX_POLICY_LENGTH) throw new OpError(`共有方針は ${MAX_POLICY_LENGTH} 文字までにしてください`);
      const s = load();
      const pr = requireProject(s, project).name;
      return mutation(
        `${scope(s, pr)}共有方針を次の内容にします:\n  ${t}`,
        (st) => void (st.projects[pr]!.policy = { text: t, updatedAt: ctx.now().toISOString() }),
        "共有方針を設定しました",
        { alwaysWidens: true, scopes: [{ kind: "policy", project: pr }] },
      );
    },

    policyClear(project: string = DEFAULT_PROJECT): Change {
      const s = load();
      const pr = requireProject(s, project).name;
      return mutation(`${scope(s, pr)}共有方針を消します（方針による制限がなくなります）`, (st) => void (st.projects[pr]!.policy = null), "共有方針を消しました", {
        alwaysWidens: true,
        scopes: [{ kind: "policy", project: pr }],
      });
    },
  };
}
