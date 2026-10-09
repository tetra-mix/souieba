/** クライアントのバージョンを送るヘッダ。サーバは古いクライアントを 426 で断る */
export const CLIENT_VERSION_HEADER = "x-souieba-client";

/**
 * "x.y.z"（後ろの "-..." は無視）を比べる。a が古ければ負、同じなら 0、新しければ正。
 * 形式が違うものは最も古い扱いにする。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1];
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}
