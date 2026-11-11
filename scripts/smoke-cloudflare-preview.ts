// Read-only preview acceptance against the exact exported public snapshot. No database access.
// node scripts/smoke-cloudflare-preview.ts --base http://127.0.0.1:8787 [--coverage full|representative] [--snapshot .data/cloudflare-preview/snapshot.json] [--concurrency 6] [--resolve-ip VERIFIED_IP] [--version-override WORKER=UUID]
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { Agent } from "undici";
import { SITE } from "@aihot/industry/site";
import { ENABLED_REPORT_KINDS, FEATURES, isReportKindEnabled } from "@aihot/industry/features";
import { CATEGORY_KEYS, LEADERBOARD_PUBLIC_BOARDS } from "@aihot/contracts/taxonomy";
import { MCP_TOOL_NAMES as T, MCP_TOOLS } from "@aihot/contracts/mcp";
import type { FeedItemSummary, PoolResponse, TimelineResponse, ReportDetail, ReportIndexEntry } from "@aihot/contracts/site";
import type { LbBoardResponse, LbModelDetail, LbSourceDetail } from "@aihot/contracts/leaderboard";
import type { PaperDetail, PaperHistoryResponse, PaperListItem, PublicEvaluationEvidence } from "@aihot/contracts/evaluation";
import type { LeaderboardEvent, LeaderboardModelHistory, LeaderboardModelHistoryList } from "@aihot/contracts/radar";
import { snapshotResponse, snapshotResponseEntries, snapshotTimelineCards, validateSnapshot, validateSnapshotScope, type PreviewSnapshot } from "../deploy/cloudflare/snapshot.ts";
import { publicTimestamp, representativeSample, responseFamily, type SampleGroup } from "./lib/preview-smoke-sampling.ts";

