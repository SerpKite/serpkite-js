import { afterEach, describe, expect, test } from "bun:test";
import {
  isBatchError,
  parseRetryAfter,
  type ResponseInfo,
  type SearchResponse,
  SerpKite,
  SerpKiteError,
  verifyWebhook,
} from "../src/index";

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

type Reply = Response | Error | ((req: Seen) => Response | Promise<Response>);

function mockFetch(...replies: Reply[]) {
  const seen: Seen[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const req: Seen = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    seen.push(req);
    const r = replies.length > 1 ? replies.shift() : replies[0];
    if (r === undefined) throw new Error("no reply configured");
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r(req) : r.clone();
  };
  return { fetch: fn as unknown as typeof fetch, seen };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const errorBody = (code: string, message: string, request_id = "req_1") => ({
  error: { code, message, request_id },
});

const searchBody: SearchResponse = {
  request: { endpoint: "search", engine: "google", q: "best espresso" },
  results: [
    { position: 1, title: "Espresso", link: "https://example.com/", domain: "example.com" },
  ],
  related_searches: [],
  meta: { request_id: "req_1", credits_used: 1, cached: false },
};

const client = (f: typeof fetch, extra: Partial<ConstructorParameters<typeof SerpKite>[0]> = {}) =>
  new SerpKite({
    apiKey: "skt_live_test",
    baseUrl: "https://api.test/",
    fetch: f,
    retryDelayMs: 1,
    ...extra,
  });

describe("SerpKite", () => {
  const saved = process.env.SERPKITE_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.SERPKITE_API_KEY;
    else process.env.SERPKITE_API_KEY = saved;
  });

  test("sends the bearer key and JSON body to /v1/search", async () => {
    const m = mockFetch(
      json(searchBody, 200, {
        "x-credits-used": "1",
        "x-credits-remaining": "99.5",
        "x-cache": "MISS",
        "x-request-id": "req_1",
      }),
    );
    let info: ResponseInfo | undefined;
    const res = await client(m.fetch).search(
      { q: "best espresso", country: "us" },
      {
        onResponse: (i) => {
          info = i;
        },
      },
    );
    expect(res.results[0].title).toBe("Espresso");
    expect(res.meta.credits_used).toBe(1);
    const req = m.seen[0];
    expect(req.url).toBe("https://api.test/v1/search");
    expect(req.method).toBe("POST");
    expect(req.headers.get("authorization")).toBe("Bearer skt_live_test");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(req.headers.get("user-agent")).toStartWith("serpkite-typescript/");
    expect(req.body).toEqual({ q: "best espresso", country: "us" });
    expect(info?.creditsUsed).toBe(1);
    expect(info?.creditsRemaining).toBe(99.5);
    expect(info?.cache).toBe("MISS");
    expect(info?.requestId).toBe("req_1");
  });

  test("reads SERPKITE_API_KEY and fails fast without a key", () => {
    process.env.SERPKITE_API_KEY = "skt_live_env";
    expect(() => new SerpKite({ fetch: mockFetch(json({})).fetch })).not.toThrow();
    delete process.env.SERPKITE_API_KEY;
    try {
      new SerpKite();
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SerpKiteError);
      expect((e as SerpKiteError).code).toBe("missing_api_key");
    }
  });

  test("uses the env key in the Authorization header", async () => {
    process.env.SERPKITE_API_KEY = "skt_live_env";
    const m = mockFetch(json(searchBody));
    await new SerpKite({ fetch: m.fetch }).search({ q: "x" });
    expect(m.seen[0].headers.get("authorization")).toBe("Bearer skt_live_env");
    expect(m.seen[0].url).toBe("https://api.serpkite.com/v1/search");
  });

  test("every method hits its path", async () => {
    const m = mockFetch(json({ results: [], meta: {} }));
    const sk = client(m.fetch);
    await sk.images({ q: "a" });
    await sk.videos({ q: "a" });
    await sk.news({ q: "a" });
    await sk.maps({ q: "a", ll: "@40.7,-74,14z" });
    await sk.places({ q: "a" });
    await sk.reviews({ place_id: "ChIJ", sort: "newest" });
    await sk.shopping({ q: "a" });
    await sk.scholar({ q: "a" });
    await sk.patents({ q: "a" });
    await sk.autocomplete({ q: "a" });
    await sk.webpage({ url: "https://example.com" });
    await sk.rank({ q: "a", domain: "example.com", num: 50 });
    await sk.account();
    await sk.batches.get("b1");
    expect(m.seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      "POST /v1/images",
      "POST /v1/videos",
      "POST /v1/news",
      "POST /v1/maps",
      "POST /v1/places",
      "POST /v1/reviews",
      "POST /v1/shopping",
      "POST /v1/scholar",
      "POST /v1/patents",
      "POST /v1/autocomplete",
      "POST /v1/webpage",
      "POST /v1/rank",
      "GET /v1/account",
      "GET /v1/batches/b1",
    ]);
    expect(m.seen[12].body).toBeUndefined();
    expect(m.seen[12].headers.get("content-type")).toBeNull();
  });

  test("engine accepts a provider list and meta.route is typed", async () => {
    const body: SearchResponse = {
      ...searchBody,
      request: { endpoint: "search", engine: ["google", "brave"], q: "best espresso" },
      meta: {
        request_id: "req_1",
        credits_used: 1,
        cached: false,
        engine: "brave",
        route: [
          { provider: "google", outcome: "blocked", ms: 812 },
          { provider: "brave", outcome: "ok", ms: 431 },
        ],
      },
    };
    const m = mockFetch(json(body));
    const sk = client(m.fetch);
    const res = await sk.search({ q: "best espresso", engine: ["google", "brave"] });
    expect(m.seen[0].body).toEqual({ q: "best espresso", engine: ["google", "brave"] });
    expect(res.meta.engine).toBe("brave");
    expect(res.meta.route?.map((s) => s.outcome)).toEqual(["blocked", "ok"]);
    expect(res.request.engine).toEqual(["google", "brave"]);

    await sk.news({ q: "espresso", engine: "auto" });
    // @ts-expect-error: list items must be known providers
    void (() => sk.search({ q: "x", engine: ["google", "bingo"] }));
    expect(m.seen[1].body).toEqual({ q: "espresso", engine: "auto" });
  });

  test("engine: consensus returns sources per result", async () => {
    const body: SearchResponse = {
      ...searchBody,
      request: { endpoint: "search", engine: "consensus", q: "best espresso" },
      results: [
        {
          position: 1,
          title: "Espresso",
          link: "https://example.com/",
          domain: "example.com",
          sources: ["google", "brave", "wikipedia"],
        },
      ],
      meta: {
        request_id: "req_2",
        credits_used: 2.25,
        cached: false,
        engine: "consensus",
        route: [
          { provider: "google", outcome: "ok", ms: 900 },
          { provider: "wikipedia", outcome: "ok", ms: 300 },
          { provider: "brave", outcome: "canceled", ms: 120 },
        ],
      },
    };
    const m = mockFetch(json(body));
    const res = await client(m.fetch).search({ q: "best espresso", engine: "consensus" });
    expect(m.seen[0].body).toEqual({ q: "best espresso", engine: "consensus" });
    expect(res.meta.engine).toBe("consensus");
    expect(res.results[0].sources).toEqual(["google", "brave", "wikipedia"]);
    expect(res.meta.route?.map((s) => s.outcome)).toEqual(["ok", "ok", "canceled"]);
  });

  test("format: markdown resolves to a string", async () => {
    const m = mockFetch(
      new Response("# best espresso\n\n1. [Espresso](https://example.com/)\n", {
        headers: { "content-type": "text/markdown; charset=utf-8" },
      }),
    );
    const md: string = await client(m.fetch).search({ q: "best espresso", format: "markdown" });
    expect(md).toStartWith("# best espresso");
    expect((m.seen[0].body as { format: string }).format).toBe("markdown");
  });

  test("maps the error envelope to SerpKiteError", async () => {
    const m = mockFetch(json(errorBody("insufficient_credits", "balance is 0", "req_42"), 402));
    const err = await client(m.fetch)
      .search({ q: "x" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SerpKiteError);
    expect(err.status).toBe(402);
    expect(err.code).toBe("insufficient_credits");
    expect(err.message).toBe("balance is 0");
    expect(err.requestId).toBe("req_42");
    expect(m.seen).toHaveLength(1);
  });

  test("non-JSON error bodies still map to a code", async () => {
    // What a proxy such as Cloudflare sends instead of the origin's 502 body.
    const m = mockFetch(
      new Response("error code: 502", { status: 502, headers: { "x-request-id": "r9" } }),
    );
    const err = await client(m.fetch, { maxRetries: 0 })
      .news({ q: "x" })
      .catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.code).toBe("upstream_error");
    expect(err.message).toBe("error code: 502");
    expect(err.requestId).toBe("r9");
  });

  test("503 upstream errors keep their code", async () => {
    const m = mockFetch(json(errorBody("upstream_blocked", "retry shortly"), 503));
    const err = await client(m.fetch, { maxRetries: 0 })
      .search({ q: "x" })
      .catch((e) => e);
    expect(err.status).toBe(503);
    expect(err.code).toBe("upstream_blocked");
  });

  test("does not retry 4xx", async () => {
    const m = mockFetch(
      json(errorBody("invalid_request", 'unknown parameter "gl": use country'), 400),
    );
    const err = await client(m.fetch)
      .search({ q: "x" })
      .catch((e) => e);
    expect(err.code).toBe("invalid_request");
    expect(m.seen).toHaveLength(1);
  });

  test("retries 5xx and network errors, then succeeds", async () => {
    const m = mockFetch(
      json(errorBody("upstream_error", "boom"), 503),
      new TypeError("fetch failed"),
      json(searchBody),
    );
    const res = await client(m.fetch).search({ q: "x" });
    expect(res.results).toHaveLength(1);
    expect(m.seen).toHaveLength(3);
  });

  test("retries 503 upstream codes (and legacy 502/504)", async () => {
    const m = mockFetch(
      new Response(JSON.stringify(errorBody("upstream_blocked", "retry shortly")), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "0" },
      }),
      json(errorBody("upstream_timeout", "slow"), 503),
      new Response("error code: 502", { status: 502 }),
      new Response("error code: 504", { status: 504 }),
      json(searchBody),
    );
    const res = await client(m.fetch, { maxRetries: 4 }).search({ q: "x" });
    expect(res.results).toHaveLength(1);
    expect(m.seen).toHaveLength(5);
  });

  test("gives up after maxRetries", async () => {
    const m = mockFetch(json(errorBody("unavailable", "down"), 503));
    const err = await client(m.fetch, { maxRetries: 3 })
      .search({ q: "x" })
      .catch((e) => e);
    expect(err.code).toBe("unavailable");
    expect(m.seen).toHaveLength(4);
  });

  test("network failures surface as connection_error", async () => {
    const m = mockFetch(new TypeError("fetch failed"));
    const err = await client(m.fetch, { maxRetries: 1 })
      .search({ q: "x" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SerpKiteError);
    expect(err.status).toBe(0);
    expect(err.code).toBe("connection_error");
    expect(m.seen).toHaveLength(2);
  });

  test("honours Retry-After on 429", async () => {
    const m = mockFetch(
      json(errorBody("rate_limited", "slow down"), 429, { "retry-after": "0.05" }),
      json(searchBody),
    );
    const t0 = performance.now();
    await client(m.fetch, { retryDelayMs: 0 }).search({ q: "x" });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(45);
    expect(m.seen).toHaveLength(2);
  });

  test("per-attempt timeout", async () => {
    // A fetch that rejects when its signal aborts.
    const f = ((_: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;
    const err = await client(f, { timeoutMs: 20, maxRetries: 0 })
      .search({ q: "x" })
      .catch((e) => e);
    expect(err.code).toBe("timeout");
  });

  test("batches.create only retries 429", async () => {
    const m = mockFetch(json(errorBody("upstream_error", "boom"), 500), json({ batches: [] }, 202));
    const err = await client(m.fetch)
      .batches.create({ endpoint: "search", requests: [{ q: "a" }] })
      .catch((e) => e);
    expect(err.status).toBe(500);
    expect(m.seen).toHaveLength(1);
  });

  test("batches.create sends Idempotency-Key and then retries 5xx", async () => {
    const m = mockFetch(json(errorBody("upstream_error", "boom"), 500), json({ batches: [] }, 202));
    const out = await client(m.fetch).batches.create(
      { endpoint: "search", requests: [{ q: "a" }] },
      { idempotencyKey: "job-42" },
    );
    expect(out.batches).toEqual([]);
    expect(m.seen).toHaveLength(2);
    for (const r of m.seen) expect(r.headers.get("idempotency-key")).toBe("job-42");
  });

  test("batches.create returns jobs and per-entry errors", async () => {
    const batch = {
      id: "b1",
      status: "queued",
      endpoint: "/v1/search",
      created_at: "2026-09-29T00:00:00Z",
      poll_url: "https://api.test/v1/batches/b1",
    };
    const m = mockFetch(
      json({ batches: [batch, errorBody("invalid_request", "q is required", "req:1")] }, 202),
    );
    const { batches } = await client(m.fetch).batches.create({
      endpoint: "search",
      requests: [{ q: "a" }, { q: "" }],
      webhook_url: "https://hooks.example.com/serpkite",
    });
    expect(m.seen[0].url).toBe("https://api.test/v1/batches");
    expect(batches[0].id).toBe("b1");
    expect(isBatchError(batches[0])).toBe(false);
    expect(isBatchError(batches[1])).toBe(true);
    const err = await client(m.fetch)
      .batches.wait(batches[1])
      .catch((e) => e);
    expect(err.code).toBe("invalid_request");
    expect(err.requestId).toBe("req:1");
  });

  test("batches.wait polls until done", async () => {
    const base = {
      id: "b1",
      endpoint: "/v1/search",
      created_at: "2026-09-29T00:00:00Z",
      poll_url: "",
    };
    const m = mockFetch(
      json({ ...base, status: "queued" }),
      json({ ...base, status: "running" }),
      json({ ...base, status: "done", credits_used: 0.5, result: { results: [] } }),
    );
    const done = await client(m.fetch).batches.wait("b1", { pollIntervalMs: 1 });
    expect(done.status).toBe("done");
    expect(done.credits_used).toBe(0.5);
    expect(m.seen).toHaveLength(3);
    expect(m.seen.every((s) => s.url === "https://api.test/v1/batches/b1")).toBe(true);
  });

  test("batches.wait returns failed jobs and times out", async () => {
    const base = {
      id: "b2",
      endpoint: "/v1/search",
      created_at: "2026-09-29T00:00:00Z",
      poll_url: "",
    };
    const failed = mockFetch(
      json({ ...base, status: "failed", error: { code: "upstream_error", message: "x" } }),
    );
    expect((await client(failed.fetch).batches.wait("b2")).status).toBe("failed");

    const stuck = mockFetch(json({ ...base, status: "running" }));
    const err = await client(stuck.fetch)
      .batches.wait("b2", { pollIntervalMs: 5, timeoutMs: 30 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SerpKiteError);
    expect(err.code).toBe("timeout");
  });

  test("parseRetryAfter", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("nonsense")).toBeUndefined();
    const d = parseRetryAfter(new Date(Date.now() + 5000).toUTCString());
    expect(d).toBeGreaterThan(3000);
  });
});

