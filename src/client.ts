import { errorFromResponse, SerpKiteError } from "./errors";
import type {
  Account,
  AutocompleteResponse,
  Batch,
  BatchCreateEntry,
  BatchCreateParams,
  BatchCreateResponse,
  CompactResponse,
  ImagesResponse,
  NewsResponse,
  PatentsResponse,
  PlacesResponse,
  RankParams,
  RankResponse,
  ReviewsParams,
  ReviewsResponse,
  ScholarResponse,
  SearchParams,
  SearchResponse,
  ShoppingResponse,
  VideosResponse,
  WebpageParams,
  WebpageResponse,
} from "./types";

export const VERSION = "0.3.0";
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
  /** Give up after this many milliseconds. Default 600000 (10 minutes). */
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

type Method = "GET" | "POST";

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
  /** Google Maps search (places with coordinates). Accepts `ll` ("@lat,lng,14z"). */
  readonly maps = this.#vertical<SearchParams, PlacesResponse>("/v1/maps");
  /** Google local results. */
  readonly places = this.#vertical<SearchParams, PlacesResponse>("/v1/places");
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

  /** Position of `domain` for keyword `q` in the top `num` results (default 100). */
  rank(params: RankParams, options?: RequestOptions): Promise<RankResponse> {
    return this.request({ method: "POST", path: "/v1/rank", body: params, options });
  }

  /** Balance, limits and this month's usage for the key's account. */
  account(options?: RequestOptions): Promise<Account> {
    return this.request({ method: "GET", path: "/v1/account", options });
  }

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

  #vertical<P, R>(path: string): VerticalMethod<P, R> {
    return ((params: P, options?: RequestOptions) =>
      this.request({ method: "POST", path, body: params, options })) as VerticalMethod<P, R>;
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
