import { isIP, isIPv4 } from "node:net";

export type Cidr = { base: number; mask: number };

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

/** IPv4 の CIDR だけに対応する（VPN のアドレス範囲を指定する用途で十分なため） */
export function parseCidr(cidr: string): Cidr | null {
  const [ip, bitsStr = "32"] = cidr.split("/");
  const bits = Number(bitsStr);
  if (!ip || !isIPv4(ip) || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { base: ipv4ToInt(ip) & mask, mask };
}

export function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

export function ipInCidrs(ip: string, cidrs: Cidr[]): boolean {
  const v4 = normalizeIp(ip);
  if (!isIPv4(v4)) return false;
  const n = ipv4ToInt(v4);
  return cidrs.some((c) => (n & c.mask) === c.base);
}

export function isLoopback(ip: string): boolean {
  const v = normalizeIp(ip);
  return v === "::1" || v.startsWith("127.");
}

/** プライベート・ループバック・CGNAT（Tailscale）・リンクローカルのアドレスか */
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
    (a === 100 && b >= 64 && b <= 127) // CGNAT（Tailscale）
  );
}
