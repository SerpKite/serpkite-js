/**
 * Every failure thrown by the SDK. API errors carry the fields of the
 * `{"error":{"code","message","request_id"}}` envelope; network failures and
 * timeouts use `status: 0` with code `connection_error` or `timeout`.
 */
export class SerpKiteError extends Error {
  /** HTTP status, or 0 when no response was received. */
  readonly status: number;
  /** Machine-readable code, e.g. `unauthorized`, `insufficient_credits`, `rate_limited`. */
  readonly code: string;
  /** `X-Request-Id` of the failed request, when the API returned one. */
  readonly requestId: string | undefined;
  /** Response headers, when the API responded. */
  readonly headers: Headers | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId?: string,
    headers?: Headers,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SerpKiteError";
    this.status = status;
    this.code = code;
    this.requestId = requestId || undefined;
    this.headers = headers;
  }
}

const fallbackCodes: Record<number, string> = {
  400: "invalid_request",
  401: "unauthorized",
  402: "insufficient_credits",
  403: "forbidden",
  404: "not_found",
  429: "rate_limited",
  // The API sends upstream failures as 503 with a JSON body; a bare 502/504
  // comes from a proxy (Cloudflare replaces origin 502/504 bodies).
  502: "upstream_error",
  503: "unavailable",
  504: "upstream_timeout",
};

/** Builds a SerpKiteError from a non-2xx response body (JSON envelope or anything else). */
export function errorFromResponse(status: number, headers: Headers, body: string): SerpKiteError {
  let code = fallbackCodes[status] ?? (status >= 500 ? "server_error" : "http_error");
  let message = body.trim().slice(0, 500) || `HTTP ${status}`;
  let requestId = headers.get("x-request-id") ?? undefined;
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: unknown; message?: unknown; request_id?: unknown };
    };
    const e = parsed?.error;
    if (e && typeof e === "object") {
      if (typeof e.code === "string" && e.code) code = e.code;
      if (typeof e.message === "string" && e.message) message = e.message;
      if (typeof e.request_id === "string" && e.request_id) requestId = e.request_id;
    }
  } catch {
    // Not JSON: keep the text body as the message.
  }
  return new SerpKiteError(status, code, message, requestId, headers);
}
