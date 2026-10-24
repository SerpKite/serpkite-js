import type { components, operations } from "./generated/openapi";

type Schemas = components["schemas"];

// ── Search engines ──────────────────────────────────────────────────────

/** A search provider that can answer a request. `meta.engine` names the one that did. */
export type Provider = Schemas["Provider"];

/**
 * Which search providers may answer (`engine` param):
 * - `"google"` (default): Google only.
 * - `"auto"`: fall back to other enabled providers when Google is blocked or times out.
 * - `"consensus"` (`search` only): several independent indexes in parallel, merged by URL and
 *   ranked by agreement; each result lists its `sources`, `meta.engine` is `"consensus"`, and
 *   it costs the sum of one page per provider that returned results.
 * - a single provider (`"brave"`) or a list (`["google", "brave"]`): only those, in order.
 *
 * `auto` and `consensus` can't be combined with other names. Unknown names, or a provider
 * that doesn't serve the endpoint, are a 400 `invalid_request`. Plain strings stay accepted
 * so a provider added to the API before this SDK is updated still type-checks.
 */
export type Engine = "google" | "auto" | "consensus" | Provider | Provider[] | (string & {});

/** One provider attempt in `meta.route`. */
export type RouteStep = Schemas["RouteStep"];
export type RouteOutcome = RouteStep["outcome"];

// ── Requests ────────────────────────────────────────────────────────────

/** Parameters for search, images, videos, news, maps, places, shopping, scholar, patents and autocomplete. */
export type SearchParams = Omit<Schemas["SearchRequest"], "engine"> & {
  /** Search providers allowed to answer. Default `"google"`. See {@link Engine}. */
  engine?: Engine;
};
export type ReviewsParams = Schemas["ReviewsRequest"];
/**
 * Parameters of `place`: one of `place_id`, `cid` or `fid` (Google; place_id wins, then fid,
 * then cid), or `oid` (a Yandex Maps organisation id, which implies `engine: "yandex"`).
 */
export type PlaceParams = Omit<Schemas["PlaceRequest"], "engine"> & {
  /** Search providers allowed to answer. Default `"google"`. See {@link Engine}. */
  engine?: Engine;
};
export type WebpageParams = Schemas["WebpageRequest"];
export type RankParams = Schemas["RankRequest"];
export type MapParams = Schemas["MapRequest"];
export type ExtractParams = Schemas["ExtractRequest"];

/** `format` values accepted by the verticals. */
export type Format = NonNullable<SearchParams["format"]>;

// ── Shared pieces ───────────────────────────────────────────────────────

export type Meta = Schemas["Meta"];
export type RequestEcho = Schemas["RequestEcho"];
export type ErrorBody = Schemas["Error"];

// ── Result items ────────────────────────────────────────────────────────

export type OrganicResult = Schemas["OrganicResult"];
export type Sitelink = Schemas["Sitelink"];
export type AnswerBox = Schemas["AnswerBox"];
export type KnowledgeGraph = Schemas["KnowledgeGraph"];
export type PeopleAlsoAsk = Schemas["PeopleAlsoAsk"];
export type RelatedSearch = Schemas["RelatedSearch"];
export type ImageResult = Schemas["ImageResult"];
export type VideoResult = Schemas["VideoResult"];
export type NewsResult = Schemas["NewsResult"];
export type PlaceResult = Schemas["PlaceResult"];
/**
 * Opening hours per weekday (`monday` … `sunday`) as local 24-hour `HH:MM` intervals: a closed
 * day is `[]`, a day open 24 hours `[{ open: "00:00", close: "24:00" }]`. Days Google doesn't
 * list are absent.
 */