const option = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
};
const base = option("--base", "http://127.0.0.1:8787").replace(/\/$/, "");
const coverage = option("--coverage", "full");
assert.ok(coverage === "full" || coverage === "representative", "--coverage must be full or representative");
const concurrency = Number(option("--concurrency", "6"));
assert.ok(Number.isInteger(concurrency) && concurrency >= 4 && concurrency <= 6, "Concurrency must be an integer from 4 to 6");
const resolveIp = option("--resolve-ip", "");
const versionOverride = option("--version-override", "");
const versionMatch = versionOverride ? /^([a-z0-9][a-z0-9-]*)=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(versionOverride) : null;
assert.ok(!versionOverride || versionMatch, "--version-override must be WORKER=UUID");
const target = new URL(base);
assert.equal(target.username + target.password + target.search + target.hash, "", "Base must not contain credentials, a query or a fragment");
assert.equal(target.pathname, "/", "Base must be an origin");
let transport: Agent | undefined;
if (resolveIp) {
  const family = isIP(resolveIp);
  assert.ok(family, "--resolve-ip must be a previously verified IP address");
  assert.equal(target.protocol, "https:", "A DNS override requires HTTPS");
  assert.equal(isIP(target.hostname), 0, "A DNS override requires a named hostname");
  transport = new Agent({ connections: concurrency, maxOrigins: 1, connect: {
    servername: target.hostname, rejectUnauthorized: true,
    lookup(hostname, options, callback) {
      if (hostname !== target.hostname) return callback(Object.assign(new Error("DNS override is restricted to the target hostname"), { code: "ENOTFOUND" }), "", 0);
      callback(null, options.all ? [{ address: resolveIp, family }] : resolveIp, family);
    },
  } });
  console.log(JSON.stringify({ dnsOverride: { hostname: target.hostname, address: resolveIp }, tlsCertificateValidation: true }));
}
const startedAt = performance.now();
const snapshot = JSON.parse(readFileSync(option("--snapshot", ".data/cloudflare-preview/snapshot.json"), "utf8")) as PreviewSnapshot;
assert.ok(snapshot.schemaVersion === 1 || snapshot.schemaVersion === 2);
validateSnapshot(snapshot);
validateSnapshotScope(snapshot);
if (versionMatch) assert.equal(target.origin, new URL(snapshot.siteUrl).origin, "Version overrides are restricted to this snapshot's public origin");
const storedResponses = snapshotResponseEntries(snapshot);
assert.equal(snapshot.preview.readOnly, true);
assert.ok(Object.keys(snapshot.corpus.items).length, "Refusing to accept an empty snapshot");
const expectedIds = Object.keys(snapshot.corpus.items).sort();
const samples: Record<string, { total: number; sampled: number; groups: SampleGroup[] }> = {};
function choose<T>(name: string, values: T[], options: Parameters<typeof representativeSample<T>>[1]): T[] {
  const selected = coverage === "full" ? { values, groups: [] } : representativeSample(values, options);
  samples[name] = { total: values.length, sampled: selected.values.length, groups: selected.groups };
  console.log(JSON.stringify({ stage: "coverage", coverage, collection: name, ...samples[name] }));
  return selected.values;
}
const jsonSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const itemIds = choose("items", expectedIds, {
  key: id => id,
  group: id => { const item = snapshot.corpus.items[id]!; return `${item.category}|${item.channel}|${item.selected}|${item.readingMode}`; },
  size: id => jsonSize(snapshot.corpus.items[id]), time: id => publicTimestamp(snapshot.corpus.items[id]),
});
for (const item of Object.values(snapshot.corpus.items)) {
  assert.equal(item.body, null, "This deployment only permits summaries");
  assert.equal(item.x, null, "This deployment has no approved X full-text sources");
  assert.equal(snapshot.corpus.search[item.id]?.body, "", "Unlicensed body text must not enter search");
}
let passed = 0, failed = 0, requests = 0;
async function check(name: string, action: () => Promise<void>) {
  try { await action(); passed++; console.log(`✓ ${name}`); }
  catch (error) { failed++; console.error(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
async function get(path: string, status = 200, init?: RequestInit) {
  requests++;
  const headers = new Headers(init?.headers);
  if (versionMatch) headers.set("Cloudflare-Workers-Version-Overrides", `${versionMatch[1]}="${versionMatch[2]}"`);
  const requestOptions: RequestInit & { dispatcher?: Agent } = { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(30_000), ...(transport ? { dispatcher: transport } : {}) };
  const response = await fetch(`${base}${path}`, requestOptions);
  assert.equal(response.status, status, `${path}: HTTP status`);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow", `${path}: preview robots policy`);
  assert.equal(response.headers.get("x-preview-snapshot"), snapshot.generatedAt, `${path}: deployed snapshot identity`);
  assert.equal(response.headers.get("set-cookie"), null, `${path}: public responses cannot create sessions`);
  if (status !== 200) assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  return response;
}
async function json<T>(path: string, status = 200): Promise<T> {
  const response = await get(path, status);
  assert.match(response.headers.get("content-type") ?? "", /json/);
  return await response.json() as T;
}
const sorted = (ids: string[]) => [...ids].sort();
const ids = (items: { id: string }[]) => items.map(item => item.id);
const htmlText = (value: string) => value.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");
function savedJson<T>(path: string): T {
  const saved = snapshotResponse(snapshot, path);
  assert.equal(saved?.status, 200, `${path}: missing linked public response`);
  assert.ok(saved.body && typeof saved.body === "object", `${path}: expected public JSON`);
  return saved.body as T;
}
// New research pages and MCP details keep three useful boundaries in representative mode. Fixed
// API response checks below already cover their stored paths; no production fixtures are created.
function chooseResearch<T>(name: string, values: T[], options: { key: (value: T) => string; size: (value: T) => number; time: (value: T) => string }): T[] {
  let selected = values;
  if (coverage === "representative" && values.length > 3) {
    const keyOrder = (a: T, b: T) => options.key(a).localeCompare(options.key(b));
    const bySize = [...values].sort((a, b) => options.size(a) - options.size(b) || keyOrder(a, b));
    const byDate = [...values].sort((a, b) => options.time(a).localeCompare(options.time(b)) || keyOrder(a, b));
    const keys = new Set([bySize.at(-1)!, byDate[0]!, byDate.at(-1)!].map(options.key));
    for (const value of [...bySize].reverse()) if (keys.size < 3) keys.add(options.key(value));
    selected = values.filter(value => keys.has(options.key(value)));
  }
  samples[name] = { total: values.length, sampled: selected.length, groups: [{ group: name, total: values.length, sampled: selected.length }] };
  console.log(JSON.stringify({ stage: "coverage", coverage, collection: name, ...samples[name] }));
  return selected;
}
const researchEvents = snapshot.corpus.research?.events ?? [];
const researchPapers = snapshot.corpus.research?.papers ?? [];
const paperDetail = (id: string) => savedJson<PaperDetail>(`/api/v1/papers/${encodeURIComponent(id)}`);
const historyDirectory = savedJson<LeaderboardModelHistoryList>("/api/v1/leaderboard-model-histories");
const modelHistories = historyDirectory.items.map(model => savedJson<LeaderboardModelHistory>(`/api/v1/leaderboard-model-history/${encodeURIComponent(model.slug)}`));
const sampledPapers = chooseResearch("researchPapers", researchPapers, {
  key: paper => paper.id, size: paper => jsonSize(paperDetail(paper.id)), time: paper => paper.lastSeenAt,
});
const sampledEvents = chooseResearch("researchEvents", researchEvents, {
  key: event => event.id, size: jsonSize, time: event => event.occurredAt,
});
const sampledHistories = chooseResearch("modelHistories", modelHistories, {
  key: history => history.model.slug, size: jsonSize,
  time: history => history.series.flatMap(series => series.points.map(point => point.at ?? "")).sort().at(-1) ?? "",
});
const evidenceItems = Object.values(snapshot.corpus.items).filter(item => item.evidence);
const sampledEvidence = chooseResearch("evaluationEvidence", evidenceItems, {
  key: item => item.id, size: item => jsonSize(item.evidence), time: item => item.evidence!.checkedAt,
});
const byTime = (a: FeedItemSummary, b: FeedItemSummary) => b.timelineAt.localeCompare(a.timelineAt) || b.id.localeCompare(a.id);
async function parallel<T>(values: T[], action: (value: T) => Promise<void>) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (index < values.length) await action(values[index++]!);
  }));
}

// Fail before any write-method probes if this is not the intended deployed read-only artifact.
async function verifyPreview() {
  const meta = await json<{ preview?: { readOnly: boolean; exportedAt: string } }>("/api/site/meta");
  assert.equal(meta.preview?.readOnly, true, "Target is not a read-only preview");
  assert.equal(meta.preview.exportedAt, snapshot.generatedAt, "Target is not this exported snapshot");
}
await verifyPreview();

const pages = ["/", "/all", "/hot", ...ENABLED_REPORT_KINDS.map(kind => `/${kind}`), "/topics", "/papers", "/radar", "/leaderboard/history", "/starred", "/agent", "/agent?tab=rss", "/agent?tab=api", "/about", "/methodology", "/changelog", "/feedback", "/terms", "/privacy", "/more"];
await parallel(pages, path => check(`page ${path}`, async () => {
  const response = await get(path);
  const body = await response.text();
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.ok(body.includes(SITE.name));
  assert.match(body, /现有公开内容的快照/);
  assert.match(body, /手动更新/);
  assert.ok(body.includes(snapshot.generatedAt));
  if (path.startsWith("/agent")) assert.match(body, /服务正常/);
  if (path === "/papers") {
    assert.match(body, /论文索引/);
    if (!researchPapers.length) assert.match(body, /没有已公开的论文记录/);
  }
  if (path === "/radar") {
    assert.match(body, /评测雷达/);
    if (!researchEvents.length) assert.match(body, /当前没有符合筛选条件、可公开的变化事件/);
  }
  if (path === "/leaderboard/history") {
    assert.match(body, /模型评测记录/);
    assert.ok(htmlText(body).includes(`${historyDirectory.items.length} 个模型有可公开的评测记录`));
    if (!historyDirectory.items.length) assert.match(body, /当前还没有可公开的模型评测记录/);
  }
  if (path === "/feedback") {
    assert.match(body, /只读预览暂不接收反馈/);
    assert.doesNotMatch(body, /<form|<textarea|type="file"|id="fb-email"/);
  }
  if (path === "/terms" || path === "/privacy") {
    assert.match(body, /不发布未经确认的法律模板/);
    assert.doesNotMatch(body, /生效日期|不出售个人信息/);
  }
}));

