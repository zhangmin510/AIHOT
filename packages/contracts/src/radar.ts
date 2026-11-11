export type LeaderboardEventType = "new_leader" | "top10_entry" | "new_board" | "methodology_change";
export type LeaderboardFreshnessStatus = "fresh" | "stale" | "unknown";

export interface LeaderboardSourcePolicy {
  sourceKey: string;
  publicRows: boolean;
  publicDerived: boolean;
  publicEvents: boolean;
  licenseName: string;
  evidenceUrl: string | null;
  attribution: string;
  reviewedAt: string | null;
  expectedIntervalHours: number;
  staleAfterHours: number;
  maxPublishedAgeHours: number | null;
}

export interface LeaderboardSourceFreshness {
  status: LeaderboardFreshnessStatus;
  fetchStatus: LeaderboardFreshnessStatus;
  dataStatus: LeaderboardFreshnessStatus;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  upstreamPublishedAt: string | null;
  checkedAt: string;
  lastAttemptOk: boolean | null;
  /** Fetch age uses successful checks; data age uses only the upstream's publication date. */
  expectedIntervalHours: number;
  staleAfterHours: number;
  maxPublishedAgeHours: number | null;
}

export interface LeaderboardSourceState {
  sourceKey: string;
  sourceName: string;
  policy: LeaderboardSourcePolicy;
  freshness: LeaderboardSourceFreshness;
}

export interface LeaderboardEventEvidence {
  snapshotId: string;
  contentHash: string;
  protocol: string;
  publishedAt: string | null;
  url: string;
  rank: number | null;
  score: number | null;
  lowerBound: number | null;
  upperBound: number | null;
  sampleSize: number | null;
  sourceModelName: string | null;
  configurationKey: string | null;
  configurationLabel: string | null;
}

export interface LeaderboardEvent {
  id: string;
  version: string;
  type: LeaderboardEventType;
  sourceKey: string;
  sourceName: string;
  sourceUrl: string;
  metricKey: string | null;
  configurationKey: string | null;
  model: { slug: string; name: string } | null;
  protocol: string;
  previousProtocol: string;
  state: "comparable" | "observation";
  title: string;
  summary: string;
  url: string;
  occurredAt: string;
  detectedAt: string;
  timeBasis: "upstream_publication" | "first_observed";
  oldEvidence: LeaderboardEventEvidence;
  newEvidence: LeaderboardEventEvidence;
  attribution: string;
}

export interface LeaderboardEventPage {
  items: LeaderboardEvent[];
  nextCursor: string | null;
}

export interface LeaderboardModelHistory {
  model: { slug: string; name: string };
  series: Array<{
    sourceKey: string;
    sourceName: string;
    metricKey: string;
    protocol: string;
    configurationKey: string;
    sourceUrl?: string | null;
    attribution?: string;
    licenseName?: string;
    evidenceUrl?: string | null;
    points: Array<{
      at: string | null;
      score: number;
      rank: number | null;
      lowerBound: number | null;
      upperBound: number | null;
      sampleSize: number | null;
      snapshotId: string;
      configurationKey: string;
    }>;
  }>;
}

/** A directory of actual public source records, independent of composite rank eligibility. */
export interface LeaderboardModelHistoryList {
  items: Array<{
    slug: string;
    name: string;
    sourceCount: number;
    pointCount: number;
  }>;
}