export type WeeklyHours = Schemas["WeeklyHours"];
/** One opening interval; `next_day` when it closes after midnight. */
export type HoursInterval = Schemas["HoursInterval"];
/** A photo of a place (`place`; up to 10). */
export type PlacePhoto = Schemas["PlacePhoto"];
export type ReviewResult = Schemas["ReviewResult"];
export type ShoppingResult = Schemas["ShoppingResult"];
export type ScholarResult = Schemas["ScholarResult"];
export type PatentResult = Schemas["PatentResult"];
export type Suggestion = Schemas["Suggestion"];
export type PageMetadata = Schemas["PageMetadata"];
/** An outbound link of a page (`webpage` with `include_links`). */
export type PageLink = Schemas["PageLink"];
/** A query-ranked passage of a page (`search` with `highlights`). */
export type Highlight = Schemas["Highlight"];
/** A domain filter: a list or a comma-separated string (`include_domains`…). */
export type DomainList = Schemas["DomainList"];
export type MapURL = Schemas["MapURL"];
export type ExtractResult = Schemas["ExtractResult"];
export type ExtractFailure = Schemas["ExtractFailure"];
export type RankMatch = Schemas["RankResponse"]["matches"][number];
/** A source an AI answer or report cites with an `[index]` marker. */
export type Citation = Schemas["Citation"];
/**
 * `include_answer: true` on `search` / `news`: a cited answer over the response's results
 * (`text` with `[n]` markers). Absent when the model failed (refunded, see `meta.warnings`).
 */
export type SearchAnswer = Schemas["SearchAnswer"];
/** `meta.llm`: the model behind an AI response and the tokens it used. */
export type LLMUsage = Schemas["LLMUsage"];

// ── Responses ───────────────────────────────────────────────────────────

export type SearchResponse = Schemas["SearchResponse"];
export type ImagesResponse = Schemas["ImagesResponse"];
export type VideosResponse = Schemas["VideosResponse"];
export type NewsResponse = Schemas["NewsResponse"];
/** Returned by `maps`, `places` and `place`. */
export type PlacesResponse = Schemas["PlacesResponse"];
export type MapsResponse = PlacesResponse;
export type ReviewsResponse = Schemas["ReviewsResponse"];
export type ShoppingResponse = Schemas["ShoppingResponse"];
export type ScholarResponse = Schemas["ScholarResponse"];
export type PatentsResponse = Schemas["PatentsResponse"];
export type AutocompleteResponse = Schemas["AutocompleteResponse"];
export type WebpageResponse = Schemas["WebpageResponse"];
export type RankResponse = Schemas["RankResponse"];
export type MapResponse = Schemas["MapResponse"];
export type ExtractResponse = Schemas["ExtractResponse"];
export type Account = Schemas["Account"];
export type Status = Schemas["Status"];

/**
 * `format: "compact"` returns a token-lean object: short snippets, no
 * thumbnails or positions. Its keys depend on the vertical.
 */
export interface CompactResponse {
  results?: Record<string, unknown>[];
  meta: Meta;
  [key: string]: unknown;
}

// ── Answer ──────────────────────────────────────────────────────────────

/** Body of `POST /v1/answer` (`stream` is set by `answerStream`). */
export type AnswerParams = Omit<Schemas["AnswerRequest"], "engine" | "stream"> & {
  /** Search providers allowed to answer. Default `"google"`. See {@link Engine}. */
  engine?: Engine;
};
export type AnswerResponse = Schemas["AnswerResponse"];
/** A result the answer may cite, numbered as in the prompt (`[index]`). */
export type AnswerSource = Schemas["AnswerSource"];
/** `meta` of an answer: `credits` splits `credits_used` into search and model; `llm` names the model. */
export type AnswerMeta = Schemas["AnswerMeta"];
export type AnswerStreamResults = Schemas["AnswerStreamResults"];
export type AnswerStreamDelta = Schemas["AnswerStreamDelta"];
export type AnswerStreamDone = Schemas["AnswerStreamDone"];

/**
 * One Server-Sent Event of `answerStream`: `results` first, then `delta` pieces of text,
 * then `done` with the final answer, citations and meta. A server `error` event is thrown
 * as a `SerpKiteError` instead of being yielded.
 */
export type AnswerStreamEvent =
  | { event: "results"; data: AnswerStreamResults }
  | { event: "delta"; data: AnswerStreamDelta }
  | { event: "done"; data: AnswerStreamDone };

// ── Batches ─────────────────────────────────────────────────────────────

export type Batch = Schemas["Batch"];
export type BatchStatus = Batch["status"];
export type BatchEndpoint = Schemas["BatchCreateRequest"]["endpoint"];

