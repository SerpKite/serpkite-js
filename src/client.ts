import { errorFromResponse, SerpKiteError } from "./errors";
import type {
  Account,
  AnswerParams,
  AnswerResponse,
  AnswerStreamEvent,
  AssistantParams,
  AssistantResponse,
  AutocompleteResponse,
  Batch,
  BatchCreateEntry,
  BatchCreateParams,
  BatchCreateResponse,
  ChatGPTParams,
  CompactResponse,
  CrawlParams,
  CrawlTask,
  ExtractParams,
  ExtractResponse,
  ImagesResponse,
  MapParams,
  MapResponse,
  Monitor,
  MonitorCreateParams,
  MonitorList,
  MonitorRun,
  MonitorRunList,
  MonitorRunsParams,
  MonitorUpdateParams,
  NewsResponse,
  PatentsResponse,
  PlaceParams,
  PlacesResponse,
  RankParams,
  RankResponse,
  ResearchParams,
  ResearchTask,
  ReviewsParams,
  ReviewsResponse,
  ScholarResponse,
  SearchParams,
  SearchResponse,
  ShoppingResponse,
  TaskCancelResponse,
  TaskCreated,
  VideosResponse,
  WebpageParams,
  WebpageResponse,
} from "./types";

export const VERSION = "0.8.0";
export const DEFAULT_BASE_URL = "https://api.serpkite.com";

export interface SerpKiteOptions {
  /** API key (`skt_live_…`). Defaults to the `SERPKITE_API_KEY` environment variable. */
  apiKey?: string;
  /** Defaults to `SERPKITE_BASE_URL` or https://api.serpkite.com. */
  baseUrl?: string;
  /** Per-attempt timeout in milliseconds. Default 60000. */
  timeoutMs?: number;
  /** Retries after the first attempt on 429, 5xx and network errors. Default 2. */
  maxRetries?: number;
  /** Base delay of the exponential backoff in milliseconds. Default 500. */
  retryDelayMs?: number;
  /** Custom fetch implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
}

/** Billing and tracing details from the response headers. */
export interface ResponseInfo {
  status: number;
  headers: Headers;
  requestId: string | undefined;
  creditsUsed: number | undefined;
  creditsRemaining: number | undefined;
  costUsd: number | undefined;
  /** `HIT` when served from cache (`max_age`), else `MISS`. */
  cache: "HIT" | "MISS" | undefined;
  latencyMs: number | undefined;
  tokensEstimate: number | undefined;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Overrides the client's per-attempt timeout. */
  timeoutMs?: number;
  /** Overrides the client's retry count. */
  maxRetries?: number;
  headers?: Record<string, string>;
  /** Called with the final response's headers (credits used/remaining, cache, request id). */
  onResponse?: (info: ResponseInfo) => void;
}

export interface BatchCreateOptions extends RequestOptions {
  /**
   * Sent as `Idempotency-Key` (1-255 printable ASCII characters, e.g. a UUID).
   * For 24 hours a retry with the same key and body returns the first response
   * instead of queueing and billing the jobs again.
   */
  idempotencyKey?: string;
}

export interface WaitOptions {
  /**
   * Give up after this many milliseconds. Default 600000 (10 minutes) for batches,
   * 2100000 (35 minutes) for `waitForCrawl` (a crawl runs for up to 30 minutes) and
   * 900000 (15 minutes) for `waitResearch`.
   */
  timeoutMs?: number;
  /** First delay between polls. Default 1000. Grows 1.5× per poll. */
  pollIntervalMs?: number;
  /** Upper bound of the delay between polls. Default 10000. */
  maxPollIntervalMs?: number;
  signal?: AbortSignal;
}

/** A vertical whose return type follows `format`: `"markdown"` → string, `"compact"` → CompactResponse. */
export interface VerticalMethod<P, R> {
  (params: P & { format: "markdown" }, options?: RequestOptions): Promise<string>;
  (params: P & { format: "compact" }, options?: RequestOptions): Promise<CompactResponse>;
  (params: P & { format?: "json" }, options?: RequestOptions): Promise<R>;
  (params: P, options?: RequestOptions): Promise<R | CompactResponse | string>;
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

/** Minimum per-attempt timeout of the AI assistant methods: answers take 10-90 s. */
export const ASSISTANT_TIMEOUT_MS = 120_000;

/** Task states after which `waitForCrawl` and `waitResearch` return. */
const TASK_DONE = new Set(["completed", "failed", "canceled"]);

interface Call {
  method: Method;
  path: string;
  body?: unknown;
  options?: RequestOptions;
  /** Which failures are safe to retry. `all` = 429, 5xx and network errors. */
  retry?: "all" | "rate_limit";
}

export class SerpKite {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;

