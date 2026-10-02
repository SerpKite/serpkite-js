/** Options for {@link verifyWebhook}. */
export interface VerifyWebhookOptions {
  /** Reject deliveries whose timestamp is further than this from now. Default 300. */
  toleranceSeconds?: number;
  /** Current time in Unix seconds (tests). */
  now?: number;
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function header(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const rec = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  const v = key === undefined ? undefined : rec[key];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Checks a batch webhook delivery: `X-SerpKite-Signature` must be
 * `v1=<hex HMAC-SHA256(secret, "<X-SerpKite-Timestamp>.<raw body>")>` and the
 * timestamp recent. Pass the raw request body exactly as received (not
 * re-serialised JSON). Uses Web Crypto (Node 18+, Deno, Bun, browsers).
 *
 * ```ts
 * const ok = await verifyWebhook(process.env.SERPKITE_WEBHOOK_SECRET!, rawBody, req.headers);
 * ```
 */
export async function verifyWebhook(
  secret: string,
  payload: string | Uint8Array,
  headers: HeaderSource,
  options: VerifyWebhookOptions = {},
): Promise<boolean> {
  const signature = header(headers, "x-serpkite-signature");
  const ts = header(headers, "x-serpkite-timestamp");
  if (!secret || !signature?.startsWith("v1=") || !ts || !/^\d+$/.test(ts)) return false;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > (options.toleranceSeconds ?? 300)) return false;

  const enc = new TextEncoder();
  const body = typeof payload === "string" ? enc.encode(payload) : payload;
  const prefix = enc.encode(`${ts}.`);
  const msg = new Uint8Array(prefix.length + body.length);
  msg.set(prefix);
  msg.set(body, prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const want = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  const got = signature.slice(3).toLowerCase();
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