if (!isReportKindEnabled("daily")) {
  for (const pathname of ["/daily", "/daily/archive", "/daily/2026-10-03"]) await check(`legacy report redirect ${pathname}`, async () => {
    const response = await get(pathname, 308);
    assert.equal(response.headers.get("location"), `/${FEATURES.reports.defaultKind}?from=daily`);
    await response.arrayBuffer();
  });
  for (const pathname of ["/feed/daily.xml", "/api/site/reports/daily", "/api/site/reports/daily/latest-page", "/api/site/reports/daily/2026-10-03", "/api/v1/dailies", "/api/v1/dailies/latest", "/api/v1/dailies/2026-10-03", "/api/v1/reports/daily", "/api/v1/reports/daily/latest"]) await check(`disabled report ${pathname}`, async () => {
    await (await get(pathname, 404)).arrayBuffer();
  });
}

const boardPages = LEADERBOARD_PUBLIC_BOARDS.map(key => key === "overall" ? "/leaderboard" : `/leaderboard/category/${key}`);
await parallel([...boardPages, "/leaderboard/rules", "/leaderboard/sources"], path => check(`leaderboard ${path}`, async () => {
  const response = await get(path, snapshot.capabilities.leaderboard ? 200 : 503);
  assert.ok((await response.text()).includes(SITE.name));
}));