  constructor(options: SerpKiteOptions = {}) {
    const apiKey = options.apiKey ?? env("SERPKITE_API_KEY");
    if (!apiKey) {
      throw new SerpKiteError(
        0,
        "missing_api_key",
        "No API key: pass { apiKey } or set the SERPKITE_API_KEY environment variable",
      );
    }
    this.#apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? env("SERPKITE_BASE_URL") ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.retryDelayMs = options.retryDelayMs ?? 500;
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new SerpKiteError(
        0,
        "missing_fetch",
        "No global fetch: pass { fetch } (Node 18+ has one)",
      );
    }
    this.#fetch = f;
    this.#headers = { ...options.headers };
  }

  // ── Verticals ─────────────────────────────────────────────────────────

  /** Google web search: organic results, answer box, knowledge graph, people also ask… */
  readonly search = this.#vertical<SearchParams, SearchResponse>("/v1/search");
  /** Google Images. */
  readonly images = this.#vertical<SearchParams, ImagesResponse>("/v1/images");
  /** Google Videos. */
  readonly videos = this.#vertical<SearchParams, VideosResponse>("/v1/videos");
  /** Google News. */
  readonly news = this.#vertical<SearchParams, NewsResponse>("/v1/news");
  /**
   * Google Maps search (places with coordinates). Accepts `ll` ("@lat,lng,14z"). With
   * `engine: "yandex"` (where enabled) the places come from Yandex Maps and carry an `oid`.
   */
  readonly maps = this.#vertical<SearchParams, PlacesResponse>("/v1/maps");
  /** Google local results. */
  readonly places = this.#vertical<SearchParams, PlacesResponse>("/v1/places");
  /**
   * Details of one place by `place_id`, `cid` or `fid`, or by a Yandex Maps `oid` (implies
   * `engine: "yandex"`): address, country, time zone, hours
   * (`opening_hours` text and structured `weekly_hours`), phones, description and photos.
   * `results` holds the place, or is empty (not charged) when no place has that id. 1 credit.
   */
  readonly place = this.#vertical<PlaceParams, PlacesResponse>("/v1/place");
  /** Reviews of a place by `place_id`, `cid` or `fid`. Page with `page_token` = `next_page_token`. */
  readonly reviews = this.#vertical<ReviewsParams, ReviewsResponse>("/v1/reviews");
  /** Google Shopping. */
  readonly shopping = this.#vertical<SearchParams, ShoppingResponse>("/v1/shopping");
  /** Google Scholar. */
  readonly scholar = this.#vertical<SearchParams, ScholarResponse>("/v1/scholar");
  /** Google Patents. */
  readonly patents = this.#vertical<SearchParams, PatentsResponse>("/v1/patents");
  /** Google autocomplete suggestions. */
  readonly autocomplete = this.#vertical<SearchParams, AutocompleteResponse>("/v1/autocomplete");
  /** Fetch any public URL as clean Markdown plus metadata. */
  readonly webpage = this.#vertical<WebpageParams, WebpageResponse>("/v1/webpage");

  // ── AI assistants ─────────────────────────────────────────────────────
  // Billed even when the response is lost: retried only on 429 (failed, refused and empty
  // answers are free), and each attempt waits at least 120 s (answers take 10-90 s).

  /**
   * Ask ChatGPT as a logged-out user: the answer (`text`, `markdown`), cited `sources`,
   * `search_queries`, `products`, `places` and the guest `model`. `web_search` (default true)
   * makes it search the web; `country` asks from an exit in that country. `track` returns
   * `mentions` of your brands and domains. 5 credits.
   */
  readonly chatgpt = this.#assistant<ChatGPTParams>("/v1/chatgpt");
  /** Ask Google Gemini as a logged-out user: the answer with the sources it grounded on. 5 credits. */
  readonly gemini = this.#assistant<AssistantParams>("/v1/gemini");
  /** Microsoft Copilot Search on Bing: the answer, cited sources and products. 3 credits. */
  readonly copilot = this.#assistant<AssistantParams>("/v1/copilot");
  /** Google AI Mode: the answer, cited sources and products. 3 credits. */
  readonly aiMode = this.#assistant<AssistantParams>("/v1/ai_mode");
  /** Brave Search's AI answer: cited sources, the searches it ran and products. 2 credits. */
  readonly braveAi = this.#assistant<AssistantParams>("/v1/brave_ai");

  /** Position of `domain` for keyword `q` in the top `num` results (default 100). */
  rank(params: RankParams, options?: RequestOptions): Promise<RankResponse> {
    return this.request({ method: "POST", path: "/v1/rank", body: params, options });
  }