/** An entry of `batches.create` that could not be queued. */
export type BatchCreateError = ErrorBody & { id?: never; status?: never };
/** One entry per submitted request, in order: a queued job or an error. */
export type BatchCreateEntry = Batch | BatchCreateError;

export interface BatchCreateResponse {
  batches: BatchCreateEntry[];
}

type BatchRequestMap = {
  search: SearchParams;
  images: SearchParams;
  videos: SearchParams;
  news: SearchParams;
  maps: SearchParams;
  places: SearchParams;
  place: PlaceParams;
  reviews: ReviewsParams;
  shopping: SearchParams;
  scholar: SearchParams;
  patents: SearchParams;
  autocomplete: SearchParams;
  webpage: WebpageParams;
};

/** Body of `POST /v1/batches`. `requests` takes the same fields as the realtime endpoint. */
export type BatchCreateParams = {
  [E in BatchEndpoint]: {
    endpoint: E;
    /** 1-100 request bodies. */
    requests: BatchRequestMap[E][];
    /** Receives each job's result (signed with X-SerpKite-Signature). Defaults to the account webhook. */
    webhook_url?: string;
  };
}[BatchEndpoint];

// ── Async tasks: crawl ──────────────────────────────────────────────────

export type TaskStatus = Schemas["TaskStatus"];
/** The `202` body of `crawl` and `research`. */
export type TaskCreated = Schemas["TaskCreated"];
export type TaskCancelResponse = Schemas["TaskCancelResponse"];
export type TaskError = Schemas["TaskError"];

/**
 * Body of `POST /v1/crawl`: `limit` up to 1000 pages, `max_depth` up to 10, `sitemap`
 * (`include` | `only` | `skip`), `query` for a best-first crawl, path filters and
 * `ignore_query_parameters`.
 */
export type CrawlParams = Schemas["CrawlRequest"];
/** `sitemap` values of `crawl`. */
export type CrawlSitemapMode = NonNullable<CrawlParams["sitemap"]>;
export type CrawlTask = Schemas["CrawlTask"];
export type CrawlResult = Schemas["CrawlResult"];
/** `result.stats` of a crawl: counts, robots.txt outcome and why it `stopped`. */
export type CrawlStats = CrawlResult["stats"];
/** Why a crawl ended (`result.stats.stopped`). */
export type CrawlStopReason = NonNullable<CrawlStats["stopped"]>;
export type CrawlPage = Schemas["CrawlPage"];

// ── Async tasks: research ───────────────────────────────────────────────

/**
 * Body of `POST /v1/research`: `input` (the task in plain words), `effort` (`lite`, `standard`
 * (default) or `deep`; flat prices at https://serpkite.com/pricing), optional `output_schema`,
 * locale, domain filters and `webhook_url` (receives `research.completed`).
 */
export type ResearchParams = Schemas["ResearchRequest"];
export type ResearchEffort = NonNullable<ResearchParams["effort"]>;
export type ResearchResult = Schemas["ResearchResult"];
export type ResearchSource = Schemas["ResearchSource"];
/**
 * A research task. `result` is set once the report is written (`status: "completed"`); a
 * failed or canceled task may carry a partial result with only `queries`.
 */
export type ResearchTask = Omit<Schemas["ResearchTask"], "result"> & {
  result?: ResearchResult | null;
};
/** `progress` of a running research task (round, queries, sources, current step). */
export type ResearchProgress = NonNullable<Schemas["ResearchTask"]["progress"]>;

// ── Monitors ────────────────────────────────────────────────────────────

/**
 * Body of `POST /v1/monitors`. `search` and `news` monitors need `q`; `webpage` monitors need
 * `url` (and take only `country` besides) and report the page when its content changes.
 * `metadata` is your own JSON object (at most 2 KB), echoed on the monitor and its webhooks.
 * `webhook_url` is optional: without one, new results are read from the run history
 * (`monitors.runs`). `active: false` creates the monitor paused.
 */