describe("verifyWebhook", () => {
  // Same vector as SignWebhook in backend/cmd/serp-api.
  const secret = "whsec_test";
  const body = '{"event":"batch.completed"}';
  const sig = "v1=30e487bd0bd03db9643edcae3622a5d5cd3ee3f108cd4c9130e7670f518aeed1";
  const hdrs = { "X-SerpKite-Signature": sig, "X-SerpKite-Timestamp": "1700000000" };

  test("accepts a valid signature", async () => {
    expect(await verifyWebhook(secret, body, hdrs, { now: 1700000060 })).toBe(true);
    expect(
      await verifyWebhook(secret, new TextEncoder().encode(body), new Headers(hdrs), {
        now: 1700000000,
      }),
    ).toBe(true);
  });

  test("rejects tampering, wrong secrets and stale timestamps", async () => {
    expect(await verifyWebhook(secret, `${body} `, hdrs, { now: 1700000000 })).toBe(false);
    expect(await verifyWebhook("whsec_other", body, hdrs, { now: 1700000000 })).toBe(false);
    expect(await verifyWebhook(secret, body, hdrs, { now: 1700000301 })).toBe(false);
    expect(
      await verifyWebhook(
        secret,
        body,
        { "X-SerpKite-Timestamp": "1700000000" },
        { now: 1700000000 },
      ),
    ).toBe(false);
  });
});
