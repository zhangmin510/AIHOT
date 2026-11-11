import type { LeaderboardSourcePolicy, LeaderboardSourceFreshness, LeaderboardSourceState } from "@aihot/contracts/radar";
import { sql, type Db } from "../db.ts";
import { SOURCE_GROUPS } from "./registry.ts";
import { sha256, stableJson } from "../lib/ids.ts";

interface PolicyRow {
  source_key: string; public_rows: boolean; public_derived: boolean; public_events: boolean;
  license_name: string; evidence_url: string | null; attribution: string; reviewed_at: Date | null;
  expected_interval_hours: number; stale_after_hours: number; max_published_age_hours: number | null;
}

const ARENA = new Set(["arena-text", "arena-creative-writing", "arena-webdev", "arena-vision"]);
const EPOCH = new Set(["epoch-frontiermath", "epoch-frontiermath-tier4", "epoch-chess", "epoch-mystery", "epoch-simpleqa", "epoch-gpqa", "epoch-mirrorcode", "epoch-ebr"]);

/** Only the explicitly documented public data licenses are defaults; API access is not permission. */
export function defaultSourcePolicy(sourceKey: string): LeaderboardSourcePolicy {
  const open = ARENA.has(sourceKey) || EPOCH.has(sourceKey);
  return {
    sourceKey, publicRows: open, publicDerived: open, publicEvents: open,
    licenseName: open ? "CC BY 4.0" : "公开使用范围待确认",
    evidenceUrl: ARENA.has(sourceKey) ? "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset" : EPOCH.has(sourceKey) ? "https://epoch.ai/benchmarks/about" : sourceKey.startsWith("artificial-analysis") ? "https://artificialanalysiscdn.com/legal/ProDataPlatformTerms.pdf" : null,
    attribution: ARENA.has(sourceKey) ? "Arena · leaderboard-dataset · CC BY 4.0；本站整理变化并保留原始来源。" : EPOCH.has(sourceKey) ? "Epoch AI · AI Benchmarking Hub · CC BY 4.0；本站整理变化并保留原始来源。" : "",
    reviewedAt: open ? "2026-11-04T00:00:00.000Z" : null,
    expectedIntervalHours: 6, staleAfterHours: 24, maxPublishedAgeHours: null,
  };
}

function fromRow(row: PolicyRow): LeaderboardSourcePolicy {
  return { sourceKey: row.source_key, publicRows: row.public_rows, publicDerived: row.public_derived, publicEvents: row.public_events,
    licenseName: row.license_name, evidenceUrl: row.evidence_url, attribution: row.attribution, reviewedAt: row.reviewed_at?.toISOString() ?? null,
    expectedIntervalHours: row.expected_interval_hours, staleAfterHours: row.stale_after_hours, maxPublishedAgeHours: row.max_published_age_hours };
}

export async function sourcePolicies(keys: string[], db: Db = sql): Promise<Map<string, LeaderboardSourcePolicy>> {
  const unique = [...new Set(keys)];
  const policies = new Map(unique.map((key) => [key, defaultSourcePolicy(key)]));
  if (!unique.length) return policies;
  for (const row of await db<PolicyRow[]>`SELECT * FROM lb_source_policies WHERE source_key = ANY(${unique})`) policies.set(row.source_key, fromRow(row));
  return policies;
}

export function sourcePolicyVersion(policies: Map<string, LeaderboardSourcePolicy>): string {
  return sha256(stableJson([...policies.values()].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))));
}

