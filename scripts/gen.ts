// Regenerates src/generated/openapi.ts from the OpenAPI contract: the monorepo's
// backend/api/serp-api.yaml, or the copy the mirror bundles into the public
// serpkite-js repo (scripts/sdk-mirror.sh in the monorepo).
import { existsSync } from "node:fs";

const spec = ["../../backend/api/serp-api.yaml", "openapi/serp-api.yaml"].find((p) =>
  existsSync(p),
);
if (!spec) {
  console.error("gen: OpenAPI contract not found");
  process.exit(1);
}
const proc = Bun.spawnSync(
  [
    "bunx",
    "openapi-typescript",
    spec,
    "-o",
    "src/generated/openapi.ts",
    "--default-non-nullable",
    "false",
  ],
  { stdout: "inherit", stderr: "inherit" },
);
process.exit(proc.exitCode ?? 1);
