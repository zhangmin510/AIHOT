// Public reading DTOs only. This module must remain safe to import in a Worker.
import type { FeedItemSummary, SiteItemDetail, TimelineResponse } from "../../packages/contracts/src/site.ts";
import type { V1ItemPayload } from "../../packages/backend/src/publication/publish.ts";
import type { LeaderboardEvent } from "../../packages/contracts/src/radar.ts";
import type { PaperListItem } from "../../packages/contracts/src/evaluation.ts";
import { CONTENT_SCOPE } from "../../industry/scope.ts";

export interface SnapshotResponse {
  status: number;
  contentType: string;
  body: unknown;
  headers?: Record<string, string>;
}

export type SnapshotTimeline = TimelineResponse & { cardRefs?: number[] };

export interface PreviewSnapshot {
  schemaVersion: 1 | 2;
  contentHash: string;
  generatedAt: string;
  contentUpdatedAt: string | null;
  siteUrl: string;
  preview: { readOnly: true; capacityOnly?: true };
  capabilities: { leaderboard: boolean; reports: boolean };
  /** Scope proof contains public identifiers and projection revisions, never source quotations. */
  contentScope?: { key: string; version: string; admittedPublicationRevisions: Record<string, number> };
  /** Canonical path/query keys. Text bodies are preserved as text (RSS and Markdown). */
  responses: Record<string, SnapshotResponse>;
  /** Schema 2 aliases point directly to an identical stored response; chains are forbidden. */
  responseAliases?: Record<string, string>;
  corpus: {
    poolItems: FeedItemSummary[];
    items: Record<string, SiteItemDetail>;
    v1Items: V1ItemPayload[];
    /** Public ordering timestamp; selected entries use their reading-group anchor. */
    v1Timeline: Record<string, string>;
    search: Record<string, { direct: string; body: string }>;
    /** Complete cards for each channel/category/topic scope, before HTTP pagination. */
    timelineVariants: Record<string, SnapshotTimeline>;
    /** Identical public card sets share one stored variant; request filters remain in the HTTP response. */
    timelineAliases?: Record<string, string>;
    timelineCards: TimelineResponse["cards"];
    /** Schema 2 stores identical cards once, including scope-dependent group counts. */
    timelineCardIndex?: TimelineResponse["cards"];
    topicTags: Record<string, string[]>;
    /** Membership from the public pool reader, including entity topics whose tags are not displayed. */
    topicItemIds: Record<string, string[]>;
    research?: { events: LeaderboardEvent[]; papers: PaperListItem[] };
  };
}

export function snapshotResponse(snapshot: PreviewSnapshot, key: string): SnapshotResponse | undefined {
  const aliases = snapshot.responseAliases;
  if (aliases && Object.hasOwn(aliases, key)) {
    const target = aliases[key]!;
    if (snapshot.schemaVersion !== 2 || Object.hasOwn(snapshot.responses, key) || Object.hasOwn(aliases, target)) {
      throw new Error("Invalid snapshot response alias: chains, cycles and shadowed responses are forbidden");
    }
    if (!Object.hasOwn(snapshot.responses, target)) throw new Error("Invalid snapshot response alias: missing target");
    return snapshot.responses[target];
  }
  return Object.hasOwn(snapshot.responses, key) ? snapshot.responses[key] : undefined;
}

export function snapshotResponseEntries(snapshot: PreviewSnapshot): Array<[string, SnapshotResponse]> {
  return [...Object.entries(snapshot.responses), ...Object.keys(snapshot.responseAliases ?? {}).map(key => [key, snapshotResponse(snapshot, key)!] as [string, SnapshotResponse])];
}

/** Validate optional compact storage before serving requests; old schema 1 remains readable. */
export function validateSnapshot(snapshot: PreviewSnapshot): void {
  if (snapshot.schemaVersion !== 1 && snapshot.schemaVersion !== 2) throw new Error("Unsupported snapshot schema");
  for (const [key, target] of Object.entries(snapshot.responseAliases ?? {})) {
    if (typeof target !== "string") throw new Error("Invalid snapshot response alias target");
    snapshotResponse(snapshot, key);
  }
  for (const timeline of Object.values(snapshot.corpus.timelineVariants)) {
    if (timeline.cardRefs) snapshotTimelineCards(snapshot, timeline);
  }
}

