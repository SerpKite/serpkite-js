import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  type AnswerResponse,
  type AnswerStreamEvent,
  type ExtractResponse,
  parseWebhook,
  type ResearchTask,
  type SearchResponse,
  SerpKite,
  SerpKiteError,
  type TaskCreated,
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

/** An SSE body delivered in awkward chunks (split mid-event and mid-line). */
function sse(text: string, chunkSize = 7, headers: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.slice(i, i + chunkSize));
      c.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

const client = (f: typeof fetch) =>
  new SerpKite({ apiKey: "skt_live_test", baseUrl: "https://api.test", fetch: f, retryDelayMs: 1 });

const path = (s: Seen) => `${s.method} ${new URL(s.url).pathname}`;

const citation = {
  index: 1,
  title: "SERP",
  link: "https://en.wikipedia.org/wiki/SERP",
  domain: "en.wikipedia.org",
};

const collect = async (it: AsyncIterable<AnswerStreamEvent>) => {
  const events: AnswerStreamEvent[] = [];
  for await (const ev of it) events.push(ev);
  return events;
};

describe("include_answer and extract AI fields", () => {
  test("search sends include_answer and types answer, llm and warnings", async () => {
    const body: SearchResponse = {
      request: { endpoint: "search", engine: "google", q: "rag", include_answer: true },
      results: [{ position: 1, title: "SERP", link: citation.link, domain: citation.domain }],
      related_searches: [],
      answer: { text: "A results page [1].", citations: [citation] },
      meta: {
        request_id: "r",
        credits_used: 3,
        cached: false,
        llm: { provider: "anthropic", model: "claude-haiku-5-5", input_tokens: 900 },
      },
    };
    const m = mockFetch(json(body));
    const res = await client(m.fetch).search({ q: "rag", include_answer: true });
    expect(m.seen[0].body).toEqual({ q: "rag", include_answer: true });
    expect(res.answer?.citations[0].index).toBe(1);
    expect(res.meta.llm?.provider).toBe("anthropic");

    const failed = mockFetch(
      json({ ...body, answer: undefined, meta: { ...body.meta, warnings: ["answer failed"] } }),
    );
    const res2 = await client(failed.fetch).news({ q: "rag", include_answer: true });
    expect(res2.answer).toBeUndefined();
    expect(res2.meta.warnings).toEqual(["answer failed"]);
  });

  test("extract sends summary, output_schema and prompt and types the results", async () => {
    const body: ExtractResponse = {
      request: { endpoint: "extract", urls: ["https://a", "https://b"] },
      results: [
        { url: "https://a", cached: false, summary: "About A.", output: { price: 10 } },
        {
          url: "https://b",
          cached: false,
          summary: null,
          summary_error: "model failed",
          output: null,
          output_error: "model failed",
        },
      ],
      failed: [],
      meta: {
        request_id: "r",
        credits_used: 7,
        succeeded: 2,
        failed: 0,
        llm: { provider: "openai", model: "gpt-6-luna" },
      },
    };
    const m = mockFetch(json(body));
    const schema = { type: "object", properties: { price: { type: "number" } } };
    const res = await client(m.fetch).extract({
      urls: ["https://a", "https://b"],
      summary: true,
      output_schema: schema,
      prompt: "price in USD",
    });
    expect(m.seen[0].body).toEqual({
      urls: ["https://a", "https://b"],
      summary: true,
      output_schema: schema,
      prompt: "price in USD",
    });
    expect(res.results[0].summary).toBe("About A.");
    expect(res.results[0].output).toEqual({ price: 10 });
    expect(res.results[1].output_error).toBe("model failed");
    expect(res.meta.llm?.model).toBe("gpt-6-luna");
  });

  test("extract with AI waits past the 75 s server default", async () => {
    let aborted = false;
    const f = (async (_: string, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, 30));
      aborted = init?.signal?.aborted ?? false;
      return json({ request: {}, results: [], failed: [], meta: {} });
    }) as unknown as typeof fetch;
    const sk = new SerpKite({ apiKey: "k", baseUrl: "https://api.test", fetch: f, timeoutMs: 10 });
    await sk.extract({ urls: ["https://a"], summary: true });
    expect(aborted).toBe(false);
  });
});