  /**
   * Read up to 20 URLs (HTML or PDF) as Markdown, text or HTML in one call, with optional
   * query-ranked `highlights` (BM25), `include_links` and `include_images`. 1 credit per URL
   * that comes back (0.5 from cache); URLs that fail are listed in `failed` and cost nothing.
   * `summary: true` adds an AI summary of each page and `output_schema` (a JSON Schema, guided
   * by an optional `prompt`) returns each page's data as JSON in `output`, each at an extra
   * per-page price (https://serpkite.com/pricing); a page whose model step failed has
   * `summary_error` / `output_error` instead and isn't charged for it.
   */
  extract(params: ExtractParams, options?: RequestOptions): Promise<ExtractResponse> {
    // Billed per page even when the response is lost: retried only on 429, and the HTTP
    // timeout covers the server's deadline (timeout: default 50 s, 75 s with AI) + 15 s.
    const ai = params.summary === true || params.output_schema !== undefined;
    const wait = ((params.timeout ?? (ai ? 75 : 50)) + 15) * 1000;
    return this.request({
      method: "POST",
      path: "/v1/extract",
      body: params,
      options: {
        ...options,
        timeoutMs: options?.timeoutMs ?? (this.timeoutMs > 0 ? Math.max(this.timeoutMs, wait) : 0),
      },
      retry: "rate_limit",
    });
  }

  /**
   * The URLs of a site from its sitemaps (XML, RSS/Atom, gzip, plain text) and start page,
   * canonicalised and deduplicated, optionally ranked by `search`. `include_paths` /
   * `exclude_paths` (regular expressions on the URL path) and `ignore_query_parameters`
   * narrow the list. 1 credit; free when nothing is found.
   */
  map(params: MapParams, options?: RequestOptions): Promise<MapResponse> {
    return this.request({ method: "POST", path: "/v1/map", body: params, options });
  }

  /** Balance, limits and this month's usage for the key's account. */
  account(options?: RequestOptions): Promise<Account> {
    return this.request({ method: "GET", path: "/v1/account", options });
  }

  // ── AI answers ────────────────────────────────────────────────────────

  /**
   * A cited answer grounded on live Google results: Markdown with `[n]` markers in `answer`,
   * the cited sources in `citations`. `depth: "fast"` answers from the result page;
   * `"standard"` (default) also reads the top `num_sources` pages and costs more
   * (https://serpkite.com/pricing; `meta.credits` splits search and model). With
   * `output_schema` the answer is a JSON value in `output`.
   * When the model fails the call throws `ai_unavailable` (503) and the model part is refunded;
   * a search with nothing to answer from returns `answer: null` and a `meta.warnings` entry.
   */
  answer(params: AnswerParams, options?: RequestOptions): Promise<AnswerResponse> {
    // Billed even when the response is lost (and a 503 ai_unavailable still charges the
    // search part): retried only on 429, and the HTTP timeout covers a search plus the model.
    return this.request({
      method: "POST",
      path: "/v1/answer",
      body: params,
      options: { ...options, timeoutMs: this.#answerTimeout(options) },
      retry: "rate_limit",
    });
  }

  /**
   * Streams an answer as Server-Sent Events: `results` first, then `delta` text pieces,
   * then `done` (final answer, citations, meta). A server `error` event is thrown as a
   * `SerpKiteError` (`ai_unavailable`). Breaking out of the loop closes the connection
   * (the model part is then not charged). Can't be combined with `output_schema`.
   *
   * ```ts
   * for await (const ev of sk.answerStream({ q: "what is retrieval-augmented generation" })) {
   *   if (ev.event === "delta") process.stdout.write(ev.data.text);
   * }
   * ```
   */
  answerStream(params: AnswerParams, options?: RequestOptions): AsyncIterable<AnswerStreamEvent> {
    return this.#stream(
      { ...params, stream: true },
      { ...options, timeoutMs: this.#answerTimeout(options) },
    );
  }

  /** The search (pages read included) runs before the first byte: wait at least 100 s. */
  #answerTimeout(options?: RequestOptions): number {
    return options?.timeoutMs ?? (this.timeoutMs > 0 ? Math.max(this.timeoutMs, 100_000) : 0);
  }

  // ── Async tasks: crawl ────────────────────────────────────────────────

