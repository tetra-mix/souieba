/**
 * エージェントのプラグインやフック（OpenClaw のプラグイン、souieba hook）が、主人の発言ごとにエージェントへ渡す文面。
 * スキルを読むかどうか・tell や note を実行するかどうかをモデルの判断に任せず、毎回確実に渡すためのもの。
 */

export const NOTE_GUIDE = [
  "## Souieba",
  "主人は Souieba で、近況をグループの友人たちと共有しています。友人の近況（souieba tell）は Souieba のプラグインやフックが主人の発言ごとに確かめて渡すので、あなたが souieba tell を実行する必要はありません。",
  "主人から作業を頼まれたり、主人がしていること・したこと・これからすることが話に出たりしたら、その都度、回答を書く前に `souieba note \"主人は……\"`（三人称、〜100字）を実行してメモしてください。依頼や話題が変わったとき、進み具合が変わったときも書き足します。",
  "友人への近況はこのメモだけを材料に1時間ごとに書かれるので、迷ったら書いてください。書きすぎても、投稿するときにまとめ直して不要なものは捨てます。メモはこの PC にだけ保存されます。",
  "ただし、認証情報、正確な住所、金融情報、健康や家族などのセンシティブな話題、他人の個人情報、主人が「内緒」「SNS に書かないで」と言ったことは書きません。詳しい書き方は souieba skill get note で確かめられます。",
].join("\n");

const NOTHING_TO_TELL = "souieba: 今回伝える近況はありません。";

/** tell の出力から、エージェントに渡す文脈を作る。伝えることがなければ null */
export function tellContext(stdout: string): string | null {
  const lines = stdout
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l !== "" && l !== NOTHING_TO_TELL);
  if (lines.length === 0) return null;
  return ["（Souieba のプラグインやフックが、主人のこの発言の前に souieba tell を実行した結果です）", ...lines].join("\n");
}