describe("answer", () => {
  test("posts to /v1/answer", async () => {
    const body: AnswerResponse = {
      request: { endpoint: "answer", engine: "google", q: "what is rag" },
      answer: "A results page [1].",
      citations: [citation],
      results: [citation],
      meta: {
        request_id: "r",
        credits_used: 8,
        cached: false,
        credits: { search: 4, answer: 4 },
        llm: { provider: "anthropic", model: "claude-haiku-5-5" },
      },
    };
    const m = mockFetch(json(body));
    const res = await client(m.fetch).answer({
      q: "what is rag",
      depth: "standard",
      num_sources: 3,
    });
    expect(path(m.seen[0])).toBe("POST /v1/answer");
    expect(m.seen[0].body).toEqual({ q: "what is rag", depth: "standard", num_sources: 3 });
    expect(res.answer).toBe("A results page [1].");
    expect(res.meta.credits?.answer).toBe(4);
    expect(res.meta.llm?.provider).toBe("anthropic");
  });

  test("answer maps ai_unavailable", async () => {
    const m = mockFetch(
      json({ error: { code: "ai_unavailable", message: "AI is off", request_id: "q" } }, 503, {
        "retry-after": "0",
      }),
    );
    const err = await client(m.fetch)
      .answer({ q: "x" }, { maxRetries: 0 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SerpKiteError);
    expect(err.status).toBe(503);
    expect(err.code).toBe("ai_unavailable");
  });

  test("answer is only retried on 429 and waits past the client timeout", async () => {
    // A 503 after the search still charged it: a retry would bill the search again.
    const m = mockFetch(
      json({ error: { code: "ai_unavailable", message: "x" } }, 503, { "retry-after": "0" }),
    );
    const err = await client(m.fetch)
      .answer({ q: "x" })
      .catch((e) => e);
    expect(err.code).toBe("ai_unavailable");
    expect(m.seen.length).toBe(1);

    let aborted = false;
    const slow = (async (_: string, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, 30));
      aborted = init?.signal?.aborted ?? false;
      return json({ request: {}, answer: "a", citations: [], results: [], meta: {} });
    }) as unknown as typeof fetch;
    const sk = new SerpKite({
      apiKey: "k",
      baseUrl: "https://api.test",
      fetch: slow,
      timeoutMs: 10,
    });
    await sk.answer({ q: "x" });
    expect(aborted).toBe(false);
  });

  test("answerStream yields results, deltas and done across chunk boundaries", async () => {
    const stream =
      'event: results\ndata: {"request":{"endpoint":"answer","engine":"google"},"results":[{"index":1,"title":"SERP","link":"https://x"}]}\n\n' +
      ": keep-alive comment\n\n" +
      'event: delta\ndata: {"text":"A results "}\n\n' +
      'event: delta\r\ndata: {"text":"page [1]."}\r\n\r\n' +
      'event: done\ndata: {"answer":"A results page [1].","citations":[{"index":1,"title":"SERP","link":"https://x"}],"meta":{"request_id":"r","credits_used":5,"cached":false}}\n\n';
    const m = mockFetch(sse(stream, 5, { "x-credits-used": "1", "x-request-id": "r" }));
    let credits: number | undefined;
    const events = await collect(
      client(m.fetch).answerStream(
        { q: "what is rag", depth: "fast" },
        { onResponse: (i) => (credits = i.creditsUsed) },
      ),
    );
    expect(m.seen[0].body).toEqual({ q: "what is rag", depth: "fast", stream: true });
    expect(m.seen[0].headers.get("accept")).toContain("text/event-stream");
    expect(m.seen[0].headers.get("user-agent")).toMatch(/^serpkite-typescript\//);
    expect(events.map((e) => e.event)).toEqual(["results", "delta", "delta", "done"]);
    const text = events.flatMap((e) => (e.event === "delta" ? [e.data.text] : [])).join("");
    expect(text).toBe("A results page [1].");
    const done = events[3];
    expect(done.event === "done" && done.data.meta.credits_used).toBe(5);
    expect(credits).toBe(1);
  });

  test("answerStream throws the error event and maps HTTP errors", async () => {
    const m = mockFetch(
      sse(
        'event: results\ndata: {"request":{},"results":[]}\n\nevent: error\ndata: {"error":{"code":"ai_unavailable","message":"answer generation failed","request_id":"req_9"}}\n\n',
      ),
    );
    const seen: string[] = [];
    const err = await (async () => {
      for await (const ev of client(m.fetch).answerStream({ q: "x" })) seen.push(ev.event);
    })().catch((e) => e);
    expect(seen).toEqual(["results"]);
    expect(err).toBeInstanceOf(SerpKiteError);
    expect(err.code).toBe("ai_unavailable");
    expect(err.requestId).toBe("req_9");

    const bad = mockFetch(
      json({ error: { code: "invalid_request", message: "stream can't take output_schema" } }, 400),
    );
    const e2 = await collect(client(bad.fetch).answerStream({ q: "x" })).catch((e) => e);
    expect(e2.status).toBe(400);
    expect(e2.code).toBe("invalid_request");
    expect(bad.seen).toHaveLength(1);
  });

  test("answerStream handles CRLF split across chunks (every byte its own chunk)", async () => {
    const stream =
      'event: results\r\ndata: {"request":{},"results":[]}\r\n\r\n' +
      'event: delta\r\ndata: {"text":"hi"}\r\n\r\n' +
      'event: done\r\ndata: {"answer":"hi","citations":[],"meta":{"request_id":"r","credits_used":5,"cached":false}}\r\n\r\n';
    const events = await collect(client(mockFetch(sse(stream, 1)).fetch).answerStream({ q: "x" }));
    expect(events.map((e) => e.event)).toEqual(["results", "delta", "done"]);
  });

  test("answerStream turns a plain JSON answer into results + done", async () => {
    const body: AnswerResponse = {
      request: { endpoint: "answer", engine: "google", q: "zzz" },
      answer: null,
      citations: [],
      results: [],
      meta: { request_id: "r", credits_used: 1, cached: false, warnings: ["no results"] },
    };
    const events = await collect(client(mockFetch(json(body)).fetch).answerStream({ q: "zzz" }));
    expect(events.map((e) => e.event)).toEqual(["results", "done"]);
    const done = events[1];
    expect(done.event === "done" && done.data.answer).toBe("");
    expect(done.event === "done" && done.data.meta.warnings).toEqual(["no results"]);
  });

  test("answerStream throws when the stream ends before done", async () => {
    const m = mockFetch(
      sse(
        'event: results\ndata: {"request":{},"results":[]}\n\nevent: delta\ndata: {"text":"A"}\n\n',
      ),
    );
    const seen: string[] = [];
    const err = await (async () => {
      for await (const ev of client(m.fetch).answerStream({ q: "x" })) seen.push(ev.event);
    })().catch((e) => e);
    expect(seen).toEqual(["results", "delta"]);
    expect(err).toBeInstanceOf(SerpKiteError);
    expect(err.code).toBe("invalid_response");
  });

  test("answerStream cancels the body when the consumer stops early", async () => {
    let canceled = false;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('event: delta\ndata: {"text":"A"}\n\n'));
      },
      cancel() {
        canceled = true;
      },
    });
    const m = mockFetch(
      () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
    for await (const ev of client(m.fetch).answerStream({ q: "x" })) {
      expect(ev.event).toBe("delta");
      break;
    }
    expect(canceled).toBe(true);
  });

  test("answerStream retries a 503 before the stream starts", async () => {
    const m = mockFetch(
      json({ error: { code: "ai_unavailable", message: "x" } }, 503),
      sse(
        'event: done\ndata: {"answer":"ok","citations":[],"meta":{"request_id":"r","credits_used":5,"cached":false}}\n\n',
      ),
    );
    const events = await collect(client(m.fetch).answerStream({ q: "x" }));
    expect(events.map((e) => e.event)).toEqual(["done"]);
    expect(m.seen).toHaveLength(2);
  });
});

