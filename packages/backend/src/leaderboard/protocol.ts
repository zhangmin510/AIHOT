import { stableJson } from "../lib/ids.ts";

/** Revisions identify evidence; only evaluation conditions identify comparable protocols. */
export function protocolOf(sourceKey: string, metadata: Record<string, unknown>): string {
  const fields = ["methodologyVersion", "protocolVersion", "intelligenceIndexVersion", "editionId", "datasetVersion", "benchmarkVersion", "arenaConfig", "arenaCategory", "datasetRef", "harness", "scoringField", "officialBoard", "comparisonSubject"];
  if (sourceKey.startsWith("livebench")) fields.push("release");
  const protocol = Object.fromEntries(fields.filter((key) => metadata[key] != null && metadata[key] !== "").map((key) => [key, metadata[key]]));
  return `${sourceKey}:protocol-v1:${Object.keys(protocol).length ? stableJson(protocol) : "unknown"}`;
}

export function hasKnownProtocol(metadata: Record<string, unknown>): boolean {
  return ["methodologyVersion", "protocolVersion", "intelligenceIndexVersion", "editionId", "benchmarkVersion", "arenaConfig"].some((key) => metadata[key] != null && metadata[key] !== "");
}
