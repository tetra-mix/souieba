/** 主人が使うコマンド（init・relay・doctor） */
import { initCommand as createPerson } from "../person.ts";
import { NeedsApprovalError, OwnerOnlyError, relayCommand as runRelay, ttyAsk } from "../relay.ts";
import { isInteractive } from "../tty.ts";
import { skillVersionAdvice, installedSkills } from "../skill.ts";
import { latestVersion, newerThanCurrent, updateAdvice } from "../update-check.ts";
import { type CommandContext, log, testableNow } from "./context.ts";

export async function initCommand({ sub, values }: CommandContext): Promise<void> {
  await createPerson({ url: sub, name: values.name }, { log, now: testableNow });
}

/**
 * 接続・共有の設定のコマンド。`souieba connect …` でも、以前の `souieba connect …` でも同じように動く
 */
export async function relayCommand(ctx: CommandContext): Promise<void> {
  const { values } = ctx;
  const legacy = ctx.cmd === "relay";
  // `souieba relay <sub> <rest...>` と `souieba <sub> <rest...>` の、どちらでも sub・rest・承認後に実行するコマンドの引数を同じにする
  const sub = legacy ? ctx.sub : ctx.cmd;
  const rest = legacy ? ctx.rest : ctx.args;
  const args = legacy ? ctx.args : [ctx.cmd!, ...ctx.args];
  try {
    await runRelay(
      {
        sub,
        rest,
        name: values.name,
        yes: values.yes,
        project: values.project,
        copyDefault: values["copy-default"],
        term: values.for,
        session: values.session,
        // 承認のあとに実行するコマンドは、読み取った値から組み立て直す
        raw: [
          ...args,
          ...(values.name !== undefined ? ["--name", values.name] : []),
          ...(values.project !== undefined ? ["--project", values.project] : []),
          ...(values["copy-default"] ? ["--copy-default"] : []),
          ...(values.session !== undefined ? ["--session", values.session] : []),
        ],
      },
      { log, interactive: isInteractive(), ask: ttyAsk, now: testableNow },
    );
  } catch (err) {
    if (err instanceof OwnerOnlyError) {
      // 任せる操作を端末の外から呼んだとき。--yes を付け直しても通らないので、終了コード 3 ではなく 4 にする
      console.log(err.message);
      process.exitCode = 4;
      return;
    }
    if (!(err instanceof NeedsApprovalError)) throw err;
    // エージェントが --yes なしで実行したとき。案内は標準出力に出し、終了コード 3 で止める
    console.log(err.message);
    process.exitCode = 3;
  }
}

/** CLI・スキルの更新、Person ID、接続の状態をまとめて確かめる */
export async function doctorCommand(): Promise<void> {
  const latest = await latestVersion(testableNow(), { force: true });
  if (newerThanCurrent(latest)) console.log(updateAdvice(latest!));
  for (const skill of installedSkills()) {
    const advice = skillVersionAdvice(skill);
    if (advice) console.log(advice);
  }
  const quiet = { log, interactive: false, ask: async () => false, now: testableNow };
  await runRelay({ sub: "id", rest: [], raw: ["id"] }, quiet);
  await runRelay({ sub: "contacts", rest: [], raw: ["contacts"] }, quiet);
}