describe("research", () => {
  const created: TaskCreated = {
    id: "r1",
    kind: "research",
    status: "queued",
    created_at: "2026-10-24T00:00:00Z",
    poll_url: "https://api.test/v1/research/r1",
    credits_reserved: 75,
    webhook_url: null,
  };
  const running: ResearchTask = {
    id: "r1",
    kind: "research",
    status: "running",
    created_at: "2026-10-24T00:00:00Z",
    credits_reserved: 75,
    credits_used: 0,
    progress: { round: 1, rounds: 3, queries: 4, sources: 9, step: "searching" },
  };
  const done: ResearchTask = {
    ...running,
    status: "completed",
    credits_used: 75,
    progress: null,
    result: {
      input: "compare vector databases",
      effort: "standard",
      report: "# Report\n\nPgvector is popular [1].",
      citations: [citation],
      sources: [{ ...citation, query: "vector databases" }],
      queries: ["vector databases"],
      stats: { searches: 4, sources: 9, rounds: 3 },
    },
  };

  test("research is only retried on 429; get, wait and cancel hit the task path", async () => {
    const m = mockFetch(
      json({ error: { code: "unavailable", message: "x" } }, 503),
      json(created, 202),
      json(running),
      json(running),
      json(done),
      json({ id: "r1", status: "canceling" }),
    );
    const sk = client(m.fetch);
    const err = await sk.research({ input: "compare vector databases" }).catch((e) => e);
    expect(err.status).toBe(503);
    expect(m.seen).toHaveLength(1);
    const task = await sk.research({
      input: "compare vector databases",
      effort: "standard",
      include_domains: ["github.com"],
    });
    expect(m.seen[1].body).toEqual({
      input: "compare vector databases",
      effort: "standard",
      include_domains: ["github.com"],
    });
    expect(task.kind).toBe("research");
    const got = await sk.getResearch("r1");
    expect(got.progress?.step).toBe("searching");
    const final = await sk.waitResearch(task, { pollIntervalMs: 1 });
    expect(final.status).toBe("completed");
    expect(final.result?.report).toContain("[1]");
    expect(final.result?.sources[0].query).toBe("vector databases");
    expect((await sk.cancelResearch("r1")).status).toBe("canceling");
    expect(m.seen.map(path)).toEqual([
      "POST /v1/research",
      "POST /v1/research",
      "GET /v1/research/r1",
      "GET /v1/research/r1",
      "GET /v1/research/r1",
      "DELETE /v1/research/r1",
    ]);
  });

  test("waitResearch returns failed tasks and times out", async () => {
    const failed: ResearchTask = {
      ...running,
      status: "failed",
      error: { code: "ai_unavailable", message: "model failed" },
    };
    const f = mockFetch(json(failed));
    expect((await client(f.fetch).waitResearch("r1")).error?.code).toBe("ai_unavailable");
    const slow = mockFetch(json(running));
    const err = await client(slow.fetch)
      .waitResearch("r1", { pollIntervalMs: 5, timeoutMs: 30 })
      .catch((e) => e);
    expect(err.code).toBe("timeout");
  });

  test("parseWebhook types research.completed", async () => {
    const secret = "whsec_test";
    const raw = JSON.stringify({
      event: "research.completed",
      id: "r1",
      kind: "research",
      status: "completed",
      created_at: "2026-10-24T00:00:00Z",
      credits_used: 75,
      poll_url: "https://api.test/v1/research/r1",
      result: done.result,
    });
    const ts = "1700000000";
    const ev = await parseWebhook(
      secret,
      raw,
      {
        "X-SerpKite-Event": "research.completed",
        "X-SerpKite-Delivery": "d1",
        "X-SerpKite-Timestamp": ts,
        "X-SerpKite-Signature": `v1=${createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex")}`,
      },
      { now: 1700000000 },
    );
    expect(ev.type).toBe("research.completed");
    if (ev.type === "research.completed") expect(ev.data.kind).toBe("research");
  });
});
