// Export public reading projections from the local production-data database. No collectors or workers.
import { readFileSync, mkdirSync, renameSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import childProcess from "node:child_process";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { canonicalKey, compactSnapshotResponses, compactTimelineCards, snapshotResponse, snapshotResponseEntries, validateSnapshot, validateSnapshotScope, type PreviewSnapshot } from "../deploy/cloudflare/snapshot.ts";
import type { CategoryKey, ChannelKey } from "../packages/contracts/src/taxonomy.ts";
import type { FeedItemSummary, ItemDetail, TimelineResponse } from "../packages/contracts/src/site.ts";
import { CONTENT_SCOPE } from "../industry/scope.ts";
import { ENABLED_REPORT_KINDS, isReportKindEnabled } from "../industry/features.ts";
import { configureReportOpenApi } from "../packages/backend/src/publication/report-discovery.ts";
import type { PoolExportCursor, PoolExportPage } from "../packages/backend/src/publication/pool.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUTPUT = path.join(ROOT, ".data/cloudflare-preview/snapshot.json");
const SITE_URL = "https://b.zhangmin.name";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const FIXTURE = /(?:local-validation|validation-fixture|(?:^|[\s/_-])fixture(?:[\s/_-]|$)|^test[-_]|example\.(?:com|org|net)|\.invalid(?:[/:]|$))/i;

export function snapshotOutput(args: string[]): { output: string; capacityOnly: boolean } {
  if (!args.length) return { output: OUTPUT, capacityOnly: false };
  const output = path.resolve(ROOT, args[1] ?? "");
  const directory = path.join(ROOT, ".data/cloudflare-preview/capacity");
  if (args.length !== 2 || args[0] !== "--out" || path.dirname(output) !== directory || !/^[a-z0-9][a-z0-9-]*\.json$/i.test(path.basename(output))) {
    throw new Error("Snapshot export --out only permits .data/cloudflare-preview/capacity/<name>.json");
  }
  return { output, capacityOnly: true };
}

/** This deployment has no reviewed full-text licences, even if a local source is changed later. */
export function assertSummaryOnlyItem(detail: Pick<ItemDetail, "body" | "x" | "evidence">): void {
  if (detail.body !== null || detail.x !== null || detail.evidence?.claims.some((claim) => claim.support.quote !== null)) {
    throw new Error("Snapshot export permits summaries only; full text and evidence quotations require a separate licence review");
  }
}

export async function collectPublicPool(load: (after: PoolExportCursor | null) => Promise<PoolExportPage>): Promise<FeedItemSummary[]> {
  const items: FeedItemSummary[] = [];
  const seen = new Set<string>();
  let after: PoolExportCursor | null = null;
  do {
    const page = await load(after);
    for (const item of page.items) {
      if (seen.has(item.id)) throw new Error("Incomplete pool export: repeated public item");
      seen.add(item.id); items.push(item);
    }
    if (page.next && (!page.items.length || page.next.id !== page.items.at(-1)?.id || JSON.stringify(page.next) === JSON.stringify(after))) {
      throw new Error("Incomplete pool export: invalid continuation");
    }
    after = page.next;
  } while (after);
  return items;
}

type ReportReaders = Pick<typeof import("../packages/backend/src/publication/reports.ts"),
  "listReports" | "loadReport" | "reportNavigation" | "loadReportMonth" | "v1Daily" | "v1Dailies" | "v1Reports" | "v1Report">;
type PutResponse = (key: string, body: unknown, status?: number) => void;

/** New research outlets use only the permission-filtered public readers, never raw tables. */
export async function exportResearchResponses(snapshot: PreviewSnapshot, readers: {
  radar: Pick<typeof import("../packages/backend/src/publication/leaderboard-events.ts"), "listLeaderboardEvents" | "leaderboardEvent" | "leaderboardSourceStates" | "modelEvidenceHistory" | "listModelEvidenceHistories" | "leaderboardEventFeed">;
  papers: Pick<typeof import("../packages/backend/src/publication/papers.ts"), "listPapers" | "loadPaper" | "loadPaperHistory">;
  paperFeed: (now?: Date) => Promise<string>;
}, now = new Date(snapshot.generatedAt)): Promise<void> {
  const put = (path: string, body: unknown, contentType = "application/json; charset=utf-8") => {
    snapshot.responses[canonicalKey(path)] = { status: 200, contentType, body: publicProjection(body) };
  };
  const events: NonNullable<PreviewSnapshot["corpus"]["research"]>["events"] = [];
  const papers: NonNullable<PreviewSnapshot["corpus"]["research"]>["papers"] = [];
  const seenEvents = new Set<string>(), seenPapers = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await readers.radar.listLeaderboardEvents({ limit: 100, cursor });
    for (const event of page.items) {
      if (seenEvents.has(event.id)) throw new Error("Incomplete research export: repeated event");
      seenEvents.add(event.id); events.push(event);
      const detail = await readers.radar.leaderboardEvent(event.id);
      if (!detail) throw new Error("Incomplete research export: missing event");
      for (const prefix of ["/api/site", "/api/v1"]) put(`${prefix}/leaderboard-events/${encodeURIComponent(event.id)}`, detail);
    }
    if (page.nextCursor && page.nextCursor === cursor) throw new Error("Incomplete research export: event continuation stalled");
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  cursor = undefined;
  do {
    const page = await readers.papers.listPapers({ limit: 100, cursor, now });
    for (const paper of page.items) {
      if (seenPapers.has(paper.id)) throw new Error("Incomplete research export: repeated paper");
      seenPapers.add(paper.id); papers.push(paper);
      const detail = await readers.papers.loadPaper(paper.id, now), history = await readers.papers.loadPaperHistory(paper.id, now);
      if (!detail || !history) throw new Error("Incomplete research export: missing paper");
      for (const prefix of ["/api/site", "/api/v1"]) {
        put(`${prefix}/papers/${encodeURIComponent(paper.id)}`, detail);
        put(`${prefix}/papers/${encodeURIComponent(paper.id)}/history`, history);
      }
    }
    if (page.nextCursor && page.nextCursor === cursor) throw new Error("Incomplete research export: paper continuation stalled");
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  snapshot.corpus.research = publicProjection({ events, papers });
  const contentDates = [snapshot.contentUpdatedAt, ...events.map(event => event.detectedAt), ...papers.map(paper => paper.lastSeenAt)]
    .filter((value): value is string => !!value && Number.isFinite(Date.parse(value)));
  snapshot.contentUpdatedAt = contentDates.length ? contentDates.sort().at(-1)! : null;
  const states = await readers.radar.leaderboardSourceStates();
  for (const prefix of ["/api/site", "/api/v1"]) {
    put(`${prefix}/leaderboard-source-states`, states);
    put(`${prefix}/leaderboard-events`, { items: events.slice(0, 30), nextCursor: null });
    put(`${prefix}/papers`, { items: papers.slice(0, 30), nextCursor: null });
    for (const item of Object.values(snapshot.corpus.items)) if (item.evidence) put(`${prefix}/items/${encodeURIComponent(item.id)}/evidence`, item.evidence);
  }
  const directory = await readers.radar.listModelEvidenceHistories();
  for (const prefix of ["/api/site", "/api/v1"]) put(`${prefix}/leaderboard-model-histories`, directory);
  for (const { slug } of directory.items) {
    const history = await readers.radar.modelEvidenceHistory(slug);
    if (!history || !history.series.some((series) => series.points.length > 0)) throw new Error("Incomplete research export: model directory entry has no public history");
    for (const prefix of ["/api/site", "/api/v1"]) put(`${prefix}/leaderboard-model-history/${encodeURIComponent(slug)}`, history);
  }
  put("/feed/leaderboard.xml", await readers.radar.leaderboardEventFeed(), "application/rss+xml; charset=utf-8");
  put("/feed/papers.xml", await readers.paperFeed(now), "application/rss+xml; charset=utf-8");
}

/** The public index is bounded; older issues remain reachable through each report's neighbors. */
export async function exportReportResponses(reader: ReportReaders, put: PutResponse): Promise<boolean> {
  let hasReports = false;
  for (const kind of ENABLED_REPORT_KINDS) {
    const index = await reader.listReports(kind);
    hasReports ||= index.length > 0;
    put(`/api/site/reports/${kind}`, { kind, items: index });
    put(`/api/v1/reports/${kind}`, await reader.v1Reports(kind, 180));
    const pending = index.map(entry => entry.key);
    const reports = new Map<string, NonNullable<Awaited<ReturnType<ReportReaders["loadReport"]>>>>();
    const months = new Set<string>();
    for (let i = 0; i < pending.length; i++) {
      const key = pending[i]!;
      if (reports.has(key)) continue;
      const report = await reader.loadReport(kind, key);
      if (!report || report.kind !== kind || report.key !== key || (report.prev && report.prev >= key) || (report.next && report.next <= key)) {
        throw new Error("Incomplete report export: invalid public navigation");
      }
      reports.set(key, report);
      for (const neighbor of [report.prev, report.next]) if (neighbor && !reports.has(neighbor)) pending.push(neighbor);
      put(`/api/site/reports/${kind}/${key}`, report);
      put(`/api/site/reports/${kind}/navigation/${key}`, { items: reader.reportNavigation(kind, index, key) });
      const publicReport = await reader.v1Report(kind, key);
      if (!publicReport) throw new Error("Incomplete report export: missing public report");
      put(`/api/v1/reports/${kind}/${key}`, publicReport);
      if (kind === "daily") {
        const daily = await reader.v1Daily(key);
        if (!daily) throw new Error("Incomplete report export: missing public daily");
        put(`/api/v1/dailies/${key}`, daily);
        const month = key.slice(0, 7);
        if (!months.has(month)) {
          put(`/api/site/reports/daily/months/${month}`, { items: await reader.loadReportMonth("daily", month) });
          months.add(month);
        }
      }
    }
    const latest = index[0] ? reports.get(index[0].key)! : null;
    const latestPublic = await reader.v1Report(kind, "latest");
    put(`/api/v1/reports/${kind}/latest`, latestPublic ?? { status: 404, code: "not_found", detail: "No public content in this snapshot" }, latestPublic ? 200 : 404);
    put(`/api/site/reports/${kind}/latest-page`, { index: reader.reportNavigation(kind, index, latest?.key ?? ""), report: latest });
  }
  if (isReportKindEnabled("daily")) {
    put("/api/v1/dailies", await reader.v1Dailies(180));
    const latestDaily = await reader.v1Daily("latest");
    put("/api/v1/dailies/latest", latestDaily ?? { status: 404, code: "not_found", detail: "No public content in this snapshot" }, latestDaily ? 200 : 404);
  }
  return hasReports;
}

export function validatedDatabaseUrl(value: string): URL {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !LOOPBACK.has(url.hostname)
    || url.port !== "55432" || decodeURIComponent(url.pathname) !== "/evalfrontier_local") {
    throw new Error("Export requires the local evalfrontier_local database on port 55432; test/CI databases are forbidden");
  }
  // Startup options apply to every connection, including a reconnect during export.
  url.hostname = "127.0.0.1";
  url.search = "";
  url.searchParams.set("options", "-c default_transaction_read_only=on -c statement_timeout=30000");
  url.searchParams.set("application_name", "cloudflare-public-snapshot-export");
  return url;
}

/** Reject sensitive/private links without DNS or any other outbound request. */
export function assertPublicUrl(value: string): void {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port
    || !host.includes(".") || LOOPBACK.has(host) || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host)
    || net.isIP(host) || FIXTURE.test(host)
    || [...url.searchParams.keys()].some((k) => /(?:token|secret|password|signature|credential|api[_-]?key)/i.test(k))) {
    throw new Error("Snapshot contains a private, signed, or fixture URL");
  }
}

