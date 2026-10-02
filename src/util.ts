import type { BatchCreateEntry, BatchCreateError } from "./types";

/** True when a `batches.create` entry was rejected instead of queued. */
export function isBatchError(entry: BatchCreateEntry): entry is BatchCreateError {
  return !("id" in entry && typeof entry.id === "string") && "error" in entry && !!entry.error;
}
