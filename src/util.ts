const enc = new TextEncoder();

export function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

/** 長さも漏らさないよう、ハッシュしてから比較する */
export async function safeEqual(a: string, b: string) {
  const [x, y] = await Promise.all([a, b].map((v) => crypto.subtle.digest("SHA-256", enc.encode(v))));
  return crypto.subtle.timingSafeEqual(x, y);
}

export async function hashHex(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))), (b) => b.toString(16).padStart(2, "0")).join("");
}
