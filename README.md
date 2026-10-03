# serpkite

Official TypeScript/JavaScript SDK for [SerpKite](https://serpkite.com), the Google search API built
for AI agents: clean JSON or Markdown, credits that never expire.

- Zero runtime dependencies: uses the global `fetch`.
- Works in Node 18+, Bun, Deno, Cloudflare Workers and other edge runtimes.
- ESM and CommonJS builds with full type definitions, generated from the OpenAPI contract.
- Retries with exponential backoff and jitter on `429`, `5xx` and network errors (honours `Retry-After`).

## Install

```bash
npm install serpkite
# or: bun add serpkite / pnpm add serpkite / yarn add serpkite
```

Deno: `import { SerpKite } from "npm:serpkite";`

## Quickstart

```ts
import { SerpKite } from "serpkite";

const sk = new SerpKite(); // reads SERPKITE_API_KEY
const res = await sk.search({ q: "best espresso machine", country: "us" });
console.log(res.results[0].title, res.meta.credits_used);

// Markdown for an LLM prompt: `format: "markdown"` resolves to a string.
const md = await sk.search({ q: "best espresso machine", format: "markdown" });
```

Get an API key at [app.serpkite.com](https://app.serpkite.com) and export it:

```bash
export SERPKITE_API_KEY=skt_live_...
```

## Configuration

```ts
const sk = new SerpKite({
  apiKey: "skt_live_...", // default: process.env.SERPKITE_API_KEY
  baseUrl: "https://api.serpkite.com", // default: SERPKITE_BASE_URL or https://api.serpkite.com
  timeoutMs: 60_000, // per attempt
  maxRetries: 2, // retries after the first attempt
  retryDelayMs: 500, // base of the exponential backoff
  fetch: customFetch, // default: globalThis.fetch
  headers: { "X-Request-Id": "my-trace-id" }, // sent with every request
});
```

The constructor throws a `SerpKiteError` with code `missing_api_key` when no key is found. On
runtimes without `process.env` (browsers, some edge platforms) pass `apiKey` explicitly. Don't
ship a secret key to a public web page.

Every method also takes a second `options` argument:

```ts
await sk.search(
  { q: "espresso" },
  {
    signal: AbortSignal.timeout(10_000),
    timeoutMs: 20_000,
    maxRetries: 0,
    headers: { "X-Request-Id": "trace-123" },
    onResponse: (info) => console.log(info.creditsUsed, info.creditsRemaining, info.cache),
  },
);
```

`onResponse` receives the billing headers of the successful response: `requestId`, `creditsUsed`,
`creditsRemaining`, `costUsd`, `cache` (`HIT` | `MISS`), `latencyMs`, `tokensEstimate`, plus the raw
`headers` and `status`.

## Methods

All request and response fields are snake_case, exactly as in the HTTP API. Every vertical returns
the same envelope: `request` (the normalised request), `results` (the vertical's primary list),
vertical-specific extras and `meta` (`request_id`, `credits_used`, `cached`, `latency_ms`, …).

| Method | Endpoint | Params | Returns |
| --- | --- | --- | --- |
| `search(params)` | `POST /v1/search` | `SearchParams` | `SearchResponse` (results, `answer_box`, `knowledge_graph`, `people_also_ask`, `related_searches`, `top_stories`, `places`, `ads`) |
| `images(params)` | `POST /v1/images` | `SearchParams` | `ImagesResponse` |
| `videos(params)` | `POST /v1/videos` | `SearchParams` | `VideosResponse` |
| `news(params)` | `POST /v1/news` | `SearchParams` | `NewsResponse` |
| `maps(params)` | `POST /v1/maps` | `SearchParams` (+ `ll`: `"@lat,lng,14z"`) | `PlacesResponse` |
| `places(params)` | `POST /v1/places` | `SearchParams` | `PlacesResponse` |
| `reviews(params)` | `POST /v1/reviews` | `ReviewsParams` (`place_id` \| `cid` \| `fid`, `sort`, `page_token`, `num` ≤ 50) | `ReviewsResponse` (+ `next_page_token`) |
| `shopping(params)` | `POST /v1/shopping` | `SearchParams` | `ShoppingResponse` |
| `scholar(params)` | `POST /v1/scholar` | `SearchParams` | `ScholarResponse` |
| `patents(params)` | `POST /v1/patents` | `SearchParams` | `PatentsResponse` |
| `autocomplete(params)` | `POST /v1/autocomplete` | `SearchParams` | `AutocompleteResponse` (`results[].value`) |
| `webpage(params)` | `POST /v1/webpage` | `WebpageParams` (`url`, `include_html`) | `WebpageResponse` (`markdown`, `text`, `metadata`) |
| `rank(params)` | `POST /v1/rank` | `RankParams` (`q`, `domain`, `num`: 10\|20\|30\|50\|100) | `RankResponse` (`position` or `null`, `matches`, `checked`) |
| `extract(params)` | `POST /v1/extract` | `ExtractParams` (`urls` ≤ 20, `format`, `query`, `highlights`, …) | `ExtractResponse` (`results`, `failed`) |
| `map(params)` | `POST /v1/map` | `MapParams` (`url`, `search`, `limit`, `sitemap`, path filters) | `MapResponse` (`results[].url`) |
| `crawl(params)` | `POST /v1/crawl` | `CrawlParams` (`url`, `limit` ≤ 1000, `max_depth` ≤ 10, …) | `TaskCreated` (`202`) |
| `getCrawl(id)` / `cancelCrawl(id)` | `GET` / `DELETE /v1/crawl/{id}` | task id | `CrawlTask` / `TaskCancelResponse` |
| `waitForCrawl(idOrTask, options?)` | polls `GET /v1/crawl/{id}` | task id or task | `CrawlTask` (`completed`, `failed` or `canceled`) |
| `monitors.create/list/get/update/delete/run` | `/v1/monitors…` | `MonitorCreateParams`, `MonitorUpdateParams` | `Monitor`, `MonitorList` |
| `monitors.runs(id, params?)` / `monitors.iterRuns(id)` | `GET /v1/monitors/{id}/runs` | `limit`, `before` | `MonitorRunList` / `AsyncIterable<MonitorRun>` |
| `account()` | `GET /v1/account` | none | `Account` (`balance`, `plan`, `rate_limit_rps`, `month`, …) |
| `batches.create(params)` | `POST /v1/batches` | `BatchCreateParams` | `BatchCreateResponse` |
| `batches.get(id)` | `GET /v1/batches/{id}` | batch id | `Batch` |
| `batches.wait(id, options?)` | polls `GET /v1/batches/{id}` | batch id or entry | `Batch` (`done` or `failed`) |

Common `SearchParams`: `q` (required), `country` (default `us`), `language` (default `en`),
`location`, `uule`, `num` (10, or 100 for the depth bundle), `page` (1-10), `time`
(`hour`|`day`|`week`|`month`|`year`), `tbs`, `device` (`desktop`|`mobile`), `safe`, `autocorrect`,
`format` (`json`|`markdown`|`compact`), `fields`, `include_content` (0-5), `ads`, `max_age`,
`engine`.

### Examples

```ts
// News from the last day in Germany
const news = await sk.news({ q: "EZB Zinsen", country: "de", language: "de", time: "day" });

// Top 3 organic pages fetched as Markdown (+1 credit per page)
const deep = await sk.search({ q: "rust async runtime comparison", include_content: 3 });
console.log(deep.results[0].content);

// Only the fields you need
const lean = await sk.search({ q: "espresso", fields: "results.title,results.link,answer_box" });

// Token-lean JSON for agents
const compact = await sk.search({ q: "espresso", format: "compact" });

// Reviews, paged
let page = await sk.reviews({ place_id: "ChIJN1t_tDeuEmsRUsoyG83frY4", sort: "newest" });
while (page.next_page_token) {
  page = await sk.reviews({ place_id: "ChIJN1t_tDeuEmsRUsoyG83frY4", page_token: page.next_page_token });
}

// Any URL as Markdown
const doc = await sk.webpage({ url: "https://example.com/blog/post" });
console.log(doc.metadata.title, doc.markdown);

// Where does a domain rank?
const r = await sk.rank({ q: "espresso machine", domain: "example.com" });
console.log(r.position ?? "not in top 100");

// Account balance
const { balance, month } = await sk.account();

// Cached result up to one hour old (half price on a hit)
await sk.search({ q: "espresso", max_age: 3600 });
```

`format: "markdown"` resolves to a `string` for every vertical that supports it; `format:
"compact"` resolves to a `CompactResponse`. The return type follows the literal you pass. With
`fields` the response contains only the requested keys, so treat the typed fields as optional.

## Search controls

Domain filters and date ranges work on search, news, images and videos; `boost_domains` on search
and news; `highlights` on search with `include_content`. None of them costs extra credits.

```ts
const res = await sk.search({
  q: "connection pooling",
  include_domains: ["postgresql.org", "github.com/pgbouncer", ".edu"], // host, path prefix or TLD (≤ 20)
  exclude_domains: ["pinterest.com"],
  boost_domains: ["postgresql.org"], // to the top, keeping the rest
  start_date: "2026-01-01", // YYYY-MM-DD, end_date too
  include_content: 3,
  highlights: true, // 3 query-ranked passages per page instead of the whole page
});
for (const r of res.results) console.log(r.position, r.published_at, r.highlights?.[0]?.text);
```

## Search engines & fallback

By default every request is answered by Google only (`engine: "google"`); SerpKite already
fails over across its own proxy pools. Opt in to other providers with `engine`:

```ts
// Fall back to other enabled providers when Google is blocked or times out
const res = await sk.search({ q: "best espresso machine", engine: "auto" });
console.log(res.meta.engine); // "google", or e.g. "brave" if Google was unavailable
console.log(res.meta.route); // [{ provider: "google", outcome: "blocked", ms: 812 }, { provider: "brave", outcome: "ok", ms: 431 }]

// Only these providers, in this order
await sk.news({ q: "espresso", engine: ["google", "brave"] });
```

- `engine` is `"google"` (default), `"auto"`, `"consensus"`, one `Provider` (`"brave"`, `"bing"`,
  `"yahoo"`, `"duckduckgo"`, `"mojeek"`, `"wikipedia"`) or a `Provider[]` list. `"auto"` and `"consensus"` can't
  be combined with other names; unknown names, or a provider that doesn't serve the endpoint, return
  `400 invalid_request`.
- `engine: "consensus"` (`search` only) asks several independent indexes in parallel, merges the
  results by URL and ranks them by agreement: each result has `sources` (e.g.
  `["google", "brave"]`), `meta.engine` is `"consensus"`, and it costs the sum of one page per
  provider that returned results.
- `meta.engine` names the provider that answered; `meta.route` (`RouteStep[]`) lists each attempt
  and its `outcome` (absent on cache hits). `request.engine` echoes what you asked for.
- Credits (`meta.credits_used`, `X-Credits-Used`) follow the answering provider's price.

## Map and extract

```ts
// The URLs of a site (1 credit): sitemaps + start page, canonicalised and deduplicated
const site = await sk.map({ url: "https://docs.example.com/", search: "install", include_paths: ["^/guides/"] });
for (const u of site.results) console.log(u.url);

// Up to 20 URLs (HTML or PDF) as Markdown in one call: 1 credit per URL that came back
const pages = await sk.extract({ urls: site.results.slice(0, 5).map((u) => u.url), query: "install", highlights: 3 });
for (const f of pages.failed) console.log("failed", f.url, f.error.code); // not charged
```

## Crawl

```ts
const task = await sk.crawl({
  url: "https://docs.example.com/",
  limit: 200, // up to 1000 pages; max_depth up to 10
  include_paths: ["^/guides/"],
  sitemap: "include", // include (default) | only | skip
  query: "authentication", // read the most relevant pages first
});
const done = await sk.waitForCrawl(task); // polls until completed/failed/canceled
for (const p of done.result?.pages ?? []) console.log(p.url, p.markdown?.length);
console.log(done.result?.stats.stopped); // done | limit | time_limit | size_limit | too_many_failures | canceled
```

- `crawl` reserves `limit` credits and charges 1 per page read (0.5 from cache); the rest is
  refunded. A crawl that reads nothing fails (`no_pages`) and costs nothing.
- It returns `202` with a task; `waitForCrawl` takes `{ timeoutMs, pollIntervalMs, maxPollIntervalMs,
  signal }` like `batches.wait` (default timeout 35 minutes: a crawl runs for up to 30) and
  returns failed or canceled tasks instead of throwing.
- `cancelCrawl(id)` refunds a queued crawl; a running one stops at its next checkpoint
  (`status: "canceling"`) and is charged for the pages read.
- Robots.txt (per host) and Crawl-delay are honoured; `result.stats` reports `discovered`, `queued`,
  `duplicates`, `sitemap_urls`, `robots`, `robots_blocked` and why it `stopped`.
- Pass `webhook_url` to get a signed `crawl.completed` delivery instead of polling. A result over
  4 MB arrives as `result: null` with `result_omitted: true`; fetch it from `poll_url`.

## Monitors

```ts
const mon = await sk.monitors.create({
  q: "ai agents",
  endpoint: "news",
  interval: "hourly", // hourly | daily | weekly, or interval_seconds (3600-2592000)
  webhook_url: "https://example.com/hooks/serpkite",
});
await sk.monitors.run(mon.id); // due within ~30 s
await sk.monitors.update(mon.id, { active: false });
await sk.monitors.update(mon.id, { q: "ai agents frameworks", num: 20 }); // change the saved search
const { results } = await sk.monitors.list();

// Run history, newest first (new results kept 24 h): one page, or every run
const page = await sk.monitors.runs(mon.id, { limit: 20 }); // page.next_before → { before }
for await (const run of sk.monitors.iterRuns(mon.id)) console.log(run.status, run.new_results);
await sk.monitors.delete(mon.id);
```

A `webpage` monitor watches one page instead of a search: it checks `url` each interval (1 credit
per check) and reports it as a `MonitorPageChange` (`url`, `title`, `change: "new" | "changed"`,
`content_hash`, `markdown`) when its content changes. `metadata` (your own JSON object, ≤ 2 KB) is
stored on any monitor and echoed in its `monitor.results` webhooks; on `update`, an object replaces it
and `null` clears it.

```ts
const watch = await sk.monitors.create({
  endpoint: "webpage",
  url: "https://example.com/pricing",
  interval: "daily",
  metadata: { customer: "acme" },
});
await sk.monitors.update(watch.id, { metadata: null });
```

Each search run costs what its search costs (1 credit per 10 results, `num` 100 is 7; empty and failed runs are free) and POSTs only results it
hasn't seen before (among the top `num`) as a `monitor.results` webhook. `webhook_url` is optional:
without one, read new results from `monitors.runs`. `active: false` creates a monitor paused; after 10
failed runs in a row it pauses itself (`last_status: "paused"`) and `update(id, { active: true })`
resumes it. `webhook_url: ""` removes the webhook; a changed search reports every result as new once.

## Webhooks

Every delivery (`batch.completed`, `crawl.completed`, `monitor.results`) is signed with
`X-SerpKite-Signature`. `parseWebhook` verifies it and returns the event typed by
`X-SerpKite-Event`, with `deliveryId` from `X-SerpKite-Delivery` (for `monitor.results`, the
`run_id`) to deduplicate retries:

```ts
import { parseWebhook } from "serpkite";

const ev = await parseWebhook(process.env.SERPKITE_WEBHOOK_SECRET!, rawBody, req.headers); // throws invalid_signature
if (ev.type === "monitor.results") console.log(ev.data.metadata, ev.data.url, ev.data.new_results.length);
if (ev.type === "crawl.completed") console.log(ev.data.status, ev.data.poll_url);
```

`verifyWebhook(secret, rawBody, headers)` only checks the signature and returns a boolean.

## Batches

Batch jobs cost half price. Submit 1-100 requests for one endpoint; each request becomes a job.

```ts
import { isBatchError, SerpKite } from "serpkite";

const sk = new SerpKite();
const { batches } = await sk.batches.create({
  endpoint: "search", // or images, news, maps, reviews, webpage, …
  requests: [{ q: "a" }, { q: "b" }],
  webhook_url: "https://example.com/hooks/serpkite", // optional
});

const done = await sk.batches.wait(batches[0].id); // polls until done/failed
console.log(done.status, done.result);

// Wait for all queued jobs; skip entries that were rejected at submit time
const jobs = await Promise.all(batches.filter((b) => !isBatchError(b)).map((b) => sk.batches.wait(b)));
```

- `create` returns one entry per request, in order: a queued `Batch` or an error object
  (`{ error: { code, message, request_id } }`). Use `isBatchError(entry)` to tell them apart.
  Passing a rejected entry to `wait` throws its error.
- `wait(idOrEntry, { timeoutMs = 600000, pollIntervalMs = 1000, maxPollIntervalMs = 10000, signal })`
  polls with a growing interval. It returns failed jobs (check `status` and `error`) and throws a
  `SerpKiteError` with code `timeout` when the deadline passes.
- Pass `{ idempotencyKey }` as the second argument to `create` (e.g. a UUID you store with the batch)
  to make it safe to retry: the server replays the first response for the same key and body for
  24 hours, and the SDK then also retries 5xx and network errors.
- Results are kept for 24 hours. Webhooks are always signed with `X-SerpKite-Signature` (HMAC-SHA256
  of `<X-SerpKite-Timestamp>.<body>` with your webhook secret). Check a delivery with
  `await verifyWebhook(secret, rawBody, req.headers)`.

## Errors

Every failure is a `SerpKiteError`:

```ts
import { SerpKite, SerpKiteError } from "serpkite";

try {
  await sk.search({ q: "espresso" });
} catch (err) {
  if (err instanceof SerpKiteError) {
    console.log(err.status, err.code, err.message, err.requestId);
  }
}
```

| `code` | `status` | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | Bad or unknown parameter |
| `unauthorized` | 401 | Missing or invalid API key |
| `insufficient_credits` | 402 | Balance too low |
| `spend_cap_reached`, `key_limit_reached` | 403 | Account spend cap or per-key monthly limit hit |
| `forbidden` | 403 | Not allowed |
| `not_found` | 404 | Unknown batch id |
| `rate_limited` | 429 | Too many requests (retried automatically) |
| `upstream_error`, `upstream_blocked` | 503 | Google could not be fetched (not billed, retried) |
| `upstream_timeout` | 503 | The search took too long (not billed, retried) |
| `unavailable` | 503 | Temporarily unavailable (retried) |
| `internal` | 500 | Server error (retried) |
| `connection_error`, `timeout` | 0 | No response received |
| `missing_api_key` | 0 | No key passed and `SERPKITE_API_KEY` unset |

Failed, empty and blocked searches are refunded, so they never cost credits.

## Retries

Requests are retried up to `maxRetries` times (default 2) on `429`, `5xx`, network errors and
timeouts, with exponential backoff (`retryDelayMs · 2^attempt`, capped at 8 s) and jitter. A
`Retry-After` header (seconds or HTTP date, capped at 60 s) takes precedence. Other `4xx` errors
are never retried. `batches.create`, `crawl`, `monitors.create` and `monitors.run` retry only on
`429`, so a lost response can never queue (and bill) the same work twice.

## Types

Types are generated from the OpenAPI contract (`backend/api/serp-api.yaml`) with
`openapi-typescript`. Friendly aliases are exported: `SearchParams`, `SearchResponse`,
`OrganicResult`, `AnswerBox`, `NewsResponse`, `NewsResult`, `ImagesResponse`, `PlacesResponse`,
`ReviewsResponse`, `ShoppingResponse`, `ScholarResponse`, `PatentsResponse`,
`AutocompleteResponse`, `WebpageResponse`, `RankResponse`,
`Account`, `Batch`, `BatchCreateParams`, `Meta`, `Engine`, `Provider`, `RouteStep`,
`CompactResponse`, `MapResponse`, `ExtractResponse`, `CrawlParams`, `CrawlTask`, `CrawlResult`,
`TaskCreated`, `Monitor`, `MonitorRun`, `MonitorPageChange`, `TaskCompletedEvent`,
`MonitorResultsEvent`, `WebhookEvent` and more. The raw
`paths`, `components` and `operations` types are exported as well.

## Development

```bash
bun install          # from the repo root
bun run gen          # regenerate src/generated/openapi.ts from backend/api/serp-api.yaml
bun run typecheck
bun test
bun run build        # dist/: ESM, CJS and .d.ts
```

## License

MIT
