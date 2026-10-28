import { describe, expect, test } from "bun:test";
import {
  ASSISTANT_TIMEOUT_MS,
  type AssistantResponse,
  type BatchCreateParams,
  type MonitorAnswer,
  type MonitorCreateParams,
  parseWebhook,
  type SearchResponse,
  SerpKite,
} from "../src/index";

interface Seen {
  url: string;
  method: string;
  body: unknown;
}

function mockFetch(...replies: Response[]) {
  const seen: Seen[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const r = replies.length > 1 ? replies.shift() : replies[0];
    if (r === undefined) throw new Error("no reply configured");
    return r.clone();
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

const answer: AssistantResponse = {
  request: { endpoint: "chatgpt", prompt: "best CRM for startups", web_search: true },
  text: "HubSpot and Pipedrive are popular [1].",
  markdown: "HubSpot and Pipedrive are popular [1](https://www.hubspot.com/).",
  model: "gpt-5-mini",
  sources: [
    {
      position: 1,
      title: "HubSpot CRM",
      link: "https://www.hubspot.com/",
      domain: "hubspot.com",
      cited: true,
    },
  ],
  search_queries: ["best crm for startups 2026"],
  products: [{ position: 1, title: "Pipedrive Essential", price: "$14", extracted_price: 14 }],
  mentions: [
    { term: "hubspot.com", mentioned: true, cited: true, sources: [1], text_position: 0 },
    { term: "Salesforce", mentioned: false, cited: false, sources: [], text_position: -1 },
  ],
  meta: { request_id: "req_1", credits_used: 5, cached: false },
};

describe("AI assistants", () => {
  test("each method posts to its path and types the answer", async () => {
    const m = mockFetch(json(answer));
    const sk = client(m.fetch);
    const res = await sk.chatgpt({
      prompt: "best CRM for startups",
      web_search: true,
      country: "us",
      track: ["hubspot.com", "Salesforce"],
    });
    expect(res.sources[0].cited).toBe(true);
    expect(res.mentions?.[0].sources).toEqual([1]);
    expect(res.mentions?.[1].text_position).toBe(-1);
    expect(res.products[0].extracted_price).toBe(14);
    await sk.gemini({ prompt: "p", language: "de" });
    await sk.copilot({ prompt: "p", country: "us" });
    await sk.aiMode({ prompt: "p" });
    await sk.braveAi({ prompt: "p", include_html: true });
    expect(m.seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      "POST /v1/chatgpt",
      "POST /v1/gemini",
      "POST /v1/copilot",
      "POST /v1/ai_mode",
      "POST /v1/brave_ai",
    ]);
    expect(m.seen[0].body).toEqual({
      prompt: "best CRM for startups",
      web_search: true,
      country: "us",
      track: ["hubspot.com", "Salesforce"],
    });
  });

  test("format: markdown resolves to a string", async () => {
    const m = mockFetch(
      new Response("HubSpot [1](https://www.hubspot.com/)", {
        headers: { "content-type": "text/markdown" },
      }),
    );
    const md: string = await client(m.fetch).gemini({ prompt: "p", format: "markdown" });
    expect(md).toStartWith("HubSpot");
  });

  test("only retried on 429 (a lost answer is still billed)", async () => {
    const m = mockFetch(
      json({ error: { code: "upstream_blocked", message: "x" } }, 503, { "retry-after": "0" }),
    );
    const err = await client(m.fetch)
      .chatgpt({ prompt: "p" })
      .catch((e) => e);
    expect(err.code).toBe("upstream_blocked");
    expect(m.seen.length).toBe(1);

    const r = mockFetch(
      json({ error: { code: "rate_limited", message: "x" } }, 429, { "retry-after": "0" }),
      json(answer),
    );
    await client(r.fetch).braveAi({ prompt: "p" });
    expect(r.seen.length).toBe(2);
  });

  test("waits past the client timeout (answers take up to 90 s)", async () => {
    expect(ASSISTANT_TIMEOUT_MS).toBeGreaterThanOrEqual(100_000);
    let aborted = false;
    const slow = (async (_: string, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, 30));
      aborted = init?.signal?.aborted ?? false;
      return json(answer);
    }) as unknown as typeof fetch;
    const sk = new SerpKite({
      apiKey: "k",
      baseUrl: "https://api.test",
      fetch: slow,
      timeoutMs: 10,
    });
    await sk.copilot({ prompt: "p" });
    expect(aborted).toBe(false);

    // An explicit per-call timeoutMs still wins.
    await sk.copilot({ prompt: "p" }, { timeoutMs: 5 });
    expect(aborted).toBe(true);
  });

  test("search responses carry ai_overview", async () => {
    const body: SearchResponse = {
      request: { endpoint: "search", engine: "google", q: "heat pumps" },
      results: [],
      related_searches: [],
      ai_overview: {
        text: "Heat pumps move heat [1].",
        markdown: "Heat pumps move heat [1](https://a.example/).",
        sources: [{ position: 1, link: "https://a.example/", domain: "a.example", cited: true }],
      },
      meta: { request_id: "r", credits_used: 1, cached: false },
    };
    const res = await client(mockFetch(json(body)).fetch).search({ q: "heat pumps" });
    expect(res.ai_overview?.sources[0].domain).toBe("a.example");
  });

  test("batches and monitors accept the assistant endpoints", async () => {
    const m = mockFetch(json({ batches: [] }), json({ id: "m1" }));
    const sk = client(m.fetch);
    const batch: BatchCreateParams = {
      endpoint: "chatgpt",
      requests: [
        { prompt: "a", track: ["acme.com"] },
        { prompt: "b", web_search: false },
      ],
    };
    await sk.batches.create(batch);
    const monitor: MonitorCreateParams = {
      endpoint: "ai_mode",
      prompt: "best CRM",
      track: ["hubspot.com"],
      interval: "daily",
    };
    await sk.monitors.create(monitor);
    expect(m.seen[0].body).toEqual(batch);
    expect(m.seen[1].body).toEqual(monitor);
  });

  test("parseWebhook types an AI monitor's answer", async () => {
    const row: MonitorAnswer = {
      text: "t",
      markdown: "m",
      sources: [],
      new_sources: ["https://a.example/"],
      search_queries: [],
      mentions: [{ term: "Acme", mentioned: true, cited: false, sources: [], text_position: 0.2 }],
    };
    const body = JSON.stringify({
      event: "monitor.results",
      monitor_id: "m1",
      run_id: "r1",
      name: "crm",
      endpoint: "chatgpt",
      prompt: "best CRM",
      first_run: false,
      run_at: "2026-10-28T00:00:00Z",
      new_results: [row],
      credits_used: 5,
    });
    const { createHmac } = await import("node:crypto");
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", "whsec").update(`${ts}.${body}`).digest("hex");
    const ev = await parseWebhook("whsec", body, {
      "X-SerpKite-Signature": `v1=${sig}`,
      "X-SerpKite-Timestamp": ts,
      "X-SerpKite-Event": "monitor.results",
      "X-SerpKite-Delivery": "r1",
    });
    if (ev.type !== "monitor.results") throw new Error(ev.type);
    expect(ev.data.endpoint).toBe("chatgpt");
    expect(ev.data.prompt).toBe("best CRM");
    expect((ev.data.new_results[0] as MonitorAnswer).new_sources).toEqual(["https://a.example/"]);
  });
});
