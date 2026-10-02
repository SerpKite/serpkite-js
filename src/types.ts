import type { components } from "./generated/openapi";

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
export type LensParams = Schemas["LensRequest"];
export type WebpageParams = Schemas["WebpageRequest"];
export type RankParams = Schemas["RankRequest"];

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
export type ReviewResult = Schemas["ReviewResult"];
export type ShoppingResult = Schemas["ShoppingResult"];
export type ScholarResult = Schemas["ScholarResult"];
export type PatentResult = Schemas["PatentResult"];
export type Suggestion = Schemas["Suggestion"];
export type LensResult = Schemas["LensResult"];
export type PageMetadata = Schemas["PageMetadata"];
export type RankMatch = Schemas["RankResponse"]["matches"][number];

// ── Responses ───────────────────────────────────────────────────────────

export type SearchResponse = Schemas["SearchResponse"];
export type ImagesResponse = Schemas["ImagesResponse"];
export type VideosResponse = Schemas["VideosResponse"];
export type NewsResponse = Schemas["NewsResponse"];
/** Returned by both `maps` and `places`. */
export type PlacesResponse = Schemas["PlacesResponse"];
export type MapsResponse = PlacesResponse;
export type ReviewsResponse = Schemas["ReviewsResponse"];
export type ShoppingResponse = Schemas["ShoppingResponse"];
export type ScholarResponse = Schemas["ScholarResponse"];
export type PatentsResponse = Schemas["PatentsResponse"];
export type AutocompleteResponse = Schemas["AutocompleteResponse"];
export type LensResponse = Schemas["LensResponse"];
export type WebpageResponse = Schemas["WebpageResponse"];
export type RankResponse = Schemas["RankResponse"];
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
  reviews: ReviewsParams;
  shopping: SearchParams;
  scholar: SearchParams;
  patents: SearchParams;
  autocomplete: SearchParams;
  lens: LensParams;
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