// Full mode reads every item; representative mode keeps each type's size and time boundaries.
await parallel(itemIds, id => check(`item ${id}`, async () => {
  const detail = snapshot.corpus.items[id]!;
  const published = await json<typeof detail>(`/api/site/items/${id}`);
  assert.deepEqual(published, detail);
  if (detail.readingMode === "summary-only") assert.equal(published.body, null);
  const body = await (await get(`/items/${id}`)).text();
  const headings = [...body.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map(match => htmlText(match[1]!));
  assert.ok(headings.includes(detail.title), `${id}: title is missing from the rendered reading page`);
  assert.ok(body.includes(`rel="canonical" href="${snapshot.siteUrl}/items/${id}"`), `${id}: canonical origin`);
  await (await get(`/items/${id}/original`)).arrayBuffer();
}));

await check("pool pagination preserves the public 2,000-item browsing cap without duplicates", async () => {
  const found: string[] = [];
  let pages = 1;
  for (let page = 1; page <= pages; page++) {
    const result = await json<PoolResponse>(`/api/site/pool?page=${page}`);
    pages = result.pageCount;
    assert.equal(result.total, Math.min(2000, snapshot.corpus.poolItems.length));
    found.push(...ids(result.items));
  }
  assert.equal(new Set(found).size, found.length);
  assert.deepEqual(found, ids([...snapshot.corpus.poolItems].sort(byTime).slice(0, 2000)));
});

for (const category of CATEGORY_KEYS) await check(`category ${category}`, async () => {
  const page = await json<PoolResponse>(`/api/site/pool?category=${category}`);
  assert.equal(page.total, Math.min(2000, snapshot.corpus.poolItems.filter(item => item.category === category).length));
  assert.ok(page.items.every(item => item.category === category));
  await (await get(`/all?category=${category}`)).arrayBuffer();
});
for (const channel of ["news", "x", "firstParty"]) await check(`channel ${channel}`, async () => {
  const page = await json<PoolResponse>(`/api/site/pool?channel=${channel}`);
  const expected = snapshot.corpus.poolItems.filter(item => channel === "firstParty" ? snapshot.corpus.items[item.id]?.source.firstParty : item.channel === channel);
  assert.equal(page.total, Math.min(2000, expected.length));
});

const sample = snapshot.corpus.poolItems[0]!;
const queries = [...new Set([sample.title.slice(0, 12), "AI", "OpenAI agent", "% _", "不存在的搜索词preview-check-4f1c"] )];
for (const q of queries) for (const tab of ["time", "relevance"] as const) await check(`search ${tab} ${JSON.stringify(q)}`, async () => {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  const rank = (item: FeedItemSummary) => words.reduce((score, word) => score
    + (item.title.toLowerCase().includes(word) ? 6 : 0) + (snapshot.corpus.search[item.id]!.direct.includes(word) ? 3 : 0), 0);
  const matches = snapshot.corpus.poolItems.filter(item => words.every(word => {
    const text = snapshot.corpus.search[item.id]!;
    return text.direct.toLowerCase().includes(word) || tab === "relevance" && text.body.toLowerCase().includes(word);
  })).sort((a, b) => (tab === "relevance" ? rank(b) - rank(a) : 0) || byTime(a, b)).slice(0, 2000);
  const params = new URLSearchParams({ q, tab });
  const first = await json<PoolResponse>(`/api/site/pool?${params}`);
  assert.equal(first.total, matches.length);
  const found: FeedItemSummary[] = [...first.items];
  for (let page = 2; page <= first.pageCount; page++) found.push(...(await json<PoolResponse>(`/api/site/pool?${params}&page=${page}`)).items);
  assert.deepEqual(ids(found), ids(matches));
  await (await get(`/all?${params}`)).arrayBuffer();
  const data = await (await get(`/all.data?${params}`)).text();
  assert.ok(data.includes("routes/all"));
});

await check("timeline cursor pagination preserves every exported card", async () => {
  const found: string[] = [];
  let cursor: string | null = null;
  const visited = new Set<string>();
  do {
    const result: TimelineResponse = await json(`/api/site/timeline?limit=${cursor ? 40 : 2}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    found.push(...result.cards.map(card => card.key));
    cursor = result.nextCursor;
    assert.ok(!cursor || !visited.has(cursor), "cursor loop");
    if (cursor) visited.add(cursor);
  } while (cursor);
  assert.deepEqual(found, snapshotTimelineCards(snapshot, snapshot.corpus.timelineVariants["/api/site/timeline"]!).map(card => card.key));
});

// Fixed-path assertions cover report navigation, topics, group expansion, original bodies, Markdown,
// followups, feeds and leaderboard details. Only representative mode samples these repeated paths.
const dynamic = /^\/api\/site\/(?:pool|timeline)(?:\?|$)|^\/api\/(?:site|v1)\/(?:leaderboard-events|papers)(?:\?|$)|^\/api\/v1\/reports\/(?:daily|weekly|monthly)$/;
const fixedResponses = choose("fixedResponses", storedResponses.filter(([path]) => !dynamic.test(path) && path !== "/api/site/meta"), {
  key: ([path]) => path,
  group: ([path, saved]) => `${responseFamily(path)}|${saved.status}|${saved.contentType}`,
  size: ([, saved]) => jsonSize(saved), time: ([, saved]) => publicTimestamp(saved.body),
});
await parallel(fixedResponses, ([path, saved]) => check(`exported ${path}`, async () => {
  const response = await get(path, saved.status);
  assert.equal(response.headers.get("content-type")?.split(";")[0], saved.contentType.split(";")[0]);
  if (saved.status === 308) assert.equal(response.headers.get("location"), saved.headers?.Location);
  if (saved.status !== 200) { await response.arrayBuffer(); return; }
  if (typeof saved.body === "string") assert.equal(await response.text(), saved.body);
  else {
    const body = await response.json() as Record<string, unknown>;
    if (/\/(reports|developments)(?:\?|$)/.test(path) && body.revision) {
      const key = Array.isArray(body.reports) ? "reports" : "developments";
      const expected = saved.body as Record<string, unknown[]>;
      assert.deepEqual(body[key], expected[key]!.slice(0, key === "reports" ? 20 : 10));
    } else assert.deepEqual(body, saved.body);
  }
}));

const detailPages = new Set<string>();
const detailSources = new Map<string, (typeof storedResponses)[number]>();
for (const [path, saved] of storedResponses) {
  if (saved.status !== 200) continue;
  const url = new URL(path, base);
  const story = /^\/api\/site\/stories\/([^/]+)$/.exec(url.pathname);
  const topic = /^\/api\/site\/topics\/([^/]+)$/.exec(url.pathname);
  const report = /^\/api\/site\/reports\/(daily|weekly|monthly)\/([\dW-]+)$/.exec(url.pathname);
  const model = /^\/api\/site\/leaderboard\/models\/([^/]+)$/.exec(url.pathname);
  const source = /^\/api\/site\/leaderboard\/sources\/([^/]+)$/.exec(url.pathname);
  const page = story ? `/story/${story[1]}` : topic ? `/topics/${topic[1]}${url.searchParams.has("page") ? `/page/${url.searchParams.get("page")}` : ""}`
    : report && isReportKindEnabled(report[1]!) ? `/${report[1]}/${report[2]}` : model ? `/leaderboard/${model[1]}` : source ? `/leaderboard/sources/${source[1]}` : null;
  if (page) { detailPages.add(page); detailSources.set(page, [path, saved]); }
}
const sampledDetailPages = choose("detailPages", [...detailPages], {
  key: page => page, group: page => responseFamily(detailSources.get(page)![0]),
  size: page => jsonSize(detailSources.get(page)![1]), time: page => publicTimestamp(detailSources.get(page)![1].body),
});
await parallel(sampledDetailPages, page => check(`detail page ${page}`, async () => {
  assert.ok((await (await get(page)).text()).includes(SITE.name));
}));

async function researchPages<T extends { id: string }>(pathname: string, expected: T[], filters: Record<string, string> = {}) {
  const query = new URLSearchParams({ ...filters, limit: "100" });
  const seen = new Set<string>();
  let cursor: string | null = null, offset = 0;
  do {
    if (cursor) query.set("cursor", cursor);
    const page = await json<{ items: T[]; nextCursor: string | null }>(`${pathname}?${query}`);
    assert.deepEqual(page.items, expected.slice(offset, offset + 100));
    offset += page.items.length;
    assert.equal(Boolean(page.nextCursor), offset < expected.length);
    cursor = page.nextCursor;
    if (cursor) { assert.ok(!seen.has(cursor), `${pathname}: cursor loop`); seen.add(cursor); }
  } while (cursor);
  assert.equal(offset, expected.length);
}
await check("research API pagination and source/type/search filters match the complete snapshot", async () => {
  for (const prefix of ["/api/site", "/api/v1"]) {
    await researchPages(`${prefix}/papers`, researchPapers);
    await researchPages(`${prefix}/leaderboard-events`, researchEvents);
  }
  const event = researchEvents[0];
  if (event) {
    const filters = { source: event.sourceKey, type: event.type, ...(event.model ? { model: event.model.slug } : {}) };
    const expected = researchEvents.filter(value => value.sourceKey === event.sourceKey && value.type === event.type && (!event.model || value.model?.slug === event.model.slug));
    await researchPages("/api/v1/leaderboard-events", expected, filters);
  }
  const paper = researchPapers[0], material = paper ? paperDetail(paper.id).materials[0] : undefined;
  if (paper && material) {
    const filters = { sourceId: material.sourceId, q: paper.arxivId, ...(material.evaluationType ? { evaluationType: material.evaluationType } : {}) };
    const expected = researchPapers.filter(value => paperDetail(value.id).materials.some(row => row.sourceId === material.sourceId
      && (!material.evaluationType || row.evaluationType === material.evaluationType)
      && (value.arxivId.toLowerCase().includes(paper.arxivId.toLowerCase()) || row.title.toLowerCase().includes(paper.arxivId.toLowerCase()))));
    assert.ok(expected.some(value => value.id === paper.id));
    await researchPages("/api/v1/papers", expected, filters);
  }
  for (const pathname of ["/api/v1/papers?evaluationType=invalid-preview-type", "/api/v1/leaderboard-events?type=invalid-preview-type",
    "/api/v1/papers?cursor=invalid", "/api/v1/leaderboard-events?limit=101", "/api/site/papers?unexpected=value"]) await json(pathname, 400);
});

await parallel(sampledPapers, paper => check(`paper page and version history ${paper.id}`, async () => {
  const detail = paperDetail(paper.id);
  assert.equal(detail.id, paper.id); assert.equal(detail.arxivId, paper.arxivId);
  assert.equal(detail.latestVersion, paper.latestVersion);
  for (const prefix of ["/api/site", "/api/v1"]) {
    assert.deepEqual(savedJson(`${prefix}/papers/${encodeURIComponent(paper.id)}`), detail);
    const history = savedJson<PaperHistoryResponse>(`${prefix}/papers/${encodeURIComponent(paper.id)}/history`);
    assert.equal(history.paper.id, paper.id); assert.deepEqual(history.versions, detail.versions);
  }
  for (const material of detail.materials) assert.ok(snapshot.corpus.items[material.itemId], "Paper material lacks an exported public item");
  const text = htmlText(await (await get(`/papers/${encodeURIComponent(paper.id)}`)).text());
  assert.ok(text.includes(detail.title)); assert.ok(text.includes(detail.arxivId)); assert.ok(text.includes("版本与来源"));
}));
await parallel(sampledEvents, event => check(`radar page and evidence ${event.id}`, async () => {
  for (const prefix of ["/api/site", "/api/v1"]) assert.deepEqual(savedJson(`${prefix}/leaderboard-events/${encodeURIComponent(event.id)}`), event);
  const text = htmlText(await (await get(`/radar/${encodeURIComponent(event.id)}`)).text());
  assert.ok(text.includes(event.title)); assert.ok(text.includes(event.sourceName));
}));
await parallel(sampledHistories, history => check(`model history page independent of composite ranking ${history.model.slug}`, async () => {
  const entry = historyDirectory.items.find(model => model.slug === history.model.slug);
  assert.ok(entry); assert.equal(entry.name, history.model.name);
  assert.ok(history.series.some(series => series.points.length > 0));
  for (const prefix of ["/api/site", "/api/v1"]) assert.deepEqual(savedJson(`${prefix}/leaderboard-model-history/${encodeURIComponent(history.model.slug)}`), history);
  const text = htmlText(await (await get(`/leaderboard/${encodeURIComponent(history.model.slug)}/history`)).text());
  assert.ok(text.includes(history.model.name)); assert.ok(text.includes("来源原始分数"));
}));
await check("evaluation evidence APIs preserve permission-filtered item evidence", async () => {
  for (const item of evidenceItems) {
    for (const prefix of ["/api/site", "/api/v1"]) assert.deepEqual(savedJson<PublicEvaluationEvidence>(`${prefix}/items/${encodeURIComponent(item.id)}/evidence`), item.evidence);
    assert.ok(item.evidence!.claims.every(claim => claim.support.quote === null), "This preview does not license evidence quotations");
  }
  const withoutEvidence = expectedIds.find(id => !snapshot.corpus.items[id].evidence) ?? "missing-preview-research-evidence";
  await json(`/api/v1/items/${encodeURIComponent(withoutEvidence)}/evidence`, 404);
  if (!researchPapers.length) await json("/api/v1/papers/missing-preview-research-paper", 404);
  if (!researchEvents.length) await json("/api/v1/leaderboard-events/missing-preview-research-event", 404);
  if (!modelHistories.length) await json("/api/v1/leaderboard-model-history/missing-preview-research-model", 404);
});

await check("enabled reports preserve historical navigation, available citations and the 180-issue API limit", async () => {
  for (const kind of ENABLED_REPORT_KINDS) {
    const index = savedJson<{ items: ReportIndexEntry[] }>(`/api/site/reports/${kind}`).items;
    const saved = savedJson<{ items: { key: string }[] }>(`/api/v1/reports/${kind}`);
    const result = await json<{ kind: string; count: number; items: { key: string }[] }>(`/api/v1/reports/${kind}?limit=180`);
    assert.equal(result.kind, kind);
    assert.equal(result.count, Math.min(180, index.length));
    assert.deepEqual(result.items, saved.items.slice(0, 180));
    assert.deepEqual(result.items.map(item => item.key), index.slice(0, 180).map(item => item.key));
    const latest = await get(`/api/v1/reports/${kind}/latest`, index.length ? 200 : 404);
    if (index.length) assert.equal((await latest.json() as { report: { key: string } }).report.key, index[0]!.key);
    else await latest.arrayBuffer();
    const feed = await get(`/feed/${kind}.xml`);
    assert.match(feed.headers.get("content-type") ?? "", /xml/);
    assert.equal(await feed.text(), snapshotResponse(snapshot, `/feed/${kind}.xml`)?.body);
  }
  for (const [path, response] of storedResponses) {
    if (!/^\/api\/site\/reports\/(daily|weekly|monthly)\/[\dW-]+$/.test(path) || response.status !== 200) continue;
    const report = response.body as ReportDetail;
    assert.ok(isReportKindEnabled(report.kind), `${path}: disabled report leaked into the export`);
    for (const key of [report.prev, report.next]) if (key) savedJson(`/api/site/reports/${report.kind}/${key}`);
    const navigation = savedJson<{ items: { key: string }[] }>(`/api/site/reports/${report.kind}/navigation/${report.key}`);
    for (const entry of navigation.items) savedJson(`/api/site/reports/${report.kind}/${entry.key}`);
    for (const citation of [...report.highlights, ...report.stories, ...report.flashes, ...report.sections.flatMap(section => section.items)]) {
      if (citation.available && citation.itemId) assert.ok(snapshot.corpus.items[citation.itemId], `${path}: an available citation has no reading page`);
      if (!citation.available) { assert.equal(citation.summary, null); assert.equal(citation.sourceUrl, ""); }
    }
    savedJson(`/api/v1/reports/${report.kind}/${report.key}`);
  }
});

if (snapshot.capabilities.leaderboard) {
  await parallel([...LEADERBOARD_PUBLIC_BOARDS], key => check(`leaderboard ${key}: filters, model targets and client payload`, async () => {
    const board = await json<LbBoardResponse>(`/api/site/leaderboard/boards/${key}`);
    assert.deepEqual(board, savedJson(`/api/site/leaderboard/boards/${key}`));
    assert.equal(board.board.key, key);
    const all = [...board.entries, ...board.filterEntries];
    assert.equal(new Set(all.map(entry => entry.model.slug)).size, all.length);
    assert.ok(board.entries.length <= 30);
    for (const [domestic, weights] of [[true, false], [false, true], [true, true]]) {
      const shown = all.filter(entry => (!domestic || entry.access.domestic) && (!weights || !!entry.access.weightsUrl)).slice(0, 30);
      assert.ok(shown.every((entry, i) => i === 0 || shown[i - 1]!.rank <= entry.rank), `${key}: filter changed original ranking`);
      for (const entry of shown) {
        const model = savedJson<LbModelDetail>(`/api/site/leaderboard/models/${entry.model.slug}`);
        assert.equal(model.run.id, board.run.id);
        assert.equal(model.model.slug, entry.model.slug);
        if (key === "overall") assert.equal(model.overall.rank, entry.rank);
        else assert.equal(model.categories.find(category => category.key === key)?.rank, entry.rank);
      }
    }
    for (const entry of board.entries) savedJson(`/api/site/leaderboard/models/${entry.model.slug}`);
    for (const tab of board.tabs) savedJson(`/api/site/leaderboard/boards/${tab.key}`);
    const page = key === "overall" ? "/leaderboard" : `/leaderboard/category/${key}`;
    const html = await (await get(page)).text();
    assert.match(html, /国产厂商/); assert.match(html, /开放权重/);
    const data = await (await get(`${page}.data`)).text();
    for (const entry of all) assert.ok(data.includes(entry.model.slug), `${key}: client filtering lost ${entry.model.slug}`);
  }));
  const allModelResponses = storedResponses.filter(([path, saved]) => /^\/api\/site\/leaderboard\/models\/[^/]+$/.test(path) && saved.status === 200);
  const modelResponses = choose("leaderboardComparisons", allModelResponses, {
    key: ([path]) => path,
    group: ([, saved]) => { const model = saved.body as LbModelDetail; return `comparisons=${model.comparisons.length > 0}|evidence=${model.evidence.some(group => group.items.length > 0)}`; },
    size: ([, saved]) => jsonSize(saved), time: ([, saved]) => publicTimestamp(saved.body),
  });
  const modelPaths = new Set(modelResponses.map(([path]) => path));
  // Keep closure checks for every model offline; only repeated HTTP payload checks are sampled.
  await parallel(allModelResponses, ([path, saved]) =>
    check(`leaderboard evidence and comparisons ${path}${modelPaths.has(path) ? "" : " (snapshot closure)"}`, async () => {
      const model = saved.body as LbModelDetail;
      for (const category of model.categories) savedJson(`/api/site/leaderboard/boards/${category.key}`);
      for (const evidence of model.evidence.flatMap(group => group.items)) savedJson(`/api/site/leaderboard/sources/${evidence.sourceKey}`);
      for (const comparison of model.comparisons) {
        assert.ok(Number.isFinite(comparison.net) && Number.isFinite(comparison.sharedWeight));
        if (comparison.hasPage) savedJson(`/api/site/leaderboard/models/${comparison.model.slug}`);
        for (const row of comparison.rows) {
          savedJson(`/api/site/leaderboard/sources/${row.sourceKey}`);
          assert.equal(typeof row.mine, "string"); assert.equal(typeof row.theirs, "string");
          assert.ok(Number.isFinite(row.weight));
        }
      }
      if (modelPaths.has(path)) {
        const data = await (await get(`/leaderboard/${model.model.slug}.data?from=coding`)).text();
        for (const comparison of model.comparisons) assert.ok(data.includes(comparison.model.slug), `${path}: client comparison payload is missing`);
      }
    }));
  await check("leaderboard source rows link only to exported models from the same published run", async () => {
    for (const [path, saved] of storedResponses) {
      if (!/^\/api\/site\/leaderboard\/sources\/[^/]+$/.test(path) || saved.status !== 200) continue;
      const source = saved.body as LbSourceDetail;
      for (const row of source.rows) if (row.modelSlug) assert.equal(savedJson<LbModelDetail>(`/api/site/leaderboard/models/${row.modelSlug}`).run.id, source.run.id);
    }
  });
}

const media = new Map<string, [number, number] | null>([
  ["/og/site.png", [1200, 630]], ["/favicon.ico", null], ["/icon.png", null], ["/icon-192.png", null], ["/apple-icon.png", null], ["/logo.svg", null],
]);
for (const id of expectedIds) { media.set(`/og/items/${id}.png`, [1200, 630]); media.set(`/og/posters/${id}.png`, [1080, 1440]); }
for (const page of detailPages) {
  if (page.startsWith("/story/")) media.set(page.replace("/story/", "/og/stories/") + ".png", [1200, 630]);
  if (/^\/topics\/[^/]+$/.test(page)) media.set(`/og${page}.png`, [1200, 630]);
  if (/^\/(daily|weekly|monthly)\//.test(page)) media.set(`/og/reports${page}.png`, [1200, 630]);
}
for (const directory of ["model-providers", "leaderboard-sources"]) for (const file of readdirSync(path.join(import.meta.dirname, "..", "assets", directory))) {
  if (/^[a-z0-9-]+\.(svg|png)$/.test(file)) media.set(`/${directory}/${file}`, null);
}
// Include the static page-card family in cross-runtime sampling without changing the full suite.
if (coverage === "representative") for (const file of readdirSync(path.join(import.meta.dirname, "..", "apps/web/build-cloudflare/client/og/pages"))) {
  if (/^[a-z0-9-]+\.png$/.test(file)) media.set(`/og/pages/${file}`, [1200, 630]);
}
const mediaSamples = choose("images", [...media], {
  key: ([path]) => path,
  group: ([file]) => file.startsWith("/og/reports/") ? file.replace(/\/[^/]+\.png$/, "/:period.png")
    : file.split("/").length <= 2 || file === "/og/site.png" ? file : `${file.slice(0, file.lastIndexOf("/"))}/*${path.extname(file)}`,
  size: ([file]) => statSync(path.join(import.meta.dirname, "..", "apps/web/build-cloudflare/client", file)).size,
  time: ([file]) => { const id = /\/og\/(?:items|posters)\/([^/]+)\.png$/.exec(file)?.[1];
    if (id) return publicTimestamp(snapshot.corpus.items[id]);
    const story = /^\/og\/stories\/([^/]+)\.png$/.exec(file)?.[1];
    return story ? publicTimestamp(snapshotResponse(snapshot, `/api/site/stories/${story}`)?.body) : ""; },
});
await parallel(mediaSamples, ([path, size]) => check(`public image ${path}`, async () => {
  const response = await get(path);
  assert.match(response.headers.get("content-type") ?? "", /image\//);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(bytes.length > 20);
  if (size) {
    assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.deepEqual([view.getUint32(16), view.getUint32(20)], size);
    assert.match(response.headers.get("cache-control") ?? "", /max-age=300/);
  }
}));

await check("fingerprinted frontend assets are immutable and not HTML fallbacks", async () => {
  const body = await (await get("/")).text();
  const resources = [...new Set([...body.matchAll(/(?:href|src)="(\/assets\/[^"?]+\.(?:js|css))"/g)].map(match => match[1]!))];
  assert.ok(resources.length > 0);
  for (const resource of resources) {
    const response = await get(resource);
    assert.match(response.headers.get("cache-control") ?? "", /max-age=31536000.*immutable/);
    assert.doesNotMatch(response.headers.get("content-type") ?? "", /text\/html/);
    await response.arrayBuffer();
  }
});

await check("single-fetch ignores route subsets and preserves real 404s", async () => {
  for (const path of ["/_.data", "/all.data?q=AI", "/about.data"]) {
    const separator = path.includes("?") ? "&" : "?";
    const full = await (await get(path)).text();
    const rootOnly = await (await get(`${path}${separator}_routes=root`)).text();
    assert.equal(rootOnly, full);
  }
  await (await get("/items/missing-preview-404.data?_routes=root", 404)).arrayBuffer();
  await (await get("/missing-preview-404", 404)).arrayBuffer();
});

await check("selected snapshot, changes, ETag, HEAD and CORS", async () => {
  type Selected = { items: { id: string }[]; cursor: string; nextPage: string | null; hasMore: boolean };
  const found: string[] = [];
  let page: string | null = null, cursor = "";
  do {
    const result: Selected = await json(`/api/v1/selected/snapshot?fields=minimal&limit=7${page ? `&page=${encodeURIComponent(page)}` : ""}`);
    found.push(...ids(result.items)); cursor ||= result.cursor;
    assert.equal(result.cursor, cursor);
    page = result.nextPage;
    assert.equal(Boolean(page), result.hasMore);
  } while (page);
  assert.deepEqual(sorted(found), sorted(ids(snapshot.corpus.poolItems.filter(item => item.selected))));
  const changes = await json<{ count: number; changes: unknown[] }>(`/api/v1/selected/changes?cursor=${encodeURIComponent(cursor)}`);
  assert.equal(changes.count, 0); assert.deepEqual(changes.changes, []);
  await json("/api/v1/selected/changes?cursor=invalid", 409);
  const response = await get("/api/v1/items?mode=all&window=7d");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const etag = response.headers.get("etag"); assert.ok(etag); await response.arrayBuffer();
  await (await get("/api/v1/items?mode=all&window=7d", 304, { headers: { "If-None-Match": etag } })).arrayBuffer();
  assert.equal(await (await get("/api/v1/items", 200, { method: "HEAD" })).text(), "");
  await (await get("/api/v1/items", 204, { method: "OPTIONS" })).arrayBuffer();
});

for (const path of ["/api/health", "/api/v1/hot-topics", ...ENABLED_REPORT_KINDS.map(kind => `/api/v1/reports/${kind}`), "/llms.txt", "/robots.txt", "/sitemap.xml", "/manifest.webmanifest", "/openapi-v1.json"]) await check(`machine ${path}`, async () => {
  const response = await get(path);
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (path.endsWith(".txt")) assert.match(type, /text\/plain/);
  else if (path.endsWith(".xml")) { assert.match(type, /xml/); assert.ok(text.includes(snapshot.siteUrl)); }
  else { assert.match(type, /json|manifest/); assert.ok(JSON.parse(text)); }
  if (path === "/robots.txt") assert.match(text, /Disallow:\s*\//);
  if (path === "/openapi-v1.json") { const spec = JSON.parse(text); assert.match(spec.openapi, /^3\.1\./); assert.ok(spec.paths["/api/v1/items"]); }
});
for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/openid-configuration"]) await check(`anonymous discovery ${path}`, async () => {
  const response = await get(path, 404);
  assert.doesNotMatch(response.headers.get("content-type") ?? "", /text\/html/);
  await response.arrayBuffer();
});

for (const path of ["/admin", "/admin.data", "/admin/login", "/admin/login.data", "/%61dmin.data", "/admin/sources.data?_routes=root", "/sources", "/api/admin/sources", "/api/auth/me", "/api/ingest", "/.env", "/.git/config"]) await check(`private route blocked ${path}`, async () => { await (await get(path, 404)).arrayBuffer(); });
// Re-check immediately before probing writes: the target must still be this read-only snapshot.
await verifyPreview();
for (const [method, path] of [["POST", "/api/site/feedback"], ["POST", "/api/site/feedback/uploads"], ["POST", "/all.data"], ["PUT", "/api/v1/items"], ["DELETE", "/api/site/items/missing-preview-404"]]) await check(`write blocked ${method} ${path}`, async () => {
  await (await get(path!, 405, { method, headers: { "Content-Type": "application/json" }, body: "{}" })).arrayBuffer();
});

async function rpc(method: string, params: unknown, id: number) {
  const response = await get("/api/mcp", 200, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream") ? text.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5))).find(value => value.id === id) : JSON.parse(text);
  assert.equal(payload.id, id); assert.equal(payload.error, undefined);
  return payload.result;
}
await check(`MCP initializes and exposes all ${MCP_TOOLS.length} enabled read-only tools`, async () => {
  const result = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "preview-smoke", version: "1" } }, 1);
  assert.equal(result.serverInfo.name, SITE.mcpPrefix);
  const list = await rpc("tools/list", {}, 2);
  assert.deepEqual(sorted(list.tools.map((tool: { name: string }) => tool.name)), sorted(MCP_TOOLS.map(tool => tool.name)));
  assert.ok(list.tools.every((tool: { annotations?: { readOnlyHint?: boolean } }) => tool.annotations?.readOnlyHint));
});
const publicStory = storedResponses.find(([path, saved]) => /^\/api\/v1\/stories\/[^/]+$/.test(path) && saved.status === 200)?.[0].split("/").at(-1);
for (const [index, [name, args]] of ([
  [T.latest, { window: "7d", mode: "all" }], [T.search, { q: "AI", window: "7d" }], [T.hot, {}], [T.story, { public_id: publicStory ?? "missing-preview-story" }], ...ENABLED_REPORT_KINDS.map(kind => [T[kind], {}]),
] as Array<[string, Record<string, unknown>]>).entries()) await check(`MCP call ${name}`, async () => {
  const result = await rpc("tools/call", { name, arguments: args }, 10 + index);
  const reportKind = ENABLED_REPORT_KINDS.find(kind => name === T[kind]);
  if (name === T.story && !publicStory || reportKind && snapshotResponse(snapshot, `/api/v1/reports/${reportKind}/latest`)?.status === 404) assert.equal(result.isError, true);
  else { assert.notEqual(result.isError, true); assert.equal(result.structuredContent?._trust?.contentTrust, "untrusted_external_data"); }
});

let researchRpcId = 100;
async function researchTool(name: string, args: Record<string, unknown>, expected: unknown | null) {
  const result = await rpc("tools/call", { name, arguments: args }, researchRpcId++);
  if (expected === null) {
    assert.equal(result.isError, true); assert.equal(result.structuredContent?.error?.code, "not_found");
    return null;
  }
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent?._trust?.contentTrust, "untrusted_external_data");
  const { _trust: _discard, ...body } = result.structuredContent;
  assert.deepEqual(body, expected);
  return body;
}
for (const [name, expected] of [[T.radar, researchEvents], [T.papers, researchPapers]] as Array<[string, Array<LeaderboardEvent | PaperListItem>]>) {
  await check(`MCP research list ${name}`, async () => {
    const limit = 3;
    const result = await rpc("tools/call", { name, arguments: { limit } }, researchRpcId++);
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent?._trust?.contentTrust, "untrusted_external_data");
    assert.deepEqual(result.structuredContent.items, expected.slice(0, limit));
    assert.equal(Boolean(result.structuredContent.nextCursor), expected.length > limit);
    if (result.structuredContent.nextCursor) {
      const next = await rpc("tools/call", { name, arguments: { limit, cursor: result.structuredContent.nextCursor } }, researchRpcId++);
      assert.notEqual(next.isError, true); assert.deepEqual(next.structuredContent.items, expected.slice(limit, 2 * limit));
    }
  });
}
for (const paper of sampledPapers) await check(`MCP paper ${paper.id}`, async () => {
  await researchTool(T.paper, { id: paper.id }, paperDetail(paper.id));
});
if (!sampledPapers.length) await check("MCP paper reports an honest not_found on an empty index", async () => {
  await researchTool(T.paper, { id: "missing-preview-research-paper" }, null);
});
for (const item of sampledEvidence) await check(`MCP evidence ${item.id}`, async () => {
  await researchTool(T.evidence, { id: item.id }, item.evidence);
});
if (!sampledEvidence.length) await check("MCP evidence reports an honest not_found without public evidence", async () => {
  await researchTool(T.evidence, { id: expectedIds[0]! }, null);
});
for (const history of sampledHistories) await check(`MCP model history ${history.model.slug}`, async () => {
  await researchTool(T.modelHistory, { slug: history.model.slug }, history);
});
if (!sampledHistories.length) await check("MCP model history reports an honest not_found on an empty directory", async () => {
  await researchTool(T.modelHistory, { slug: "missing-preview-research-model" }, null);
});

await transport?.close();
console.log(JSON.stringify({ passed, failed, requests, concurrency, coverage, samples, seconds: Math.round((performance.now() - startedAt) / 1000), details: expectedIds.length, pool: snapshot.corpus.poolItems.length, generatedAt: snapshot.generatedAt, base, ...(versionOverride ? { versionOverride } : {}), ...(resolveIp ? { dnsOverride: resolveIp, tlsCertificateValidation: true } : {}) }));
process.exitCode = failed ? 1 : 0;
