// Deterministic boundary sampling for cross-runtime acceptance. Never changes the source values.
export type SampleGroup = { group: string; total: number; sampled: number };
export function publicTimestamp(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const row = value as Record<string, unknown>;
  for (const key of ["publishedAt", "timelineAt", "latestAt", "updatedAt", "lastSeenAt", "firstSeenAt", "occurredAt", "detectedAt", "firstReportAt", "digestUpdatedAt", "generatedAt", "checkedAt", "upstreamAt", "syncedAt", "releasedAt", "at"]) {
    if (typeof row[key] === "string" && /^\d{4}-\d{2}-\d{2}/.test(row[key] as string)) return row[key] as string;
  }
  for (const key of ["story", "item", "model", "run"]) if (row[key] && typeof row[key] === "object") {
    const time = publicTimestamp(row[key]); if (time) return time;
  }
  // Collection and history responses use their newest recorded public entry; unknown stays unknown.
  for (const key of ["reports", "items", "developments", "series", "points", "versions"]) if (Array.isArray(row[key])) {
    const times = row[key].map(publicTimestamp).filter(Boolean).sort();
    if (times.length) return times.at(-1)!;
  }
  return "";
}

export function representativeSample<T>(values: readonly T[], options: {
  key: (value: T) => string;
  group: (value: T) => string;
  size: (value: T) => number;
  time: (value: T) => string;
}): { values: T[]; groups: SampleGroup[] } {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const group = options.group(value);
    const rows = groups.get(group) ?? [];
    rows.push(value); groups.set(group, rows);
  }
  const selected = new Set<string>();
  const counts: SampleGroup[] = [];
  for (const [group, rows] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const picked = new Set<string>();
    const choose = (value: T) => { const key = options.key(value); picked.add(key); selected.add(key); };
    if (rows.length <= 4) rows.forEach(choose);
    else {
      const byKey = (a: T, b: T) => options.key(a).localeCompare(options.key(b));
      const bySize = [...rows].sort((a, b) => options.size(a) - options.size(b) || byKey(a, b));
      const byTime = [...rows].sort((a, b) => options.time(a).localeCompare(options.time(b)) || byKey(a, b));
      choose(bySize[0]!); choose(bySize.at(-1)!); choose(byTime[0]!); choose(byTime.at(-1)!);
    }
    counts.push({ group, total: rows.length, sampled: picked.size });
  }
  return { values: values.filter(value => selected.has(options.key(value))), groups: counts };
}

// Keep route families, report periods, board categories and distinct filter shapes separate.
export function responseFamily(path: string): string {
  const url = new URL(path, "https://preview.invalid");
  const route = url.pathname
    .replace(/(\/api\/(?:site|v1)\/(?:items|stories|groups|topics|papers|leaderboard-events)|\/items)\/[^/]+/, "$1/:id")
    .replace(/(\/api\/(?:site|v1)\/leaderboard-model-history)\/[^/]+/, "$1/:slug")
    .replace(/(\/api\/site\/leaderboard\/(?:models|sources))\/[^/]+/, "$1/:id")
    .replace(/(\/api\/site\/reports\/(?:daily|weekly|monthly)\/(?:navigation\/)?)[\dW-]+$/, "$1:period")
    .replace(/(\/api\/v1\/dailies\/)\d{4}-\d{2}-\d{2}$/, "$1:date");
  return `${route}?${[...url.searchParams.keys()].sort().join(",")}`;
}
