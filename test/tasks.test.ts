import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  type CrawlTask,
  type Monitor,
  type MonitorPageChange,
  type MonitorRun,
  type MonitorRunList,
  parseWebhook,
  SerpKite,
  type TaskCreated,
  verifyWebhook,
} from "../src/index";

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function mockFetch(...replies: (Response | ((req: Seen) => Response))[]) {
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
    return typeof r === "function" ? r(req) : r.clone();
  };
  return { fetch: fn as unknown as typeof fetch, seen };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const client = (f: typeof fetch) =>
  new SerpKite({ apiKey: "skt_live_test", baseUrl: "https://api.test", fetch: f, retryDelayMs: 1 });

const path = (s: Seen) => `${s.method} ${new URL(s.url).pathname}`;

describe("tasks", () => {
  const created = (kind: "crawl"): TaskCreated => ({
    id: "t1",
    kind,
    status: "queued",
    created_at: "2026-10-03T00:00:00Z",
    poll_url: `https://api.test/v1/${kind}/t1`,
    credits_reserved: 25,
    webhook_url: null,
  });

  test("crawl is only retried on 429; get, cancel and wait hit the task path", async () => {
    const running: CrawlTask = {
      id: "t1",
      kind: "crawl",
      status: "running",
      created_at: "2026-10-03T00:00:00Z",
      credits_reserved: 25,
      credits_used: 0,
      progress: { pages_done: 1 },
    };
    const done: CrawlTask = {
      ...running,
      status: "completed",
      credits_used: 2,
      result: {
        url: "https://a",
        pages: [{ url: "https://a", depth: 0, markdown: "# A" }],
        failed: [],
        stats: { pages: 1 },
      },
    };
    const m = mockFetch(
      json({ error: { code: "unavailable", message: "x" } }, 503),
      json(created("crawl"), 202),
      json(running),
      json(running),
      json(done),
      json({ id: "t1", status: "canceling" }),
    );
    const sk = client(m.fetch);
    const err = await sk.crawl({ url: "https://a", limit: 25 }).catch((e) => e);
    expect(err.status).toBe(503);
    expect(m.seen).toHaveLength(1);
    const task = await sk.crawl({ url: "https://a", limit: 25 });
    expect(task.poll_url).toContain("/v1/crawl/t1");
    expect((await sk.getCrawl("t1")).status).toBe("running");
    const final = await sk.waitForCrawl(task, { pollIntervalMs: 1 });
    expect(final.status).toBe("completed");
    expect(final.result?.pages[0].markdown).toBe("# A");
    expect((await sk.cancelCrawl("t1")).status).toBe("canceling");
    expect(m.seen.map(path)).toEqual([
      "POST /v1/crawl",
      "POST /v1/crawl",
      "GET /v1/crawl/t1",
      "GET /v1/crawl/t1",
      "GET /v1/crawl/t1",
      "DELETE /v1/crawl/t1",
    ]);
  });

  test("waitForCrawl returns failed tasks and times out", async () => {
    const base: CrawlTask = {
      id: "t1",
      kind: "crawl",
      status: "queued",
      created_at: "2026-10-03T00:00:00Z",
      credits_reserved: 25,
      credits_used: 0,
    };
    const m = mockFetch(
      json({ ...base, status: "failed", error: { code: "no_pages", message: "nothing read" } }),
    );
    const failed = await client(m.fetch).waitForCrawl("t1", { pollIntervalMs: 1 });
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("no_pages");

    const stuck = mockFetch(json({ ...base, status: "running" }));
    const err = await client(stuck.fetch)
      .waitForCrawl("t1", { pollIntervalMs: 5, timeoutMs: 30 })
      .catch((e) => e);
    expect(err.code).toBe("timeout");

    const bad = await client(m.fetch)
      .waitForCrawl("")
      .catch((e) => e);
    expect(bad.code).toBe("invalid_request");
  });
});

