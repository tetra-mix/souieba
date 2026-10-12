export function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/**
 * レート制限で数える送信元のキー。IPv6 は /64 でまとめる（1つの回線に /64 以上が割り当てられるので、
 * アドレスを変えながら送れば、1つずつ数えても制限にならない）。IPv4 はそのまま
 */
export function rateLimitKey(ip: string): string {
  const v = normalizeIp(ip).split("%")[0]!;
  if (!v.includes(":")) return v;
  // IPv4 を埋め込んだ表記（64:ff9b::1.2.3.4 など）は、末尾の2つ分として数える
  const parts = (s: string) => (s ? s.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g])) : []);
  const [head = "", tail] = v.split("::");
  const h = parts(head);
  const t = tail === undefined ? [] : parts(tail);
  const full = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${full
    .slice(0, 4)
    .map((g) => (Number.parseInt(g, 16) || 0).toString(16))
    .join(":")}::/64`;
}

export function isLoopback(ip: string): boolean {
  const v = normalizeIp(ip);
  return v === "::1" || v.startsWith("127.");
}

/** プライベート・ループバック・CGNAT・リンクローカルのアドレスか（TRUST_PROXY=private の判定に使う） */
export function isPrivateOrLoopback(ip: string): boolean {
  const v = normalizeIp(ip);
  if (v === "::1" || v === "localhost") return true;
  if (v.includes(":")) return /^f[cd]/i.test(v) || /^fe80/i.test(v); // IPv6: ULA / link-local
  const p = v.split(".").map(Number);
  const [a, b] = [p[0] ?? -1, p[1] ?? -1];
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) // CGNAT
  );
}
