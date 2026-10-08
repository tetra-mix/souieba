import { isIP } from "node:net";

export function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

export function isLoopback(ip: string): boolean {
  const v = normalizeIp(ip);
  return v === "::1" || v.startsWith("127.");
}

/** プライベート・ループバック・CGNAT・リンクローカルのアドレスか（TRUST_PROXY=private の判定に使う） */
export function isPrivateOrLoopback(ip: string): boolean {
  const v = normalizeIp(ip);
  if (v === "::1" || v === "localhost") return true;
  if (isIP(v) === 6) return /^f[cd]/i.test(v) || /^fe80/i.test(v); // ULA / link-local
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
