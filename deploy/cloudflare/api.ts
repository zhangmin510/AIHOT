// Request/Response adapter over public DTOs. No database, filesystem, environment or outbound fetch.
import { PUBLIC_API_CORS, V1_CACHE_CONTROL, RSS_CACHE_CONTROL } from "../../packages/contracts/src/http-policy.ts";
import { ARTICLE_ID_PATTERN, isCategoryKey, isChannelKey } from "../../packages/contracts/src/taxonomy.ts";
import { beijingDate, isValidDate } from "../../packages/contracts/src/time.ts";
import type { TimelineFilters, PoolResponse, TimelineResponse, GroupReportsResponse, DevelopmentsResponse } from "../../packages/contracts/src/site.ts";
import { canonicalKey, snapshotResponse, snapshotTimelineCards, validateSnapshot, validateSnapshotScope, type PreviewSnapshot, type SnapshotResponse } from "./snapshot.ts";
import { createSnapshotMcp } from "./mcp.ts";
import { SITE } from "../../industry/site.ts";
import { isReportKindEnabled } from "../../industry/features.ts";
import { isReportKey } from "../../packages/contracts/src/reports.ts";

class PublicError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
type Cursor = { version: string; kind: string; scope: string; offset: number; fields?: "default" | "minimal" };
export type ItemQuery = { mode: "selected" | "all"; window: "24h" | "7d"; by: "timeline" | "published"; category: string | null; q: string | null; limit: number; cursor: string | null };
const own = <T>(map: Record<string, T>, key: string): T | undefined => Object.hasOwn(map, key) ? map[key] : undefined;
const bad = (detail: string): never => { throw new PublicError(400, "invalid_request", detail); };
const textEncoder = new TextEncoder();

async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(value)))].map((n) => n.toString(16).padStart(2, "0")).join("");
}

function encode(value: Cursor): string {
  return "preview1." + btoa(String.fromCharCode(...textEncoder.encode(JSON.stringify(value)))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(token: string, version: string, kind: string, scope?: string): Cursor {
  let value: Cursor;
  try {
    if (!token.startsWith("preview1.") || token.length > 4096) throw new Error();
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(token.slice(9).replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0))));
    if (!value || typeof value.version !== "string" || value.kind !== kind || typeof value.scope !== "string"
      || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > 10_000_000
      || (scope !== undefined && scope !== value.scope)) throw new Error();
  } catch { throw new PublicError(400, "invalid_cursor", "The cursor does not belong to this query."); }
  if (value.version !== version) throw new PublicError(409, "snapshot_required", "The preview snapshot changed. Restart from the first page.");
  return value;
}

function query(url: URL, allowed?: string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (allowed && (!allowed.includes(key) || Object.hasOwn(result, key))) bad(`Unknown or repeated query parameter: ${key}.`);
    if (!Object.hasOwn(result, key)) result[key] = value;
  }
  return result;
}

function integer(value: string | undefined, fallback: number, max: number, strict = false): number {
  if (value === undefined) return fallback;
  if (strict && (!/^[1-9]\d*$/.test(value) || Number(value) > max)) bad(`Expected an integer from 1 to ${max}.`);
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.trunc(n))) : fallback;
}

function filters(snapshot: PreviewSnapshot, q: Record<string, string>): TimelineFilters {
  const channel = q.channel || "all";
  const category = q.category || null;
  const tag = q.tag?.trim().slice(0, 60) || null;
  const topic = q.topic?.trim() || null;
  if (!isChannelKey(channel) || (category !== null && !isCategoryKey(category))) bad("Unknown channel or category.");
  if (topic && !own(snapshot.corpus.topicTags, topic)) bad("Unknown topic.");
  return { channel, category, tag, topic } as TimelineFilters;
}

function scopeKey(path: string, f: TimelineFilters): string {
  const url = new URL(path, "https://snapshot.invalid");
  for (const [key, value] of Object.entries(f)) if (value) url.searchParams.set(key, value);
  return canonicalKey(url);
}