/** An old broad-industry export cannot be served by a deployment requiring reviewed content. */
export function validateSnapshotScope(snapshot: PreviewSnapshot): void {
  if (!CONTENT_SCOPE.requireExplicitPass) return;
  const scope = snapshot.contentScope;
  if (!scope || scope.key !== CONTENT_SCOPE.key || scope.version !== CONTENT_SCOPE.version) throw new Error("Snapshot requires the current content scope review");
  const admitted = scope.admittedPublicationRevisions;
  if (!admitted || Object.keys(admitted).length !== Object.keys(snapshot.corpus.items).length) throw new Error("Snapshot scope membership differs from public details");
  const requireItem = (id: string) => {
    const item = snapshot.corpus.items[id];
    if (!item || !Object.hasOwn(admitted, id) || admitted[id] !== item.revision) throw new Error("Snapshot contains content without a current scope admission");
  };
  for (const id of Object.keys(admitted)) requireItem(id);
  for (const id of Object.keys(snapshot.corpus.items)) requireItem(id);
  for (const item of [...snapshot.corpus.poolItems, ...snapshot.corpus.v1Items]) requireItem(item.id);
  for (const id of [...Object.keys(snapshot.corpus.search), ...Object.keys(snapshot.corpus.v1Timeline), ...Object.values(snapshot.corpus.topicItemIds).flat()]) requireItem(id);
  for (const timeline of Object.values(snapshot.corpus.timelineVariants)) for (const card of snapshotTimelineCards(snapshot, timeline)) requireItem(card.item.id);
  for (const card of [...snapshot.corpus.timelineCards, ...(snapshot.corpus.timelineCardIndex ?? [])]) requireItem(card.item.id);
  const itemUrl = new RegExp(snapshot.siteUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/items/([^/?#\\s\"<>]+)", "g");
  const relativeItemUrl = /(?:^|[\s"'(=>])\/items\/([^/?#\s"'<>]+)/g;
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      for (const pattern of [itemUrl, relativeItemUrl]) for (const match of value.matchAll(pattern)) requireItem(decodeURIComponent(match[1]!));
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const entry of value) walk(entry); return; }
    const object = value as Record<string, unknown>;
    if (typeof object.itemId === "string") requireItem(object.itemId);
    if (typeof object.id === "string" && "selected" in object && "source" in object) requireItem(object.id);
    for (const entry of Object.values(object)) walk(entry);
  };
  walk(snapshot.corpus.timelineVariants);
  walk(snapshot.corpus.timelineCards);
  walk(snapshot.corpus.timelineCardIndex);
  walk(snapshot.corpus.research);
  for (const [path, response] of snapshotResponseEntries(snapshot)) {
    const item = /^\/api\/(?:site|v1)\/items\/([^/?]+)(?:\/|$)/.exec(path);
    if (item && response.status === 200) requireItem(decodeURIComponent(item[1]!));
    if (response.status === 200) walk(response.body);
  }
}

/** Export-time equality includes status, type, body and headers, preserving the entire HTTP response. */
export function compactSnapshotResponses(snapshot: PreviewSnapshot): void {
  const responses: PreviewSnapshot["responses"] = {};
  const aliases: Record<string, string> = {};
  const known = new Map<string, string>();
  for (const [key, response] of snapshotResponseEntries(snapshot)) {
    const signature = JSON.stringify(response);
    const target = known.get(signature);
    if (target !== undefined) aliases[key] = target;
    else { known.set(signature, key); responses[key] = response; }
  }
  snapshot.responses = responses;
  snapshot.responseAliases = aliases;
  snapshot.schemaVersion = 2;
}

/** Read both the original inline format and the shared-card format without expanding it at startup. */
export function snapshotTimelineCards(snapshot: PreviewSnapshot, timeline: SnapshotTimeline): TimelineResponse["cards"] {
  if (!timeline.cardRefs) return timeline.cards;
  const index = snapshot.corpus.timelineCardIndex;
  if (snapshot.schemaVersion !== 2 || !index) throw new Error("Invalid shared timeline index");
  return timeline.cardRefs.map(ref => {
    if (!Number.isSafeInteger(ref) || ref < 0 || !index[ref]) throw new Error("Invalid shared timeline card reference");
    return index[ref]!;
  });
}

/** Export-time compaction. Full JSON equality matters: the same key may have different scoped counts. */
export function compactTimelineCards(snapshot: PreviewSnapshot): void {
  const index: TimelineResponse["cards"] = [];
  const known = new Map<string, number>();
  for (const timeline of Object.values(snapshot.corpus.timelineVariants)) {
    const refs = snapshotTimelineCards(snapshot, timeline).map(card => {
      const signature = JSON.stringify(card);
      let ref = known.get(signature);
      if (ref === undefined) { ref = index.length; known.set(signature, ref); index.push(card); }
      return ref;
    });
    timeline.cards = [];
    timeline.cardRefs = refs;
  }
  snapshot.corpus.timelineCards = [];
  snapshot.corpus.timelineCardIndex = index;
  snapshot.schemaVersion = 2;
}

/** Shared by exporter and HTTP router: empty/default filters do not create different resources. */
export function canonicalKey(input: string | URL): string {
  const url = input instanceof URL ? new URL(input) : new URL(input, "https://snapshot.invalid");
  for (const [key, value] of [...url.searchParams]) {
    if (!value || (key === "channel" && value === "all") || (key === "page" && value === "1")
      || (key === "tab" && value === "time")) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  const query = url.searchParams.toString();
  return url.pathname + (query ? `?${query}` : "");
}