export type MonitorCreateParams = Omit<Schemas["MonitorCreateRequest"], "engine"> & {
  engine?: Engine;
};
/**
 * Body of `PATCH /v1/monitors/{id}`: only the fields sent change. Search fields (or `url`) are
 * merged into the saved request (a changed one reports every result as new on the next run);
 * switching `endpoint` between a search and `webpage` drops the other kind's fields.
 * `metadata` replaces the stored object (`null` clears it); `webhook_url: ""` removes the
 * webhook; `active: true` resumes a paused monitor.
 */
export type MonitorUpdateParams = Omit<Schemas["MonitorUpdateRequest"], "engine"> & {
  engine?: Engine;
};
export type Monitor = Schemas["Monitor"];
/** What a monitor watches: a `search`, `news` search, or a `webpage` for content changes. */
export type MonitorEndpoint = Monitor["endpoint"];
/** Your own JSON object on a monitor (at most 2 KB), echoed in `monitor.results`. */
export type MonitorMetadata = NonNullable<Monitor["metadata"]>;
/**
 * A result item of a `webpage` monitor (in run `results` and `monitor.results` `new_results`):
 * the page when first seen (`change: "new"`) or when its content changed (`"changed"`).
 */
export type MonitorPageChange = Schemas["MonitorPageChange"];
/** `last_status` of a monitor; `"paused"` after 10 failed runs in a row. */
export type MonitorStatus = NonNullable<Monitor["last_status"]>;
export type MonitorList = Schemas["MonitorList"];
export type MonitorSearch = Schemas["MonitorSearch"];
/**
 * One run of a monitor. `results` holds the new results (null when none, or after 24 hours):
 * `OrganicResult`-shaped for search, `NewsResult` for news, {@link MonitorPageChange} for webpage.
 */
export type MonitorRun = Schemas["MonitorRun"];
/** A page of runs, newest first. Pass `next_before` as `before` for the next page. */
export type MonitorRunList = Schemas["MonitorRunList"];
/** Query of `GET /v1/monitors/{id}/runs`. */
export type MonitorRunsParams = NonNullable<operations["listMonitorRuns"]["parameters"]["query"]>;

// ── Webhooks ────────────────────────────────────────────────────────────

/** Body of `batch.completed`: the finished job, without `poll_url`, `webhook_url` and `webhook_status`. */
export type BatchCompletedEvent = Omit<Batch, "poll_url" | "webhook_url" | "webhook_status"> & {
  event: "batch.completed";
};
/**
 * Body of `crawl.completed` and `research.completed` (`kind` says which; `result` is a
 * `CrawlResult` or `ResearchResult`). When the result is over 4 MB, `result` is null and
 * `result_omitted` is true: fetch the task from `poll_url`.
 */
export type TaskCompletedEvent = Schemas["TaskCompletedEvent"];
/** Body of `research.completed`: a {@link TaskCompletedEvent} whose `result` is a `ResearchResult`. */
export type ResearchCompletedEvent = Omit<TaskCompletedEvent, "event" | "kind" | "result"> & {
  event: "research.completed";
  kind: "research";
  result?: ResearchResult | null;
};
/**
 * Body of `monitor.results`. `run_id` is also the `X-SerpKite-Delivery` header (dedupe retries
 * on it). Carries the monitor's `metadata`, and `url` for webpage monitors (whose `new_results`
 * are {@link MonitorPageChange} items and `q` is empty).
 */
export type MonitorResultsEvent = Schemas["MonitorResultsEvent"];

/** `X-SerpKite-Event` values. Plain strings stay accepted for events added later. */
export type WebhookEventType =
  | "batch.completed"
  | "crawl.completed"
  | "research.completed"
  | "monitor.results"
  | (string & {});

/** A verified webhook delivery, from `parseWebhook`. */
export type WebhookEvent =
  | { type: "batch.completed"; deliveryId: string | undefined; data: BatchCompletedEvent }
  | { type: "crawl.completed"; deliveryId: string | undefined; data: TaskCompletedEvent }
  | { type: "research.completed"; deliveryId: string | undefined; data: ResearchCompletedEvent }
  | { type: "monitor.results"; deliveryId: string | undefined; data: MonitorResultsEvent };