function matchingPool(snapshot: PreviewSnapshot, f: TimelineFilters) {
  const topicIds = f.topic ? new Set(own(snapshot.corpus.topicItemIds, f.topic) ?? []) : null;
  return snapshot.corpus.poolItems.filter((item) => {
    const detail = own(snapshot.corpus.items, item.id);
    return (f.channel === "all" || (f.channel === "firstParty" ? detail?.source.firstParty : item.channel === f.channel))
      && (!f.category || item.category === f.category) && (!f.tag || item.tags.includes(f.tag))
      && (!topicIds || topicIds.has(item.id));
  });
}

function searchParts(snapshot: PreviewSnapshot, id: string) {
  const parts = own(snapshot.corpus.search, id);
  return { direct: (parts?.direct ?? "").toLowerCase(), body: (parts?.body ?? "").toLowerCase() };
}
function terms(q: string | null): string[] { return q?.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6) ?? []; }

export function createSnapshotApi(snapshot: PreviewSnapshot) {
  validateSnapshot(snapshot);
  validateSnapshotScope(snapshot);
  // Computed by the exporter: Worker initialization performs no asynchronous I/O or whole-corpus hash.
  const version = snapshot.contentHash;
  const poolIds = new Set(snapshot.corpus.poolItems.map((item) => item.id));
  const fixed = (key: string) => snapshotResponse(snapshot, canonicalKey(key));

  async function items(q: ItemQuery) {
    const scope = JSON.stringify({ mode: q.mode, window: q.window, by: q.by, category: q.category, q: q.q });
    const offset = q.cursor ? decode(q.cursor, version, "items", scope).offset : 0;
    const now = Date.parse(snapshot.generatedAt);
    const start = now - (q.window === "24h" ? 1 : 7) * 86_400_000;
    const search = terms(q.q);
    const sortTime = (item: PreviewSnapshot["corpus"]["v1Items"][number]) => {
      if (q.by === "published") return item.publishedAt ?? item.discoveredAt;
      const timeline = own(snapshot.corpus.items, item.id)?.timelineAt ?? item.discoveredAt;
      return q.mode === "selected" ? own(snapshot.corpus.v1Timeline ?? {}, item.id) ?? timeline : timeline;
    };
    const all = snapshot.corpus.v1Items.filter((item) => {
      const at = Date.parse(sortTime(item));
      const parts = searchParts(snapshot, item.id);
      return poolIds.has(item.id) && (q.mode === "all" || item.selected) && (!q.category || q.category === item.category)
        && at >= start && at <= now && search.every((term) => parts.direct.includes(term) || parts.body.includes(term));
    }).sort((a, b) => sortTime(b).localeCompare(sortTime(a)) || b.id.localeCompare(a.id));
    const page = all.slice(offset, offset + q.limit);
    const hasMore = offset + page.length < all.length;
    return {
      schemaVersion: 1 as const,
      query: { mode: q.mode, category: q.category, window: q.window, q: q.q, by: q.by, ordering: q.by === "published" ? "publishedAtDesc" : "timelineDesc" },
      items: page,
      page: { count: page.length, hasMore, nextCursor: hasMore ? encode({ version, kind: "items", scope, offset: offset + page.length }) : null },
    };
  }

  const mcp = createSnapshotMcp(snapshot, items, async path => {
    try {
      const response = await route(new URL(path, snapshot.siteUrl));
      return response.status === 200 && response.body !== null && typeof response.body === "object" ? response.body as Record<string, unknown> : null;
    } catch { return null; }
  });

  async function route(url: URL): Promise<SnapshotResponse> {
    const path = url.pathname;
    const json = (body: unknown, cacheControl = "public, max-age=60"): SnapshotResponse => ({ status: 200, contentType: "application/json; charset=utf-8", body, headers: { "Cache-Control": cacheControl } });
    // A previous export cannot reopen a report kind that this deployment has disabled.
    const reportKind = /^\/api\/(?:site|v1)\/reports\/([^/]+)(?:\/|$)/.exec(path)?.[1]
      ?? /^\/feed\/(daily|weekly|monthly)\.xml$/.exec(path)?.[1]
      ?? (/^\/api\/v1\/dailies(?:\/|$)/.test(path) ? "daily" : undefined);
    if (reportKind && !isReportKindEnabled(reportKind)) throw new PublicError(404, "not_found", "This report kind is unavailable.");
    const q = query(url);
    if (/^\/feed\/(daily|weekly|monthly)\.xml$/.test(path)) {
      const saved = fixed(path); // Like the origin feeds, tracking parameters do not change content.
      if (saved) return saved;
      throw new PublicError(404, "not_found", "No report feed is present in this snapshot.");
    }
    if (path === "/api/health") return json({ ok: true, mode: "read-only-snapshot", exportedAt: snapshot.generatedAt, contentUpdatedAt: snapshot.contentUpdatedAt, contentHash: snapshot.contentHash, schemaVersion: snapshot.schemaVersion }, "no-store");
    if (/^\/api\/(site|v1)\/(leaderboard-events|papers)$/.test(path)) {
      const radar = path.endsWith("leaderboard-events");
      query(url, radar ? ["limit", "cursor", "source", "type", "model"] : ["limit", "cursor", "evaluationType", "sourceId", "q"]);
      for (const key of radar ? ["source", "model"] : ["sourceId", "q"]) if (q[key] && q[key].length > 128) bad("Filter is too long");
      if (q.cursor !== undefined && (!q.cursor || q.cursor.length > 2048)) bad("Invalid cursor");
      const limit = integer(q.limit, 30, 100, true);
      const scope = JSON.stringify({ source: q.source || null, type: q.type || null, model: q.model || null, evaluationType: q.evaluationType || null, sourceId: q.sourceId || null, q: q.q || null });
      const offset = q.cursor ? decode(q.cursor, version, radar ? "radar" : "papers", scope).offset : 0;
      if (radar) {
        if (q.type && !["new_leader", "top10_entry", "new_board", "methodology_change"].includes(q.type)) bad("Invalid event type");
        const all = (snapshot.corpus.research?.events ?? []).filter(event => (!q.source || event.sourceKey === q.source) && (!q.type || event.type === q.type) && (!q.model || event.model?.slug === q.model));
        const page = all.slice(offset, offset + limit);
        return json({ items: page, nextCursor: offset + page.length < all.length ? encode({ version, kind: "radar", scope, offset: offset + page.length }) : null });
      }
      if (q.evaluationType && !["new_benchmark", "evaluation_result", "eval_method", "eval_critique", "safety_eval", "agent_eval"].includes(q.evaluationType)) bad("Invalid evaluation type");
      const all = (snapshot.corpus.research?.papers ?? []).filter(paper => {
        const detail = fixed(`/api/site/papers/${encodeURIComponent(paper.id)}`)?.body as { materials?: Array<{ sourceId?: string; title: string; evaluationType?: string | null }> } | undefined;
        const search = (q.q ?? "").trim().slice(0, 200).toLowerCase();
        return !q.evaluationType && !q.sourceId && !search || detail?.materials?.some(material =>
          (!q.sourceId || material.sourceId === q.sourceId) && (!q.evaluationType || material.evaluationType === q.evaluationType)
          && (!search || paper.arxivId.toLowerCase().includes(search) || material.title.toLowerCase().includes(search)));
      });
      const page = all.slice(offset, offset + limit);
      return json({ items: page, nextCursor: offset + page.length < all.length ? encode({ version, kind: "papers", scope, offset: offset + page.length }) : null });
    }
    if (path === "/robots.txt") return { status: 200, contentType: "text/plain; charset=utf-8", body: "User-agent: *\nDisallow: /\n", headers: { "Cache-Control": "public, max-age=3600" } };
    if (path === "/manifest.webmanifest") return {
      status: 200, contentType: "application/manifest+json", headers: { "Cache-Control": "public, max-age=86400" }, body: {
        name: `${SITE.name} — ${SITE.tagline}`, short_name: SITE.name, description: SITE.description, lang: SITE.locale,
        start_url: "/", scope: "/", display: "standalone", background_color: "#13191c", theme_color: "#13191c",
        icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icon.png", sizes: "512x512", type: "image/png" }],
      },
    };
    if (path === "/api/site/pool") {
      const f = filters(snapshot, q);
      const search = q.q?.trim().slice(0, 200) || null;
      const tab = search && q.tab === "relevance" ? "relevance" : "time";
      const page = integer(q.page, 1, 50);
      const candidates = matchingPool(snapshot, f);
      const words = terms(search);
      const relevance = (id: string, title: string) => {
        const p = searchParts(snapshot, id);
        return words.reduce((sum, word) => sum + (title.toLowerCase().includes(word) ? 6 : 0) + (p.direct.includes(word) ? 3 : 0) + (p.body.includes(word) ? 1 : 0), 0);
      };
      const all = candidates.filter((item) => {
        const p = searchParts(snapshot, item.id);
        return words.every((word) => p.direct.includes(word) || (tab === "relevance" && p.body.includes(word)));
      }).sort((a, b) => (tab === "relevance" ? relevance(b.id, b.title) - relevance(a.id, a.title) : 0)
        || b.timelineAt.localeCompare(a.timelineAt) || b.id.localeCompare(a.id)).slice(0, 2000);
      const today = beijingDate(snapshot.generatedAt);
      return json({ filters: { ...f, q: search, tab }, items: all.slice((page - 1) * 40, page * 40), page,
        pageCount: Math.max(1, Math.ceil(all.length / 40)), total: all.length,
        todayCount: candidates.filter((item) => beijingDate(item.timelineAt) === today).length,
        freshness: snapshot.contentUpdatedAt ?? snapshot.generatedAt, generatedAt: snapshot.generatedAt } satisfies PoolResponse);
    }
    if (path === "/api/site/timeline") {
      const f = filters(snapshot, q);
      const key = scopeKey(path, f);
      const saved = own(snapshot.corpus.timelineVariants, own(snapshot.corpus.timelineAliases ?? {}, key) ?? key);
      if (!saved && matchingPool(snapshot, f).some((item) => item.selected)) {
        throw new PublicError(400, "unsupported_filter", "This filter combination is unavailable in this preview snapshot.");
      }
      const cards = saved ? snapshotTimelineCards(snapshot, saved) : [];
      const offset = q.cursor ? decode(q.cursor, version, "timeline", key).offset : 0;
      const limit = integer(q.limit, 20, 40);
      const page = cards.slice(offset, offset + limit);
      const days = new Set(page.map((card) => beijingDate(card.anchorAt)));
      const dayCounts: Record<string, number> = {};
      for (const card of cards) { const day = beijingDate(card.anchorAt); if (days.has(day)) dayCounts[day] = (dayCounts[day] ?? 0) + 1; }
      return json({ filters: f, cards: page,
        nextCursor: offset + page.length < cards.length ? encode({ version, kind: "timeline", scope: key, offset: offset + page.length }) : null,
        refreshAt: null, hot: !q.cursor && key === path ? saved?.hot ?? null : null, dayCounts, generatedAt: snapshot.generatedAt } satisfies TimelineResponse);
    }
    if (path === "/api/site/items/availability") {
      const ids = [...new Set((q.ids ?? "").split(",").filter((id) => ARTICLE_ID_PATTERN.test(id)))].slice(0, 500);
      return json(Object.fromEntries(ids.map((id) => { const item = own(snapshot.corpus.items, id); return [id, item ? item.readingMode === "full" ? "public" : "summary-only" : "unavailable"]; })), "no-store");
    }
    if (/^\/api\/site\/(groups\/[^/]+\/reports|stories\/[^/]+\/developments)$/.test(path)) {
      const f = filters(snapshot, q);
      const key = scopeKey(path, f);
      const saved = fixed(key);
      if (!saved || saved.status !== 200) throw new PublicError(404, "not_found", "No public group was found.");
      const body = saved.body as GroupReportsResponse | DevelopmentsResponse;
      if (q.revision !== undefined && q.revision !== body.revision) throw new PublicError(409, "group_changed", "The group changed. Reload it before continuing.");
      const isReports = "reports" in body;
      const entries = isReports ? body.reports : body.developments;
      const offset = q.cursor ? decode(q.cursor, version, "group", key).offset : 0;
      const take = integer(q.take, isReports ? 20 : 10, isReports ? 40 : 20);
      const page = entries.slice(offset, offset + take);
      const nextCursor = offset + page.length < entries.length ? encode({ version, kind: "group", scope: key, offset: offset + page.length }) : null;
      return json({ ...body, [isReports ? "reports" : "developments"]: page, nextCursor }, "no-store");
    }
    if (path === "/api/v1/items") {
      const p = query(url, ["mode", "window", "by", "category", "q", "limit", "cursor"]);
      const mode = p.mode ?? "selected", window = p.window ?? "7d", by = p.by ?? "timeline", category = p.category ?? null;
      if ((mode !== "selected" && mode !== "all") || (window !== "24h" && window !== "7d") || (by !== "timeline" && by !== "published") || (category !== null && !isCategoryKey(category))) bad("Invalid item filters.");
      const search = p.q === undefined ? null : p.q.trim();
      if (search !== null && ([...search].length < 2 || [...search].length > 200)) bad("Search must contain 2 to 200 characters.");
      if (p.cursor === "") bad("The cursor cannot be empty.");
      return json(await items({ mode, window, by, category, q: search, limit: integer(p.limit, 50, 100, true), cursor: p.cursor ?? null } as ItemQuery), V1_CACHE_CONTROL.items);
    }
    if (path === "/api/v1/selected/snapshot") {
      const p = query(url, ["fields", "limit", "page"]);
      if (p.fields !== undefined && p.fields !== "default" && p.fields !== "minimal") bad("Unknown field projection.");
      if (p.page === "") bad("The page token cannot be empty.");
      const previous = p.page ? decode(p.page, version, "snapshot") : null;
      if (previous && (previous.fields !== "default" && previous.fields !== "minimal" || previous.scope !== previous.fields || p.fields !== undefined && p.fields !== previous.fields)) bad("The page token does not match this projection.");
      const fields = previous?.fields ?? p.fields ?? "default";
      const offset = previous?.offset ?? 0;
      const limit = integer(p.limit, 500, 1000, true);
      const all = snapshot.corpus.v1Items.filter((item) => poolIds.has(item.id) && item.selected).sort((a, b) => a.id.localeCompare(b.id));
      const page = all.slice(offset, offset + limit).map((item) => fields === "minimal" ? {
        id: item.id, title: item.title, source: item.source, publishedAt: item.publishedAt, discoveredAt: item.discoveredAt,
        category: item.category, score: item.score, selected: item.selected, links: { aihot: item.links.aihot },
      } : item);
      const hasMore = offset + page.length < all.length;
      return json({ schemaVersion: 1, asOf: snapshot.generatedAt, fields,
        cursor: encode({ version, kind: "changes", scope: fields, fields: fields as "default" | "minimal", offset: 0 }),
        count: page.length, hasMore,
        nextPage: hasMore ? encode({ version, kind: "snapshot", scope: fields, fields: fields as "default" | "minimal", offset: offset + page.length }) : null, items: page }, V1_CACHE_CONTROL.selectedSnapshot);
    }
    if (path === "/api/v1/selected/changes") {
      const p = query(url, ["cursor", "limit"]);
      integer(p.limit, 100, 100, true);
      let cursor: Cursor;
      try {
        cursor = decode(p.cursor ?? "", version, "changes");
        if ((cursor.fields !== "default" && cursor.fields !== "minimal") || cursor.scope !== cursor.fields) throw new Error();
      } catch { throw new PublicError(409, "snapshot_required", "Fetch a fresh selected snapshot before requesting changes."); }
      return json({ schemaVersion: 1, fields: cursor.fields, cursor: p.cursor, count: 0, hasMore: false, changes: [] }, V1_CACHE_CONTROL.selectedChanges);
    }
    if (path === "/api/v1/dailies") {
      const p = query(url, ["limit"]);
      const limit = integer(p.limit, 30, 180, true);
      const saved = fixed(path);
      if (saved?.status === 200) {
        const body = saved.body as { schemaVersion: 1; items: unknown[] };
        const entries = body.items.slice(0, limit);
        return json({ ...body, count: entries.length, items: entries }, V1_CACHE_CONTROL.dailies);
      }
      if (saved) return saved;
      throw new PublicError(404, "not_found", "No report index is present in this snapshot.");
    }
    const reportList = /^\/api\/v1\/reports\/([^/]+)$/.exec(path);
    if (reportList) {
      const p = query(url, ["limit"]);
      const limit = integer(p.limit, 30, 180, true);
      const saved = fixed(path);
      if (saved?.status === 200) {
        const body = saved.body as { schemaVersion: 1; kind: string; items: unknown[] };
        const entries = body.items.slice(0, limit);
        return json({ ...body, count: entries.length, items: entries }, V1_CACHE_CONTROL.dailies);
      }
      if (saved) return saved;
      throw new PublicError(404, "not_found", "No report index is present in this snapshot.");
    }
    if (path.startsWith("/api/v1/")) {
      query(url, []);
      const date = /^\/api\/v1\/dailies\/([^/]+)$/.exec(path)?.[1];
      if (date && date !== "latest" && !isValidDate(date)) bad("Invalid date.");
      const report = /^\/api\/v1\/reports\/([^/]+)\/([^/]+)$/.exec(path);
      if (report && isReportKindEnabled(report[1]!) && report[2] !== "latest" && !isReportKey(report[1]!, report[2]!)) bad("Invalid report period.");
    }
    const saved = fixed(url.href);
    if (saved?.status === 200 && path === "/api/site/meta") {
      return { ...saved, body: { ...(saved.body as Record<string, unknown>), preview: { readOnly: true, exportedAt: snapshot.generatedAt } } };
    }
    if (saved) return saved;
    throw new PublicError(404, "not_found", "This public resource is not present in the preview snapshot.");
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/mcp") return mcp.fetch(request);
    const isV1 = url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/") || url.pathname === "/openapi-v1.json";
    const headers = new Headers(isV1 ? PUBLIC_API_CORS : {});
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Preview-Read-Only", "true");
    const problem = (status: number, code: string, detail: string) => {
      const requestId = crypto.randomUUID();
      headers.set("Content-Type", "application/problem+json"); headers.set("Cache-Control", "no-store"); headers.set("X-Request-Id", requestId);
      return new Response(request.method === "HEAD" ? null : JSON.stringify({ type: `/problems/${code.replaceAll("_", "-")}`, title: ({ 400: "Bad request", 404: "Not found", 405: "Method not allowed", 409: "Conflict", 500: "Internal error" } as Record<number, string>)[status] ?? "Error", status, detail, code, requestId }), { status, headers });
    };
    // These paths cannot be enabled accidentally by adding a response to the exported map.
    if (/^\/(?:admin(?:\/|$)|api\/(?:admin|auth|ingest|feedback|site\/feedback)(?:\/|$))/.test(url.pathname)) return problem(404, "preview_read_only", "Management and write endpoints are disabled in this preview.");
    if (request.method === "OPTIONS") { headers.set("Allow", "GET, HEAD, OPTIONS"); return new Response(null, { status: 204, headers }); }
    if (request.method !== "GET" && request.method !== "HEAD") { headers.set("Allow", "GET, HEAD, OPTIONS"); return problem(405, "method_not_allowed", "This preview accepts read requests only."); }
    try {
      const result = await route(url);
      for (const [key, value] of Object.entries(result.headers ?? {})) headers.set(key, value);
      headers.set("Content-Type", result.contentType);
      headers.set("Last-Modified", new Date(snapshot.generatedAt).toUTCString());
      if (!headers.has("Cache-Control")) headers.set("Cache-Control", url.pathname.startsWith("/feed") ? RSS_CACHE_CONTROL : "public, max-age=60");
      const body = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
      const etag = `W/"preview-${(await digest(body)).slice(0, 24)}"`;
      headers.set("ETag", etag);
      const matches = request.headers.get("If-None-Match")?.split(",").some((value) => value.trim() === "*" || value.trim().replace(/^W\//, "") === etag.replace(/^W\//, ""));
      if (result.status === 200 && matches) return new Response(null, { status: 304, headers });
      return new Response(request.method === "HEAD" || [204, 304].includes(result.status) ? null : body, { status: result.status, headers });
    } catch (error) {
      if (error instanceof PublicError) return problem(error.status, error.code, error.message);
      return problem(500, "internal_error", "The preview cannot complete this request.");
    }
  }
  return Object.assign(handle, { close: () => mcp.close() });
}