describe("monitors", () => {
  const mon: Monitor = {
    id: "m1",
    name: "agents news",
    endpoint: "news",
    request: { q: "ai agents" },
    interval_seconds: 3600,
    webhook_url: "https://example.com/hook",
    active: true,
    next_run_at: "2026-10-03T00:00:00Z",
    runs: 0,
    consecutive_failures: 0,
    credits_used: 0,
    created_at: "2026-10-03T00:00:00Z",
  };

  test("CRUD and run", async () => {
    const m = mockFetch(
      json(mon, 201),
      json({ results: [mon] }),
      json(mon),
      json({ ...mon, active: false, interval_seconds: 86400 }),
      json(mon, 202),
      new Response(null, { status: 204 }),
    );
    const sk = client(m.fetch);
    await sk.monitors.create({
      q: "ai agents",
      endpoint: "news",
      interval: "hourly",
      webhook_url: "https://example.com/hook",
    });
    expect((await sk.monitors.list()).results).toHaveLength(1);
    await sk.monitors.get("m1");
    const upd = await sk.monitors.update("m1", { active: false, interval: "daily" });
    expect(upd.interval_seconds).toBe(86400);
    await sk.monitors.run("m1");
    expect(await sk.monitors.delete("m1")).toBeUndefined();
    expect(m.seen.map(path)).toEqual([
      "POST /v1/monitors",
      "GET /v1/monitors",
      "GET /v1/monitors/m1",
      "PATCH /v1/monitors/m1",
      "POST /v1/monitors/m1/run",
      "DELETE /v1/monitors/m1",
    ]);
    expect(m.seen[3].body).toEqual({ active: false, interval: "daily" });
  });

  test("poll monitors: no webhook, created paused, PATCH changes the search", async () => {
    const poll: Monitor = { ...mon, webhook_url: null, active: false };
    const m = mockFetch(json(poll, 201), json({ ...poll, request: { q: "agent frameworks" } }));
    const sk = client(m.fetch);
    const created = await sk.monitors.create({ q: "ai agents", active: false });
    expect(created.webhook_url).toBeNull();
    await sk.monitors.update("m1", {
      q: "agent frameworks",
      num: 20,
      engine: "auto",
      webhook_url: "",
    });
    expect(m.seen[0].body).toEqual({ q: "ai agents", active: false });
    expect(m.seen[1].body).toEqual({
      q: "agent frameworks",
      num: 20,
      engine: "auto",
      webhook_url: "",
    });
  });

  test("webpage monitors and metadata", async () => {
    const page: Monitor = {
      ...mon,
      endpoint: "webpage",
      request: { url: "https://example.com/pricing" },
      metadata: { customer: "acme" },
    };
    const change: MonitorPageChange = {
      url: "https://example.com/pricing",
      title: "Pricing",
      change: "changed",
      content_hash: "abc",
      markdown: "# Pricing",
    };
    const m = mockFetch(
      json(page, 201),
      json({ ...page, metadata: null }),
      json({ ...page, endpoint: "search", request: { q: "pricing" } }),
      json({ results: [{ ...run("r1"), results: [change] }], next_before: null }),
    );
    const sk = client(m.fetch);
    const created = await sk.monitors.create({
      endpoint: "webpage",
      url: "https://example.com/pricing",
      country: "de",
      metadata: { customer: "acme" },
    });
    expect(created.request.url).toBe("https://example.com/pricing");
    expect(created.metadata).toEqual({ customer: "acme" });
    expect((await sk.monitors.update("m1", { metadata: null })).metadata).toBeNull();
    await sk.monitors.update("m1", { endpoint: "search", q: "pricing" });
    const runs = await sk.monitors.runs("m1");
    const got = runs.results[0].results?.[0] as MonitorPageChange;
    expect(got.change).toBe("changed");
    expect(m.seen[0].body).toEqual({
      endpoint: "webpage",
      url: "https://example.com/pricing",
      country: "de",
      metadata: { customer: "acme" },
    });
    expect(m.seen[1].body).toEqual({ metadata: null });
    expect(m.seen[2].body).toEqual({ endpoint: "search", q: "pricing" });
  });

  const run = (id: string): MonitorRun => ({
    id,
    status: "ok",
    error: null,
    new_results: 1,
    results: [{ link: `https://a/${id}` }],
    credits_used: 1,
    webhook_status: "none",
    created_at: "2026-10-03T00:00:00Z",
  });

  test("runs builds the query string", async () => {
    const page: MonitorRunList = { results: [run("r1")], next_before: "r1" };
    const m = mockFetch(json(page));
    const sk = client(m.fetch);
    const got = await sk.monitors.runs("m 1", { limit: 5, before: "r9" });
    expect(got.next_before).toBe("r1");
    expect(got.results[0].webhook_status).toBe("none");
    await sk.monitors.runs("m1");
    await sk.monitors.runs("m1", { limit: 10, before: undefined });
    const urls = m.seen.map((s) => new URL(s.url));
    expect(m.seen.every((s) => s.method === "GET" && s.body === undefined)).toBe(true);
    expect(urls[0].pathname).toBe("/v1/monitors/m%201/runs");
    expect(urls[0].search).toBe("?limit=5&before=r9");
    expect(urls[1].search).toBe("");
    expect(urls[2].search).toBe("?limit=10");
  });

  test("iterRuns follows next_before until the last page", async () => {
    const m = mockFetch(
      json({ results: [run("r3"), run("r2")], next_before: "r2" }),
      json({ results: [run("r1")], next_before: null }),
    );
    const ids: string[] = [];
    for await (const r of client(m.fetch).monitors.iterRuns("m1", { limit: 2 })) ids.push(r.id);
    expect(ids).toEqual(["r3", "r2", "r1"]);
    expect(m.seen.map((s) => new URL(s.url).search)).toEqual(["?limit=2", "?limit=2&before=r2"]);
  });

  test("iterRuns stops early when the caller breaks", async () => {
    const m = mockFetch(json({ results: [run("r2"), run("r1")], next_before: "r1" }));
    for await (const r of client(m.fetch).monitors.iterRuns("m1")) {
      expect(r.id).toBe("r2");
      break;
    }
    expect(m.seen).toHaveLength(1);
  });
});