/** Expiring local image-proxy URLs cannot be used by an offline snapshot. */
export function publicProjection<T>(value: T): T {
  if (Array.isArray(value)) return value.flatMap((entry) => {
    const projected = publicProjection(entry);
    // Remove unavailable media objects, but preserve intentional nulls (e.g. hourly heat gaps).
    return projected === null && entry !== null ? [] : [projected];
  }) as T;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.url === "string" && object.url.includes("/api/img-proxy?")) return null as T;
    return Object.fromEntries(Object.entries(object).filter(([k]) => !/srcset$/i.test(k)).map(([k, v]) => [k, publicProjection(v)])) as T;
  }
  if (typeof value === "string") {
    if (/^(?:https?:\/\/[^/]+)?\/api\/img-proxy\?/.test(value)) return null as T;
    const text = value.replace(/<img\b[^>]*\/api\/img-proxy\?[^>]*>/gi, "");
    if (/(?:postgres(?:ql)?|file):\/\/|\/Users\/|\.data\/(?:credentials|logs)|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
      throw new Error("Snapshot contains a private path or credential");
    }
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'\])]+/g)) assertPublicUrl(match[0].replace(/[.,;]+$/, ""));
    return text as T;
  }
  return value;
}

export function assertRealSource(row: { id: string; source_id: string; title: string; url: string }, allowedSources: Set<string>): void {
  if (!allowedSources.has(row.source_id) || FIXTURE.test(`${row.id} ${row.source_id} ${row.title} ${row.url}`)) {
    throw new Error("Refusing a fixture or unreviewed source in the public export");
  }
  assertPublicUrl(row.url);
}