export async function upsertSourcePolicy(policy: LeaderboardSourcePolicy, updatedBy: string, reason: string | null = null, requestId: string | null = null): Promise<LeaderboardSourcePolicy> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(policy.sourceKey) || !updatedBy.trim() || !policy.licenseName.trim()) throw new Error("invalid leaderboard source policy");
  if ([policy.publicRows,policy.publicDerived,policy.publicEvents].some((permission)=>typeof permission!=="boolean")) throw new Error("source permissions must be booleans");
  for (const value of [policy.expectedIntervalHours, policy.staleAfterHours, ...(policy.maxPublishedAgeHours == null ? [] : [policy.maxPublishedAgeHours])]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("source cadence must use positive integer hours");
  }
  if (policy.staleAfterHours < policy.expectedIntervalHours) throw new Error("stale interval cannot precede expected checks");
  const granted = policy.publicRows || policy.publicDerived || policy.publicEvents;
  const url = policy.evidenceUrl ? new URL(policy.evidenceUrl) : null;
  if (url && (!["https:", "http:"].includes(url.protocol) || url.username || url.password)) throw new Error("policy evidence must be a public HTTP URL without credentials");
  if (granted && (!url || !policy.reviewedAt || !Number.isFinite(Date.parse(policy.reviewedAt)) || !policy.attribution.trim())) throw new Error("public permission requires reviewed license evidence and attribution");
  await sql.begin(async(tx)=>{
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`lb_policy:${policy.sourceKey}`}))`;
    const before=(await sourcePolicies([policy.sourceKey],tx)).get(policy.sourceKey)!;
    await tx`INSERT INTO lb_source_policies (source_key, public_rows, public_derived, public_events, license_name, evidence_url, attribution, reviewed_at, expected_interval_hours, stale_after_hours, max_published_age_hours, updated_by)
    VALUES (${policy.sourceKey}, ${policy.publicRows}, ${policy.publicDerived}, ${policy.publicEvents}, ${policy.licenseName}, ${policy.evidenceUrl}, ${policy.attribution}, ${policy.reviewedAt}, ${policy.expectedIntervalHours}, ${policy.staleAfterHours}, ${policy.maxPublishedAgeHours}, ${updatedBy})
    ON CONFLICT (source_key) DO UPDATE SET public_rows=EXCLUDED.public_rows, public_derived=EXCLUDED.public_derived, public_events=EXCLUDED.public_events, license_name=EXCLUDED.license_name, evidence_url=EXCLUDED.evidence_url, attribution=EXCLUDED.attribution, reviewed_at=EXCLUDED.reviewed_at, expected_interval_hours=EXCLUDED.expected_interval_hours, stale_after_hours=EXCLUDED.stale_after_hours, max_published_age_hours=EXCLUDED.max_published_age_hours, updated_by=EXCLUDED.updated_by, updated_at=clock_timestamp()`;
    await tx`INSERT INTO audit_log(actor,action,subject,reason,before,after,request_id)
      VALUES (${updatedBy},'leaderboard.source-policy.update',${`leaderboard-source:${policy.sourceKey}`},${reason},${tx.json(before as never)},${tx.json(policy as never)},${requestId})`;
  });
  return (await sourcePolicies([policy.sourceKey])).get(policy.sourceKey)!;
}

export async function recordSourceCheck(sourceKey: string, ok: boolean, upstreamPublishedAt: string | null = null, error: string | null = null, db: Db = sql): Promise<void> {
  await db`INSERT INTO lb_source_checks (source_key, last_attempt_at, last_success_at, upstream_published_at, last_attempt_ok, error)
    VALUES (${sourceKey}, clock_timestamp(), ${ok ? db`clock_timestamp()` : null}, ${upstreamPublishedAt}, ${ok}, ${error?.slice(0, 300) ?? null})
    ON CONFLICT (source_key) DO UPDATE SET last_attempt_at=EXCLUDED.last_attempt_at, last_attempt_ok=EXCLUDED.last_attempt_ok, error=EXCLUDED.error,
      last_success_at=CASE WHEN EXCLUDED.last_attempt_ok THEN EXCLUDED.last_success_at ELSE lb_source_checks.last_success_at END,
      upstream_published_at=CASE WHEN EXCLUDED.last_attempt_ok THEN EXCLUDED.upstream_published_at ELSE lb_source_checks.upstream_published_at END`;
}

export function sourceFreshness(policy: LeaderboardSourcePolicy, value: { lastAttemptAt: string | null; lastSuccessAt: string | null; upstreamPublishedAt: string | null; lastAttemptOk: boolean | null }, now = new Date()): LeaderboardSourceFreshness {
  const age = (date: string | null, hours: number | null) => !date || hours == null || !Number.isFinite(Date.parse(date)) || Date.parse(date) > now.getTime() ? "unknown" as const : now.getTime() - Date.parse(date) > hours * 3600_000 ? "stale" as const : "fresh" as const;
  const fetchStatus = age(value.lastSuccessAt, policy.staleAfterHours);
  const dataStatus = age(value.upstreamPublishedAt, policy.maxPublishedAgeHours);
  return { ...value, fetchStatus, dataStatus, status: fetchStatus === "stale" || dataStatus === "stale" ? "stale" : fetchStatus === "unknown" || dataStatus === "unknown" ? "unknown" : "fresh",
    checkedAt: now.toISOString(), expectedIntervalHours: policy.expectedIntervalHours, staleAfterHours: policy.staleAfterHours, maxPublishedAgeHours: policy.maxPublishedAgeHours };
}

export async function loadSourceStates(keys?: string[], now = new Date()): Promise<LeaderboardSourceState[]> {
  const registered = new Map(SOURCE_GROUPS.flatMap((group) => group.sources).map((source) => [source.key, source.name]));
  const selected = keys ?? [...registered.keys()];
  const policies = await sourcePolicies(selected);
  const checks = await sql<{ source_key: string; last_attempt_at: Date; last_success_at: Date | null; upstream_published_at: Date | null; last_attempt_ok: boolean }[]>`
    SELECT source_key, last_attempt_at, last_success_at, upstream_published_at, last_attempt_ok FROM lb_source_checks WHERE source_key = ANY(${selected})`;
  const byKey = new Map(checks.map((check) => [check.source_key, check]));
  // Older installations have snapshots but no check ledger; infer a successful observation once,
  // never replace the upstream date with a local fetch time.
  const snapshots = await sql<{ source_key: string; published_at: Date | null; fetched_at: Date; metadata: Record<string, unknown> }[]>`
    SELECT DISTINCT ON (source_key) source_key, published_at, fetched_at, metadata FROM lb_snapshots WHERE source_key = ANY(${selected}) ORDER BY source_key, fetched_at DESC`;
  const bySnapshot = new Map(snapshots.map((snapshot) => [snapshot.source_key, snapshot]));
  return selected.map((key) => {
    const check = byKey.get(key), snapshot = bySnapshot.get(key), policy = policies.get(key)!;
    const legacySuccess = typeof snapshot?.metadata.lastSeenAt === "string" ? snapshot.metadata.lastSeenAt : snapshot?.fetched_at.toISOString() ?? null;
    return { sourceKey: key, sourceName: registered.get(key) ?? key, policy,
      freshness: sourceFreshness(policy, { lastAttemptAt: check?.last_attempt_at.toISOString() ?? legacySuccess, lastSuccessAt: check?.last_success_at?.toISOString() ?? legacySuccess,
        upstreamPublishedAt: check ? check.upstream_published_at?.toISOString() ?? null : snapshot?.published_at?.toISOString() ?? null, lastAttemptOk: check?.last_attempt_ok ?? (snapshot ? true : null) }, now) };
  });
}