describe("crawl and map options", () => {
  test("new fields are sent as given and stats are typed", async () => {
    const m = mockFetch(
      json(
        {
          id: "t1",
          kind: "crawl",
          status: "queued",
          created_at: "x",
          poll_url: "https://api.test/v1/crawl/t1",
          credits_reserved: 1000,
          webhook_url: null,
        },
        202,
      ),
      json({
        request: { endpoint: "map" },
        results: [],
        meta: { request_id: "r", credits_used: 1, count: 0 },
      }),
    );
    const sk = client(m.fetch);
    await sk.crawl({
      url: "https://a",
      limit: 1000,
      max_depth: 10,
      sitemap: "only",
      query: "pricing",
      ignore_query_parameters: true,
    });
    await sk.map({
      url: "https://a",
      include_paths: ["^/docs/"],
      exclude_paths: ["/old/"],
      ignore_query_parameters: true,
    });
    expect(m.seen[0].body).toEqual({
      url: "https://a",
      limit: 1000,
      max_depth: 10,
      sitemap: "only",
      query: "pricing",
      ignore_query_parameters: true,
    });
    expect(m.seen[1].body).toMatchObject({ include_paths: ["^/docs/"], exclude_paths: ["/old/"] });

    const task: CrawlTask = {
      id: "t1",
      kind: "crawl",
      status: "completed",
      created_at: "x",
      credits_reserved: 10,
      credits_used: 1,
      progress: { pages_done: 1, pages_discovered: 4 },
      result: {
        url: "https://a",
        pages: [],
        failed: [],
        stats: { pages: 1, discovered: 4, robots: "found", stopped: "limit" },
      },
    };
    expect(task.result?.stats.stopped).toBe("limit");
  });
});

describe("webhooks for the new events", () => {
  const secret = "whsec_test";
  const sign = (ts: string, body: string) =>
    `v1=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;

  test("verifyWebhook and parseWebhook handle crawl and monitor events", async () => {
    const ts = "1700000000";
    const cases = [
      {
        event: "crawl.completed",
        body: {
          event: "crawl.completed",
          id: "t1",
          kind: "crawl",
          status: "completed",
          created_at: "x",
          credits_used: 3,
          poll_url: "https://api.test/v1/crawl/t1",
          result: null,
          result_omitted: true,
        },
      },
      {
        event: "monitor.results",
        body: {
          event: "monitor.results",
          monitor_id: "m1",
          run_id: "d1",
          name: "n",
          url: "https://example.com/pricing",
          metadata: { customer: "acme" },
          endpoint: "news",
          q: "q",
          first_run: true,
          run_at: "x",
          new_results: [{ link: "https://a" }],
          credits_used: 1,
        },
      },
    ];
    for (const c of cases) {
      const raw = JSON.stringify(c.body);
      const headers = {
        "X-SerpKite-Event": c.event,
        "X-SerpKite-Delivery": "d1",
        "X-SerpKite-Timestamp": ts,
        "X-SerpKite-Signature": sign(ts, raw),
      };
      expect(await verifyWebhook(secret, raw, headers, { now: 1700000000 })).toBe(true);
      const ev = await parseWebhook(secret, raw, headers, { now: 1700000000 });
      expect(ev.type as string).toBe(c.event);
      expect(ev.deliveryId).toBe("d1");
      if (ev.type === "monitor.results") {
        expect(ev.data.new_results).toHaveLength(1);
        expect(ev.data.run_id).toBe("d1");
        expect(ev.data.metadata).toEqual({ customer: "acme" });
        expect(ev.data.url).toBe("https://example.com/pricing");
      }
      if (ev.type === "crawl.completed") {
        expect(ev.data.result_omitted).toBe(true);
        expect(ev.data.poll_url).toContain("/v1/crawl/t1");
      }
    }
    const err = await parseWebhook(
      secret,
      "{}",
      { "X-SerpKite-Timestamp": ts, "X-SerpKite-Signature": "v1=00" },
      { now: 1700000000 },
    ).catch((e) => e);
    expect(err.code).toBe("invalid_signature");
  });
});