/** Discovery documents derive exclusively from the already exported public projections. */
export async function addDiscoveryResponses(snapshot: PreviewSnapshot): Promise<void> {
  const [{ llmsTxt }, { SITE }, { FEATURES }, { CATEGORY_KEYS }] = await Promise.all([
    import("../packages/backend/src/publication/llms.ts"), import("../industry/site.ts"),
    import("../industry/features.ts"), import("../packages/contracts/src/taxonomy.ts"),
  ]);
  const hasReport = (kind: string) => ((snapshotResponse(snapshot, `/api/site/reports/${kind}`)?.body as { items?: unknown[] } | undefined)?.items?.length ?? 0) > 0;
  const note = `此部署是本地生成内容的只读快照，导出时间为 ${snapshot.generatedAt}，公开内容最近更新于 ${snapshot.contentUpdatedAt ?? "未知"}。最近 24 小时 / 7 天以导出时钟为准，不表示实时采集。selected/changes 在同一版本返回空 changes；换版返回 409 snapshot_required，需重新读取 selected/snapshot，不提供本机账本的逐项增量。云端不自动采集、生成或定时发布周报、月报。`;
  const llms = llmsTxt({ hasDailies: hasReport("daily"), hasWeekly: hasReport("weekly"), hasMonthly: hasReport("monthly"), hasLeaderboard: snapshot.capabilities.leaderboard });
  snapshot.responses["/llms.txt"] = { status: 200, contentType: "text/plain; charset=utf-8", body: publicProjection(`${llms}\n## 当前部署\n\n${note}\n`) };
  const raw = readFileSync(path.join(ROOT, "reference/public-v1.openapi.json"), "utf8")
    .replaceAll("{{siteName}}", SITE.name).replaceAll("{{siteUrl}}", snapshot.siteUrl).replaceAll("{{categoryList}}", CATEGORY_KEYS.join(", "));
  const doc = configureReportOpenApi(JSON.parse(raw) as { info: { description: string }; paths: Record<string, unknown> });
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const object = node as Record<string, unknown>;
    for (const key of ["enum", "examples"]) if (Array.isArray(object[key]) && object[key].includes("{{categories}}")) object[key] = [...CATEGORY_KEYS];
    for (const value of Object.values(object)) walk(value);
  };
  walk(doc);
  if (!FEATURES.codexResetMonitor) for (const key of Object.keys(doc.paths)) if (key.startsWith("/api/v1/codex-resets")) delete doc.paths[key];
  doc.info.description += `\n\nDeployment semantics: ${note}`;
  snapshot.responses["/openapi-v1.json"] = { status: 200, contentType: "application/json; charset=utf-8", body: publicProjection(doc) };

  const urls = new Set(["/", "/all", "/hot", "/topics", "/papers", "/radar", "/agent", "/about", "/methodology", "/terms", "/privacy", "/changelog"]);
  for (const kind of ENABLED_REPORT_KINDS) if (hasReport(kind)) urls.add(`/${kind}`);
  if (isReportKindEnabled("daily") && hasReport("daily")) urls.add("/daily/archive");
  for (const item of Object.values(snapshot.corpus.items)) if (item.indexable) urls.add(`/items/${item.id}`);
  for (const [route, response] of snapshotResponseEntries(snapshot)) {
    if (response.status !== 200) continue;
    const story = /^\/api\/site\/stories\/([^/?]+)$/.exec(route);
    const report = /^\/api\/site\/reports\/(daily|weekly|monthly)\/([\dW-]+)$/.exec(route);
    const topic = /^\/api\/site\/topics\/([^/?]+)(?:\?page=(\d+))?$/.exec(route);
    if (story) urls.add(`/story/${story[1]}`);
    const paper = /^\/api\/site\/papers\/([^/?]+)$/.exec(route);
    const radar = /^\/api\/site\/leaderboard-events\/([^/?]+)$/.exec(route);
    const history = /^\/api\/site\/leaderboard-model-history\/([^/?]+)$/.exec(route);
    if (paper) urls.add(`/papers/${paper[1]}`);
    if (radar) urls.add(`/radar/${radar[1]}`);
    if (history) urls.add(`/leaderboard/${history[1]}/history`);
    if (report && isReportKindEnabled(report[1]!)) urls.add(`/${report[1]}/${report[2]}`);
    if (topic && (response.body as { topic?: { indexable?: boolean } }).topic?.indexable) urls.add(`/topics/${topic[1]}${topic[2] ? `/page/${topic[2]}` : ""}`);
    if (snapshot.capabilities.leaderboard) {
      const board = /^\/api\/site\/leaderboard\/boards\/([^/?]+)$/.exec(route);
      const model = /^\/api\/site\/leaderboard\/models\/([^/?]+)$/.exec(route);
      const source = /^\/api\/site\/leaderboard\/sources\/([^/?]+)$/.exec(route);
      if (board) urls.add(board[1] === "overall" ? "/leaderboard" : `/leaderboard/category/${board[1]}`);
      if (model) urls.add(`/leaderboard/${model[1]}`);
      if (source) urls.add(`/leaderboard/sources/${source[1]}`);
    }
  }
  if (snapshot.capabilities.leaderboard) { urls.add("/leaderboard/sources"); urls.add("/leaderboard/rules"); }
  const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...urls].sort().map((url) => `<url><loc>${escape(snapshot.siteUrl + url)}</loc></url>`).join("\n")}\n</urlset>\n`;
  snapshot.responses["/sitemap.xml"] = { status: 200, contentType: "application/xml; charset=utf-8", body: publicProjection(xml) };
}

export function prepareEnvironment(databaseUrl: URL): void {
  // Do not import .env or inherit any model/integration/auth credentials into the exporter.
  const keep = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "USER", "LOGNAME"]);
  for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl.toString(), DATABASE_POOL_MAX: "1", SITE_URL,
    NODE_ENV: "development", COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false",
    FEISHU_INTERNAL_ENABLED: "false", FEISHU_CONTENT_PUSH_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false",
    AIHOT_DATA_DIR: path.join(ROOT, ".data/cloudflare-preview"),
    // Only to let the existing public readers create images that publicProjection removes.
    IMG_PROXY_SIGN_SECRET: randomBytes(32).toString("hex"),
  });
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    let arg = args[0];
    if (Array.isArray(arg)) arg = arg[0];
    const options = arg && typeof arg === "object" ? arg as { host?: string; port?: number | string; path?: string }
      : { port: arg as number | string, host: typeof args[1] === "string" ? args[1] : "localhost" };
    if (options.path || !LOOPBACK.has(options.host ?? "localhost") || String(options.port) !== "55432") {
      throw new Error("Snapshot export network guard: only the local read-only database is permitted");
    }
    return originalConnect.apply(this, args as Parameters<typeof originalConnect>);
  } as typeof originalConnect;
  const denied = () => { throw new Error("Snapshot export forbids HTTP requests and subprocesses"); };
  globalThis.fetch = denied;
  http.request = denied; http.get = denied; https.request = denied; https.get = denied;
  childProcess.spawn = denied; childProcess.spawnSync = denied; childProcess.exec = denied as unknown as typeof childProcess.exec;
  childProcess.execSync = denied; childProcess.execFile = denied as unknown as typeof childProcess.execFile; childProcess.execFileSync = denied; childProcess.fork = denied;
  // There is no need to resolve a remote host: PostgreSQL uses the validated literal loopback address.
  for (const module of [dns, dnsPromises]) for (const key of Object.keys(module)) {
    if (/^(?:lookup|resolve|reverse)/.test(key)) (module as unknown as Record<string, unknown>)[key] = denied;
  }
  syncBuiltinESMExports();
}

async function exportPreview(): Promise<void> {
  const { output, capacityOnly } = snapshotOutput(process.argv.slice(2));
  const localEnv = parseEnv(readFileSync(path.join(ROOT, ".env.local"), "utf8"));
  const databaseUrl = validatedDatabaseUrl(localEnv.DATABASE_URL ?? "");
  prepareEnvironment(databaseUrl);
  const { sql, closeDb } = await import("../packages/backend/src/db.ts");
  try {
    // One connection means every public-reader query shares the same consistent, read-only view.
    await sql`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    const [readOnly] = await sql`SHOW transaction_read_only`;
    if (readOnly?.transaction_read_only !== "on") throw new Error("Read-only transaction was not established");
    const now = new Date();
    const sources = JSON.parse(readFileSync(path.join(ROOT, "industry/sources.json"), "utf8")) as { sources: Array<{ id: string }> };
    const allowed = new Set(sources.sources.map((s) => s.id));
    // These private rows only locate and validate public DTOs. They never enter the artifact.
    const { publicScopeCondition, loadScopeDecision } = await import("../packages/backend/src/content/scope.ts");
    const candidates = await sql<{ id: string; revision: number; source_id: string; title: string; url: string }[]>`
      SELECT a.id,a.revision,a.source_id,a.title,a.url FROM articles a JOIN publications p ON p.article_id=a.id
      WHERE ${publicScopeCondition()} ORDER BY a.id`;
    for (const row of candidates) assertRealSource(row, allowed);
    const [detailRead, poolRead, timelineRead, topicRead, storyRead, groupRead, followupRead, reportRead, feeds, meta, contact, stats, lb, taxonomy, hotRead, payloadRead] = await Promise.all([
      import("../packages/backend/src/publication/detail.ts"), import("../packages/backend/src/publication/pool.ts"),
      import("../packages/backend/src/publication/timeline.ts"), import("../packages/backend/src/publication/topics.ts"),
      import("../packages/backend/src/publication/stories.ts"), import("../packages/backend/src/publication/groups.ts"),
      import("../packages/backend/src/publication/followups.ts"), import("../packages/backend/src/publication/reports.ts"),
      import("../packages/backend/src/publication/feeds.ts"), import("../packages/backend/src/site/meta.ts"),
      import("../packages/backend/src/site/contact.ts"), import("../packages/backend/src/site/stats.ts"),
      import("../packages/backend/src/leaderboard/read.ts"), import("../packages/contracts/src/taxonomy.ts"),
      import("../packages/backend/src/events/hot-read.ts"), import("../packages/backend/src/publication/publish.ts"),
    ]);
    const snapshot: PreviewSnapshot = {
      schemaVersion: 1, contentHash: "", generatedAt: now.toISOString(), contentUpdatedAt: null, siteUrl: SITE_URL,
      preview: { readOnly: true, ...(capacityOnly ? { capacityOnly: true } : {}) }, capabilities: { leaderboard: false, reports: false }, responses: {},
      corpus: { items: {}, poolItems: [], v1Items: [], v1Timeline: {}, search: {}, timelineVariants: {}, timelineAliases: {}, timelineCards: [], topicTags: {}, topicItemIds: {} },
    };
    const put = (key: string, body: unknown, status = 200, contentType = "application/json; charset=utf-8", headers?: Record<string, string>) => {
      snapshot.responses[canonicalKey(key)] = { status, contentType, body: publicProjection(body), ...(headers ? { headers } : {}) };
    };
    const filters = { channel: "all" as ChannelKey, category: null as CategoryKey | null, tag: null, topic: null, topicTags: null };
    for (const row of candidates) {
      const result = await detailRead.loadItemDetail(row.id, now);
      if (result.kind !== "found") continue;
      const d = result.detail;
      if (CONTENT_SCOPE.requireExplicitPass && (await loadScopeDecision(row.id,row.revision,sql))?.decision !== "PASS") throw new Error("Snapshot detail has no current scope admission");
      assertSummaryOnlyItem(d);
      const item = publicProjection(detailRead.siteItemDetail(d));
      snapshot.corpus.items[d.id] = item;
      put(`/api/site/items/${d.id}`, item);
      put(`/api/site/items/${d.id}/original`, detailRead.siteItemDetail(d, true));
      snapshot.corpus.search[d.id] = publicProjection({
        direct: [d.title, d.originalTitle, d.summary, d.source.name, ...d.tags].filter(Boolean).join(" ").toLowerCase(),
        body: "",
      });
      const markdown = await detailRead.exportMarkdown(d.id);
      if (markdown) put(`/items/${d.id}/markdown`, markdown.body, 200, "text/markdown; charset=utf-8", { "Content-Disposition": `attachment; filename="${markdown.filename}"` });
    }
    if (CONTENT_SCOPE.requireExplicitPass) snapshot.contentScope = { key: CONTENT_SCOPE.key, version: CONTENT_SCOPE.version,
      admittedPublicationRevisions: Object.fromEntries(Object.values(snapshot.corpus.items).map(item => [item.id, item.revision])) };
    const pool = await poolRead.loadPool({ ...filters, now });
    put("/api/site/pool", pool);
    snapshot.corpus.poolItems = publicProjection(await collectPublicPool(after => poolRead.loadPoolExportPage({ ...filters, now }, after)));
    const cap = poolRead.POOL_MAX_PAGES * poolRead.POOL_PAGE_SIZE;
    if (Math.min(snapshot.corpus.poolItems.length, cap) !== pool.total) throw new Error("Incomplete pool export: count differs from public browsing");
    for (let page = 1; page <= pool.pageCount; page++) {
      const data = page === 1 ? pool : await poolRead.loadPool({ ...filters, page, now });
      const start = (page - 1) * poolRead.POOL_PAGE_SIZE;
      if (JSON.stringify(publicProjection(data.items)) !== JSON.stringify(snapshot.corpus.poolItems.slice(start, start + poolRead.POOL_PAGE_SIZE))) {
        throw new Error("Incomplete pool export: cards differ from public browsing");
      }
      put(`/api/site/pool?page=${page}`, data);
    }
    for (const card of snapshot.corpus.poolItems) {
      const d = snapshot.corpus.items[card.id];
      if (!d) throw new Error("Pool item lacks a public detail");
      snapshot.corpus.v1Items.push(publicProjection({ ...payloadRead.v1Payload({ articleId: d.id, title: d.title, originalTitle: d.originalTitle,
        summary: d.summary, sourceName: d.source.name, url: d.links.original, publishedAt: d.publishedAt ? new Date(d.publishedAt) : null,
        discoveredAt: new Date(d.discoveredAt), category: d.category, score: d.score, selected: d.selected, reason: d.reason }),
        ...(d.evidence ? { evaluationType: d.evaluationType, evidence: d.evidence } : {}), ...(d.paper ? { paper: d.paper } : {}) }));
      snapshot.corpus.v1Timeline[d.id] = d.timelineAt;
    }
    // The live v1 reader uses this public sorting index for selected items. It is not article content.
    const { selectedCondition } = await import("../packages/backend/src/publication/items.ts");
    for (const row of await sql<{ id: string; at: Date }[]>`SELECT p.article_id AS id, p.sort_at AS at FROM publications p WHERE ${selectedCondition(now)}`) {
      if (snapshot.corpus.v1Timeline[row.id]) snapshot.corpus.v1Timeline[row.id] = row.at.toISOString();
    }
    snapshot.contentUpdatedAt = pool.total > 0 ? pool.freshness
      : Object.values(snapshot.corpus.items).map((d) => d.discoveredAt).sort().at(-1) ?? null;
    const topics = await topicRead.listTopicSummaries();
    put("/api/site/topics", { topics });
    for (const topic of topics) {
      snapshot.corpus.topicTags[topic.slug] = await topicRead.loadTopicTags(topic.slug) ?? [];
      const first = await topicRead.loadTopicPage(topic.slug, 1, now);
      if (!first) continue;
      put(`/api/site/topics/${topic.slug}`, first);
      for (let page = 2; page <= first.pageCount; page++) put(`/api/site/topics/${topic.slug}?page=${page}`, await topicRead.loadTopicPage(topic.slug, page, now));
      const members = await collectPublicPool(after => poolRead.loadPoolExportPage({ ...filters, topic: topic.slug, topicTags: snapshot.corpus.topicTags[topic.slug], now }, after));
      snapshot.corpus.topicItemIds[topic.slug] = members.map(item => item.id);
    }
    const hot = await hotRead.loadHotStrip();
    type Scope = { channel: ChannelKey; category: CategoryKey | null; topic: string | null; tag: string | null; topicTags: string[] | null };
    const scopePath = (base: string, scope: Scope) => {
      const query = new URLSearchParams();
      query.set("channel", scope.channel);
      for (const key of ["category", "topic", "tag"] as const) if (scope[key]) query.set(key, scope[key]);
      return canonicalKey(`${base}?${query}`);
    };
    const groupTasks = new Map<string, { id: string; scope: Scope; kind: "fact" | "story" }>();
    const addGroup = (id: string, scope: Scope, kind: "fact" | "story") => {
      const base = kind === "fact" ? `/api/site/groups/${id}/reports` : `/api/site/stories/${id}/developments`;
      groupTasks.set(scopePath(base, scope), { id, scope, kind });
    };
    const scopes: Scope[] = [];
    const tags = [...new Set(snapshot.corpus.poolItems.flatMap((i) => i.tags))];
    for (const channel of taxonomy.CHANNEL_KEYS) for (const category of [null, ...taxonomy.CATEGORY_KEYS]) {
      for (const topic of [null, ...topics.map((t) => t.slug)]) scopes.push({ channel, category, topic, tag: null, topicTags: topic ? snapshot.corpus.topicTags[topic] : null });
      for (const tag of tags) scopes.push({ channel, category, topic: null, tag, topicTags: null });
      // Only materialized nonempty intersections: preserve tag+topic semantics without a Cartesian dump.
      for (const topic of topics) {
        const members = new Set(snapshot.corpus.topicItemIds[topic.slug]);
        const scopeItems = snapshot.corpus.poolItems.filter((i) => members.has(i.id) && (!category || i.category === category)
          && (channel === "all" || (channel === "firstParty" ? snapshot.corpus.items[i.id].source.firstParty : i.channel === channel)));
        for (const tag of new Set(scopeItems.flatMap((i) => i.tags))) scopes.push({ channel, category, topic: topic.slug, tag, topicTags: snapshot.corpus.topicTags[topic.slug] });
      }
    }
    const identicalVariants = new Map<string, string>();
    for (const scope of scopes) {
      let cursor: string | null = null;
      let combined: TimelineResponse | null = null;
      do {
        const data = await timelineRead.loadTimeline({ ...scope, cursor, limit: 40, now });
        if (!combined) combined = { ...data, hot: scope.channel === "all" && !scope.category && !scope.topic && !scope.tag ? hot : null, generatedAt: now.toISOString() };
        else { combined.cards.push(...data.cards); Object.assign(combined.dayCounts, data.dayCounts); }
        cursor = data.nextCursor;
      } while (cursor);
      combined!.nextCursor = null;
      const key = scopePath("/api/site/timeline", scope);
      const projected = publicProjection(combined!);
      const signature = createHash("sha256").update(JSON.stringify({ cards: projected.cards, dayCounts: projected.dayCounts, refreshAt: projected.refreshAt, hot: projected.hot })).digest("hex");
      const existing = identicalVariants.get(signature);
      if (existing) snapshot.corpus.timelineAliases![key] = existing;
      else { snapshot.corpus.timelineVariants[key] = projected; identicalVariants.set(signature, key); }
      for (const card of combined!.cards) if (card.group) {
        addGroup(card.group.factId, scope, "fact");
        if (card.group.story) addGroup(card.group.story.publicId, scope, "story");
      }
    }
    snapshot.corpus.timelineCards = snapshot.corpus.timelineVariants["/api/site/timeline"].cards;
    for (const d of Object.values(snapshot.corpus.items)) if (d.group) addGroup(d.group.factId, filters, "fact");
    const stories = await sql<{ public_id: string }[]>`SELECT public_id::text FROM stories ORDER BY public_id`;
    for (const row of stories) {
      const found = await storyRead.resolveStory(row.public_id);
      const route = `/api/site/stories/${row.public_id}`;
      if (found.kind === "merged") {
        put(route, { mergedInto: found.target }, 308, undefined, { Location: `/api/site/stories/${found.target}` });
        put(`/api/v1/stories/${row.public_id}`, { mergedInto: found.target }, 308, undefined, { Location: `/api/v1/stories/${found.target}` });
      } else if (found.kind === "found") {
        const data = await storyRead.loadStoryDetail(found.storyId, now);
        if (!data) continue;
        put(route, data); put(`/api/v1/stories/${row.public_id}`, await storyRead.v1Story(found.storyId));
        const followups = await followupRead.loadStoryFollowups(row.public_id);
        if (followups) put(`${route}/followups`, followups);
        addGroup(row.public_id, filters, "story");
      }
    }
    for (const [route, { id, scope, kind }] of groupTasks) {
      const q = { ...scope, take: candidates.length + 1, cursor: null, revision: null };
      const result = kind === "fact" ? await groupRead.loadGroupReports({ ...q, factPublicId: id }, now)
        : await groupRead.loadDevelopments({ ...q, storyPublicId: id }, now);
      if (result.kind === "ok") {
        if (result.body.nextCursor) throw new Error("Incomplete group export");
        put(route, result.body);
      }
    }
    snapshot.capabilities.reports = await exportReportResponses(reportRead, put);
    put("/api/site/hot", await storyRead.loadHot()); put("/api/v1/hot-topics", await storyRead.v1HotTopics());
    put("/api/site/meta", meta.siteMeta()); put("/api/site/changelog", meta.loadChangelog()); put("/api/site/stats", await stats.loadSiteStats());
    const contactData = await contact.loadContact();
    put("/api/site/contact", { wechatQr: contactData.wechatQr, feishuQr: contactData.feishuQr, makerAvatar: await contact.loadMakerAvatar() });
    for (const [kind, route] of [["selected", "/feed.xml"], ["selected-full", "/feed/full.xml"], ["all", "/feed/all.xml"]] as const) put(route, await feeds.itemFeed(kind, null, now), 200, "application/rss+xml; charset=utf-8");
    for (const category of taxonomy.CATEGORY_KEYS) {
      put(`/feed/category/${category}.xml`, await feeds.itemFeed("selected", category, now), 200, "application/rss+xml; charset=utf-8");
      put(`/feed/full/category/${category}.xml`, await feeds.itemFeed("selected-full", category, now), 200, "application/rss+xml; charset=utf-8");
    }
    for (const kind of ENABLED_REPORT_KINDS) put(`/feed/${kind}.xml`, await feeds.reportFeed(kind), 200, "application/rss+xml; charset=utf-8");
    try {
      const modelSlugs = new Set<string>();
      for (const key of taxonomy.LEADERBOARD_PUBLIC_BOARDS) {
        const board = await lb.loadBoard(key);
        if (!board) continue;
        put(`/api/site/leaderboard/boards/${key}`, board);
        for (const entry of [...board.entries, ...board.filterEntries]) modelSlugs.add(entry.model.slug);
      }
      for (const slug of modelSlugs) put(`/api/site/leaderboard/models/${slug}`, await lb.loadModel(slug));
      const sourceData = await lb.loadSources(); put("/api/site/leaderboard/sources", sourceData);
      for (const source of sourceData.groups.flatMap((g) => g.sources)) put(`/api/site/leaderboard/sources/${source.key}`, await lb.loadSource(source.key));
      put("/api/site/leaderboard/rules", await lb.loadRulesData()); snapshot.capabilities.leaderboard = true;
    } catch (error) {
      if (!(error instanceof lb.NoLeaderboardRun)) throw error;
      for (const route of ["sources", "rules", ...taxonomy.LEADERBOARD_PUBLIC_BOARDS.map((key) => `boards/${key}`)]) {
        put(`/api/site/leaderboard/${route}`, { status: 503, code: "temporarily_unavailable", detail: "leaderboard not computed yet", retryAfter: 300 }, 503, "application/problem+json; charset=utf-8", { "Retry-After": "300" });
      }
    }
    await exportResearchResponses(snapshot, {
      radar: await import("../packages/backend/src/publication/leaderboard-events.ts"),
      papers: await import("../packages/backend/src/publication/papers.ts"),
      paperFeed: (await import("../packages/backend/src/publication/research-feeds.ts")).paperFeed,
    });
    await addDiscoveryResponses(snapshot);
    await sql`ROLLBACK`;
    compactTimelineCards(snapshot);
    compactSnapshotResponses(snapshot);
    validateSnapshot(snapshot);
    validateSnapshotScope(snapshot);
    snapshot.contentHash = createHash("sha256").update(JSON.stringify(publicProjection(snapshot))).digest("hex");
    const serialized = JSON.stringify(publicProjection(snapshot));
    if (serialized.includes("/api/img-proxy?")) throw new Error("Expiring proxy URLs remain in snapshot");
    mkdirSync(path.dirname(output), { recursive: true });
    if (realpathSync(path.dirname(output)) !== path.dirname(output)) throw new Error("Snapshot export refuses symlinked output directories");
    writeFileSync(`${output}.tmp`, serialized + "\n", { mode: 0o600, flag: "wx" });
    renameSync(`${output}.tmp`, output);
    console.log(JSON.stringify({ output: path.relative(ROOT, output), capacityOnly, generatedAt: snapshot.generatedAt, contentUpdatedAt: snapshot.contentUpdatedAt,
      details: Object.keys(snapshot.corpus.items).length, pool: snapshot.corpus.poolItems.length, selected: snapshot.corpus.poolItems.filter((i) => i.selected).length,
      timelineVariants: Object.keys(snapshot.corpus.timelineVariants).length, timelineAliases: Object.keys(snapshot.corpus.timelineAliases!).length, topics: topics.length,
      responses: Object.keys(snapshot.responses).length, responseAliases: Object.keys(snapshot.responseAliases!).length,
      capabilities: snapshot.capabilities, sharedTimelineCards: snapshot.corpus.timelineCardIndex!.length, bytes: Buffer.byteLength(serialized), readOnly: true }));
  } finally { await closeDb(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await exportPreview().catch((error: unknown) => {
    // Database/provider errors may contain connection strings: report only a safe error class/code.
    const e = error as { name?: string; code?: string; message?: string };
    const detail = /^(?:Export requires |Snapshot contains |Snapshot export |Refusing a fixture |Read-only transaction |Pool export |Incomplete |Pool item |Expiring proxy )/.test(e.message ?? "") ? e.message : undefined;
    console.error(JSON.stringify({ exportFailed: true, error: e.name ?? "Error", code: e.code ?? "EXPORT_REJECTED", detail }));
    process.exitCode = 1;
  });
}