  /**
   * Starts an async crawl of one site and returns the queued task (`202`). 1 credit per page
   * read (0.5 from cache); `limit` credits (up to 1000 pages, `max_depth` up to 10) are
   * reserved up front and the rest refunded. `sitemap` (`include` default, `only`, `skip`)
   * seeds the crawl with sitemap URLs; `query` reads the most relevant pages first. robots.txt
   * and Crawl-delay are honoured; `result.stats.stopped` says why the crawl ended (`done`,
   * `limit`, `time_limit`, `size_limit`, `too_many_failures`, `canceled`).
   * Only retried on 429, so a lost response never starts (and reserves) a second crawl.
   */
  crawl(params: CrawlParams, options?: RequestOptions): Promise<TaskCreated> {
    return this.request({
      method: "POST",
      path: "/v1/crawl",
      body: params,
      options,
      retry: "rate_limit",
    });
  }

  /** Polls a crawl (results are kept for 24 hours). */
  getCrawl(id: string, options?: RequestOptions): Promise<CrawlTask> {
    return this.request({ method: "GET", path: `/v1/crawl/${encodeURIComponent(id)}`, options });
  }

  /** Cancels a crawl: refunded if still queued, else stops at the next checkpoint. */
  cancelCrawl(id: string, options?: RequestOptions): Promise<TaskCancelResponse> {
    return this.request({
      method: "DELETE",
      path: `/v1/crawl/${encodeURIComponent(id)}`,
      options,
    });
  }

  /**
   * Polls until the crawl is `completed`, `failed` or `canceled` and returns it (a failed
   * task is returned, not thrown; check `status` and `error`). Accepts an id or the task
   * returned by `crawl`.
   */
  async waitForCrawl(
    idOrTask: string | { id: string },
    options: WaitOptions = {},
  ): Promise<CrawlTask> {
    return this.#waitTask(taskId(idOrTask), (id) => this.getCrawl(id, { signal: options.signal }), {
      ...options,
      timeoutMs: options.timeoutMs ?? 2_100_000,
    });
  }

  // ── Async tasks: research ─────────────────────────────────────────────

  /**
   * Starts an async research task: the model plans searches, reads the sources and writes a
   * cited Markdown report (`result.report`). `effort` (`lite`, `standard` (default), `deep`)
   * sets how much is searched and read; its flat price (https://serpkite.com/pricing) is
   * reserved up front and charged only when the report is written (a canceled task is charged
   * for the searches already run). With
   * `output_schema` the report is also returned as JSON in `result.output`. Poll with
   * `getResearch` / `waitResearch` or receive the signed `research.completed` webhook.
   * Only retried on 429, so a lost response never starts (and reserves) a second task.
   */
  research(params: ResearchParams, options?: RequestOptions): Promise<TaskCreated> {
    return this.request({
      method: "POST",
      path: "/v1/research",
      body: params,
      options,
      retry: "rate_limit",
    });
  }

  /** Polls a research task (`progress` while it runs; results are kept for 24 hours). */
  getResearch(id: string, options?: RequestOptions): Promise<ResearchTask> {
    return this.request({
      method: "GET",
      path: `/v1/research/${encodeURIComponent(id)}`,
      options,
    });
  }

  /**
   * Cancels a research task: refunded if still queued, else stops at its next round and is
   * charged for the searches run.
   */
  cancelResearch(id: string, options?: RequestOptions): Promise<TaskCancelResponse> {
    return this.request({
      method: "DELETE",
      path: `/v1/research/${encodeURIComponent(id)}`,
      options,
    });
  }

  /**
   * Polls until the research task is `completed`, `failed` or `canceled` and returns it (a
   * failed task is returned, not thrown; check `status` and `error`). The report is in
   * `result.report`. Accepts an id or the task returned by `research`. Default timeout
   * 15 minutes.
   */
  async waitResearch(
    idOrTask: string | { id: string },
    options: WaitOptions = {},
  ): Promise<ResearchTask> {
    return this.#waitTask(
      taskId(idOrTask),
      (id) => this.getResearch(id, { signal: options.signal }),
      { ...options, timeoutMs: options.timeoutMs ?? 900_000 },
    );
  }

  // ── Monitors ──────────────────────────────────────────────────────────

  readonly monitors = {
    /**
     * Saves a `search` or `news` request (`q`) that runs on a schedule (hourly to monthly) and
     * POSTs results it hasn't seen before to `webhook_url` (`monitor.results`). With
     * `endpoint: "webpage"` and a `url` it checks that page each interval (1 credit per check)
     * and reports it (`MonitorPageChange`) when its content changes. `metadata` (your JSON
     * object, at most 2 KB) is echoed on the monitor and in its webhooks. Without a
     * `webhook_url`, read new results from `monitors.runs`. `active: false`
     * creates it paused. With an AI assistant `endpoint` (`chatgpt`, `gemini`, `copilot`,
     * `ai_mode`, `brave_ai`) and a `prompt` every run reports the answer (`MonitorAnswer`:
     * sources, `new_sources`, `mentions` with `track`). A monitor pauses itself after 10 failed runs in a row
     * (`last_status: "paused"`); `update(id, { active: true })` resumes it. Each run costs
     * what its search costs. Only retried on 429.
     */
    create: (params: MonitorCreateParams, options?: RequestOptions): Promise<Monitor> =>
      this.request({
        method: "POST",
        path: "/v1/monitors",
        body: params,
        options,
        retry: "rate_limit",
      }),

    /** The account's monitors. */
    list: (options?: RequestOptions): Promise<MonitorList> =>
      this.request({ method: "GET", path: "/v1/monitors", options }),

    get: (id: string, options?: RequestOptions): Promise<Monitor> =>
      this.request({ method: "GET", path: `/v1/monitors/${encodeURIComponent(id)}`, options }),

    /**
     * Changes `name`, `interval` / `interval_seconds`, `webhook_url` (`""` removes it),
     * `active` (`true` resumes a paused monitor), `metadata` (an object replaces it, `null`
     * clears it) or the saved request (`endpoint`, `q`, `url`, `country`, `num`, domains,
     * `engine`…). Switching `endpoint` between a search and `webpage` drops the other kind's
     * fields. A changed search reports every result as new on the next run.
     */
    update: (id: string, params: MonitorUpdateParams, options?: RequestOptions): Promise<Monitor> =>
      this.request({
        method: "PATCH",
        path: `/v1/monitors/${encodeURIComponent(id)}`,
        body: params,
        options,
      }),

    delete: async (id: string, options?: RequestOptions): Promise<void> => {
      await this.request({
        method: "DELETE",
        path: `/v1/monitors/${encodeURIComponent(id)}`,
        options,
      });
    },

    /** Runs an active monitor at the next scheduler poll (within about 30 seconds).
     * Paused monitors return 409; update(id, { active: true }) resumes and schedules them. */
    run: (id: string, options?: RequestOptions): Promise<Monitor> =>
      this.request({
        method: "POST",
        path: `/v1/monitors/${encodeURIComponent(id)}/run`,
        options,
        retry: "rate_limit",
      }),

    /**
     * One page of the monitor's run history, newest first (`limit` 1-100, default 20). Each
     * run carries its new results for 24 hours. Pass `next_before` as `before` for the next
     * page; it is null on the last one.
     */
    runs: (
      id: string,
      params: MonitorRunsParams = {},
      options?: RequestOptions,
    ): Promise<MonitorRunList> =>
      this.request({
        method: "GET",
        path: `/v1/monitors/${encodeURIComponent(id)}/runs${query(params)}`,
        options,
      }),

    /**
     * Iterates over every run of the monitor, newest first, fetching pages of `limit` as
     * needed (starting at `before` when given).
     *
     * ```ts
     * for await (const run of sk.monitors.iterRuns("m1")) console.log(run.new_results);
     * ```
     */
    iterRuns: (
      id: string,
      params: MonitorRunsParams = {},
      options?: RequestOptions,
    ): AsyncIterable<MonitorRun> => this.#iterRuns(id, params, options),
  };

  // ── Batches ───────────────────────────────────────────────────────────

  readonly batches = {
    /**
     * Queue 1-100 requests for one endpoint at half price. Returns one entry per
     * request, in order: a queued `Batch` or an error object. Without an
     * `idempotencyKey` it is only retried on 429, so a lost response never queues
     * (and bills) the same requests twice. With one, 5xx and network errors are
     * retried too: the server replays the first response for the same key and body.
     */
    create: (
      params: BatchCreateParams,
      options: BatchCreateOptions = {},
    ): Promise<BatchCreateResponse> => {
      const { idempotencyKey, ...rest } = options;
      return this.request({
        method: "POST",
        path: "/v1/batches",
        body: params,
        options: idempotencyKey
          ? { ...rest, headers: { ...rest.headers, "Idempotency-Key": idempotencyKey } }
          : rest,
        retry: idempotencyKey ? "all" : "rate_limit",
      });
    },

    /** Poll one batch job. */
    get: (id: string, options?: RequestOptions): Promise<Batch> =>
      this.request({ method: "GET", path: `/v1/batches/${encodeURIComponent(id)}`, options }),

    /**
     * Poll until the job is `done` or `failed` and return it (a failed job is
     * returned, not thrown; check `status` and `error`). Accepts an id or an
     * entry from `create`; an entry that failed to queue throws its error.
     */
    wait: (idOrEntry: string | BatchCreateEntry | undefined, options: WaitOptions = {}) =>
      this.#wait(idOrEntry, options),
  };

  // ── Plumbing ──────────────────────────────────────────────────────────

  async *#iterRuns(
    id: string,
    params: MonitorRunsParams,
    options?: RequestOptions,
  ): AsyncGenerator<MonitorRun> {
    let before = params.before;
    for (;;) {
      const page = await this.monitors.runs(id, { ...params, before }, options);
      yield* page.results;
      if (!page.next_before || page.results.length === 0) return;
      before = page.next_before;
    }
  }

  async #waitTask<T extends { status: string }>(
    id: string,
    get: (id: string) => Promise<T>,
    o: WaitOptions,
  ): Promise<T> {
    const timeoutMs = o.timeoutMs ?? 600_000;
    const maxInterval = o.maxPollIntervalMs ?? 10_000;
    let interval = o.pollIntervalMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const task = await get(id);
      if (TASK_DONE.has(task.status)) return task;
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new SerpKiteError(
          0,
          "timeout",
          `task ${id} still ${task.status} after ${timeoutMs} ms`,
        );
      }
      await sleep(Math.min(interval, left), o.signal);
      interval = Math.min(interval * 1.5, maxInterval);
    }
  }

  #vertical<P, R>(path: string): VerticalMethod<P, R> {
    return ((params: P, options?: RequestOptions) =>
      this.request({ method: "POST", path, body: params, options })) as VerticalMethod<P, R>;
  }

  #assistant<P>(path: string): VerticalMethod<P, AssistantResponse> {
    return ((params: P, options?: RequestOptions) =>
      this.request({
        method: "POST",
        path,
        body: params,
        options: {
          ...options,
          timeoutMs:
            options?.timeoutMs ??
            (this.timeoutMs > 0 ? Math.max(this.timeoutMs, ASSISTANT_TIMEOUT_MS) : 0),
        },
        retry: "rate_limit",
      })) as VerticalMethod<P, AssistantResponse>;
  }

  async #wait(idOrEntry: string | BatchCreateEntry | undefined, o: WaitOptions): Promise<Batch> {
    let id: string | undefined;
    if (typeof idOrEntry === "string") {
      id = idOrEntry;
    } else if (idOrEntry && "id" in idOrEntry && typeof idOrEntry.id === "string") {
      id = idOrEntry.id;
    } else if (idOrEntry && "error" in idOrEntry && idOrEntry.error && !("id" in idOrEntry)) {
      const e = idOrEntry.error as { code?: string; message?: string; request_id?: string };
      throw new SerpKiteError(
        400,
        e.code ?? "invalid_request",
        e.message ?? "batch entry was not queued",
        e.request_id,
      );
    }
    if (!id) {
      throw new SerpKiteError(0, "invalid_request", "batches.wait needs a batch id");
    }
    const timeoutMs = o.timeoutMs ?? 600_000;
    const maxInterval = o.maxPollIntervalMs ?? 10_000;
    let interval = o.pollIntervalMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const batch = await this.batches.get(id, { signal: o.signal });
      if (batch.status === "done" || batch.status === "failed") return batch;
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new SerpKiteError(
          0,
          "timeout",
          `batch ${id} still ${batch.status} after ${timeoutMs} ms`,
        );
      }
      await sleep(Math.min(interval, left), o.signal);
      interval = Math.min(interval * 1.5, maxInterval);
    }
  }

  /** Opens `POST /v1/answer` as an event stream (retrying the connect like `request`) and parses it. */
  async *#stream(body: unknown, options: RequestOptions = {}): AsyncGenerator<AnswerStreamEvent> {
    const maxRetries = Math.max(0, options.maxRetries ?? this.maxRetries);
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const headers: Record<string, string> = {
      Accept: "text/event-stream, application/json;q=0.9",
      Authorization: `Bearer ${this.#apiKey}`,
      ...this.#headers,
      ...options.headers,
      "Content-Type": "application/json",
    };
    if (!isBrowser()) headers["User-Agent"] = `serpkite-typescript/${VERSION}`;
    let res: Response | undefined;
    let cleanup = () => {};
    for (let attempt = 0; !res; attempt++) {
      const canRetry = attempt < maxRetries;
      // The timeout covers connecting (until the headers arrive), not the whole stream.
      const t = withTimeout(options.signal, timeoutMs);
      let r: Response;
      try {
        r = await this.#fetch(`${this.baseUrl}/v1/answer`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: t.signal,
        });
      } catch (err) {
        t.cleanup();
        if (options.signal?.aborted) throw err;
        if (canRetry) {
          await sleep(this.#backoff(attempt), options.signal);
          continue;
        }
        const code = t.timedOut() ? "timeout" : "connection_error";
        const msg = t.timedOut()
          ? `request timed out after ${timeoutMs} ms`
          : `request failed: ${err instanceof Error ? err.message : String(err)}`;
        throw new SerpKiteError(0, code, msg, undefined, undefined, { cause: err });
      }
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        t.cleanup();
        // Nothing is charged before the stream starts, so 5xx are safe to retry.
        if (canRetry && (r.status === 429 || r.status >= 500)) {
          await sleep(this.#retryDelay(attempt, r.headers), options.signal);
          continue;
        }
        throw errorFromResponse(r.status, r.headers, text);
      }
      // Stop the connect timer but keep forwarding the caller's abort signal.
      t.stopTimer();
      cleanup = t.cleanup;
      res = r;
    }
    options.onResponse?.(responseInfo(res));
    const requestId = res.headers.get("x-request-id") ?? undefined;
    if (!res.body) {
      cleanup();
      throw new SerpKiteError(
        res.status,
        "invalid_response",
        "response has no body",
        requestId,
        res.headers,
      );
    }
    // A plain JSON answer (e.g. from a proxy that dropped the stream) becomes results + done.
    if ((res.headers.get("content-type") ?? "").includes("json")) {
      let answer: AnswerResponse;
      try {
        answer = JSON.parse(await res.text()) as AnswerResponse;
      } catch (err) {
        throw new SerpKiteError(
          res.status,
          "invalid_response",
          "response is not valid JSON",
          requestId,
          res.headers,
          { cause: err },
        );
      } finally {
        cleanup();
      }
      yield { event: "results", data: { request: answer.request, results: answer.results } };
      yield {
        event: "done",
        data: { answer: answer.answer ?? "", citations: answer.citations, meta: answer.meta },
      };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let done = false;
    try {
      while (!done) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (options.signal?.aborted) throw err;
          throw new SerpKiteError(
            0,
            "connection_error",
            `stream read failed: ${err instanceof Error ? err.message : String(err)}`,
            requestId,
            res.headers,
            { cause: err },
          );
        }
        if (chunk.done) {
          buf += decoder.decode();
          done = true;
        } else {
          buf += decoder.decode(chunk.value, { stream: true });
        }
        // A CR at the end of a chunk may be the first half of a CRLF split across chunks:
        // keep it until the next chunk shows what follows.
        const held = !done && buf.endsWith("\r") ? "\r" : "";
        if (held) buf = buf.slice(0, -1);
        buf = buf.replace(/\r\n?/g, "\n");
        let sep = buf.indexOf("\n\n");
        while (sep >= 0 || (done && buf.trim() !== "")) {
          const raw = sep >= 0 ? buf.slice(0, sep) : buf;
          buf = sep >= 0 ? buf.slice(sep + 2) : "";
          const ev = parseSSE(raw);
          if (ev) {
            if (ev.event === "error") throw sseError(ev.data, res.headers, requestId);
            if (ev.event === "results" || ev.event === "delta" || ev.event === "done") {
              yield { event: ev.event, data: ev.data } as AnswerStreamEvent;
              if (ev.event === "done") return;
            }
          }
          sep = buf.indexOf("\n\n");
        }
        buf += held;
      }
      throw new SerpKiteError(
        res.status,
        "invalid_response",
        "the stream ended before the done event",
        requestId,
        res.headers,
      );
    } finally {
      cleanup();
      reader.cancel().catch(() => {});
    }
  }

  /** Low-level request: JSON body in, parsed JSON (or text for non-JSON responses) out. */
  async request<T>(call: Call): Promise<T> {
    const { method, path, body, options = {} } = call;
    const maxRetries = Math.max(0, options.maxRetries ?? this.maxRetries);
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const headers: Record<string, string> = {
      Accept: "application/json, text/markdown;q=0.9",
      Authorization: `Bearer ${this.#apiKey}`,
      ...this.#headers,
      ...options.headers,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // Browsers would turn a custom User-Agent into a CORS preflight header.
    if (!isBrowser()) headers["User-Agent"] = `serpkite-typescript/${VERSION}`;
    const init: RequestInit = {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    };

    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < maxRetries;
      let res: Response;
      const { signal, cleanup, timedOut } = withTimeout(options.signal, timeoutMs);
      try {
        res = await this.#fetch(this.baseUrl + path, { ...init, signal });
      } catch (err) {
        cleanup();
        if (options.signal?.aborted) throw err;
        const code = timedOut() ? "timeout" : "connection_error";
        if (canRetry && call.retry !== "rate_limit") {
          await sleep(this.#backoff(attempt), options.signal);
          continue;
        }
        const msg = timedOut()
          ? `request timed out after ${timeoutMs} ms`
          : `request failed: ${err instanceof Error ? err.message : String(err)}`;
        throw new SerpKiteError(0, code, msg, undefined, undefined, { cause: err });
      }

      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        cleanup();
        if (options.signal?.aborted) throw err;
        if (canRetry && call.retry !== "rate_limit") {
          await sleep(this.#backoff(attempt), options.signal);
          continue;
        }
        const code = timedOut() ? "timeout" : "connection_error";
        throw new SerpKiteError(
          0,
          code,
          "failed to read the response body",
          undefined,
          res.headers,
          {
            cause: err,
          },
        );
      }
      cleanup();

      if (!res.ok) {
        const retryable = res.status === 429 || (res.status >= 500 && call.retry !== "rate_limit");
        if (canRetry && retryable) {
          await sleep(this.#retryDelay(attempt, res.headers), options.signal);
          continue;
        }
        throw errorFromResponse(res.status, res.headers, text);
      }

      options.onResponse?.(responseInfo(res));
      const type = res.headers.get("content-type") ?? "";
      if (type.includes("json")) {
        try {
          return JSON.parse(text) as T;
        } catch (err) {
          throw new SerpKiteError(
            res.status,
            "invalid_response",
            "response is not valid JSON",
            res.headers.get("x-request-id") ?? undefined,
            res.headers,
            { cause: err },
          );
        }
      }
      return text as T;
    }
  }

  #backoff(attempt: number): number {
    const base = Math.min(this.retryDelayMs * 2 ** attempt, 8_000);
    return base / 2 + Math.random() * (base / 2);
  }

  #retryDelay(attempt: number, headers: Headers): number {
    const after = parseRetryAfter(headers.get("retry-after"));
    return after === undefined ? this.#backoff(attempt) : Math.min(after, 60_000);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

/** Builds `?a=1&b=2` from the defined values (empty string when there are none). */
function query(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

function taskId(idOrTask: string | { id: string }): string {
  const id = typeof idOrTask === "string" ? idOrTask : idOrTask?.id;
  if (!id) throw new SerpKiteError(0, "invalid_request", "a task id is required");
  return id;
}

/** Parses one SSE block (`event:` / `data:` lines) into its event name and JSON data. */
function parseSSE(block: string): { event: string; data: unknown } | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return undefined;
  const text = data.join("\n");
  try {
    return { event, data: JSON.parse(text) };
  } catch {
    return { event, data: text };
  }
}

/** The `error` event of an answer stream as a SerpKiteError (503, like the JSON error). */
function sseError(data: unknown, headers: Headers, requestId: string | undefined): SerpKiteError {
  const e = (data as { error?: { code?: string; message?: string; request_id?: string } })?.error;
  return new SerpKiteError(
    503,
    e?.code ?? "unavailable",
    e?.message ?? "the answer stream failed",
    e?.request_id ?? requestId,
    headers,
  );
}

/** Parses Retry-After (seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function responseInfo(res: Response): ResponseInfo {
  const h = res.headers;
  const num = (name: string) => {
    const v = h.get(name);
    if (v === null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const cache = h.get("x-cache")?.toUpperCase();
  return {
    status: res.status,
    headers: h,
    requestId: h.get("x-request-id") ?? undefined,
    creditsUsed: num("x-credits-used"),
    creditsRemaining: num("x-credits-remaining"),
    costUsd: num("x-cost-usd"),
    cache: cache === "HIT" || cache === "MISS" ? cache : undefined,
    latencyMs: num("x-latency-ms"),
    tokensEstimate: num("x-tokens-estimate"),
  };
}

function withTimeout(outer: AbortSignal | undefined, ms: number) {
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort(outer?.reason);
  if (outer?.aborted) ctrl.abort(outer.reason);
  else outer?.addEventListener("abort", onAbort, { once: true });
  const timer =
    ms > 0 && Number.isFinite(ms)
      ? setTimeout(() => {
          timedOut = true;
          ctrl.abort(new SerpKiteError(0, "timeout", `request timed out after ${ms} ms`));
        }, ms)
      : undefined;
  return {
    signal: ctrl.signal,
    timedOut: () => timedOut,
    stopTimer: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    },
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type EnvHost = {
  process?: { env?: Record<string, string | undefined> };
  Deno?: { env?: { get?: (name: string) => string | undefined } };
  document?: unknown;
};

function env(name: string): string | undefined {
  const g = globalThis as EnvHost;
  try {
    const v = g.process?.env?.[name];
    if (v) return v;
  } catch {
    // process.env may be a throwing proxy on some edge runtimes.
  }
  try {
    return g.Deno?.env?.get?.(name) || undefined;
  } catch {
    // Deno without --allow-env.
    return undefined;
  }
}

function isBrowser(): boolean {
  return typeof (globalThis as EnvHost).document !== "undefined";
}
