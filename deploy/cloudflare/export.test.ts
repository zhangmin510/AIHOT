import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { assertPublicUrl, assertRealSource, assertSummaryOnlyItem, collectPublicPool, exportReportResponses, publicProjection, snapshotOutput, validatedDatabaseUrl } from "../../scripts/export-cloudflare-preview.ts";
import { canonicalKey } from "./snapshot.ts";
import type { FeedItemSummary, ReportDetail, ReportIndexEntry } from "../../packages/contracts/src/site.ts";
import { SITE } from "../../industry/site.ts";

test("export only accepts the reviewed local real-data database and forces server-side read-only defaults", () => {
  const url = validatedDatabaseUrl("postgres://reader@localhost:55432/evalfrontier_local?options=unsafe");
  assert.equal(url.hostname, "127.0.0.1");
  assert.match(url.searchParams.get("options")!, /default_transaction_read_only=on/);
  for (const input of ["postgres://127.0.0.1:55432/evalfrontier_full_public_20261003_test", "postgres://127.0.0.1:55432/run_ci",
    "postgres://db.example.org:55432/evalfrontier_local", "postgres://127.0.0.1:5432/evalfrontier_local", "https://127.0.0.1:55432/evalfrontier_local"]) {
    assert.throws(() => validatedDatabaseUrl(input), /requires the local/);
  }
});

test("capacity exports cannot overwrite the deployable snapshot or write arbitrary directories", () => {
  assert.equal(snapshotOutput([]).capacityOnly, false);
  const accepted = snapshotOutput(["--out", ".data/cloudflare-preview/capacity/in-progress.json"]);
  assert.equal(accepted.capacityOnly, true);
  assert.match(accepted.output, /\/capacity\/in-progress\.json$/);
  for (const file of [".data/cloudflare-preview/snapshot.json", ".data/cloudflare-preview/capacity/../snapshot.json", "/tmp/snapshot.json", ".data/cloudflare-preview/capacity/file.json.tmp", ".data/cloudflare-preview/capacity/sub/file.json"]) {
    assert.throws(() => snapshotOutput(["--out", file]), /only permits/);
  }
  assert.throws(() => snapshotOutput(["--out"]), /only permits/);
  assert.throws(() => snapshotOutput(["--other", ".data/cloudflare-preview/capacity/test.json"]), /only permits/);
});

test("public projection rejects fixture/private/signed URLs and removes expiring proxy images", () => {
  for (const input of ["http://127.0.0.1/x", "http://10.0.0.1/x", "http://169.254.169.254/", "http://[::1]/", "http://intranet/x",
    "https://host.internal/x", "https://host.local/x", "https://example.com/x", "https://real.example.net/x", "https://openai.com/?token=secret",
    "https://user:pass@openai.com/x", "file:///etc/passwd"]) assert.throws(() => assertPublicUrl(input));
  assert.doesNotThrow(() => assertPublicUrl("https://openai.com/index/news/"));
  const projected = publicProjection({ source: { iconUrl: "/api/img-proxy?u=source&sig=private", iconSrcSet: "private" },
    cover: { url: "/api/img-proxy?u=source&sig=private", width: 100 }, media: [{ url: "/api/img-proxy?u=source" }],
    body: '<p>Allowed public summary.</p><img src="/api/img-proxy?u=source">', spark: [null, 1, null] });
  assert.deepEqual(projected, { source: { iconUrl: null }, cover: null, media: [], body: "<p>Allowed public summary.</p>", spark: [null, 1, null] });
  assert.throws(() => publicProjection({ content: "postgres://user:password@db/data" }), /private/);
  assert.throws(() => assertRealSource({ id: "local-validation-one", source_id: "reviewed", title: "fixture", url: "https://openai.com/news" }, new Set(["reviewed"])), /fixture/);
  assert.throws(() => assertRealSource({ id: "real", source_id: "unreviewed", title: "Real news", url: "https://openai.com/news" }, new Set(["reviewed"])), /unreviewed/);
});

test("canonical keys share default query handling across exporter and Worker", () => {
  assert.equal(canonicalKey("/api/site/timeline?topic=&channel=all&tag=&category=agent"), "/api/site/timeline?category=agent");
  assert.equal(canonicalKey("/api/site/pool?tab=time&page=1&q=agent&channel=news"), "/api/site/pool?channel=news&q=agent");
});

test("this summary-only deployment rejects full text and X body projections before export", () => {
  assert.doesNotThrow(() => assertSummaryOnlyItem({ body: null, x: null }));
  assert.throws(() => assertSummaryOnlyItem({ body: { original: "Unlicensed body", zh: null, zhKind: null, complete: true }, x: null }), /summaries only/);
  assert.throws(() => assertSummaryOnlyItem({ body: null, x: {} as never }), /summaries only/);
});

test("complete pool export crosses 2,000 items and rejects repeated or broken continuations", async () => {
  const all = Array.from({ length: 2501 }, (_, i): FeedItemSummary => ({ id: `item-${i}`, title: `Title ${i}`, summary: "Public summary", reason: null,
    source: { name: "Source" }, publishedAt: null, timelineAt: "2026-11-04T00:00:00.000Z", category: null, tags: [], score: null, selected: false, channel: "news", x: null }));
  const collected = await collectPublicPool(async after => {
    const start = after ? Number(after.id.slice(5)) + 1 : 0;
    const items = all.slice(start, start + 500);
    return { items, next: start + items.length < all.length ? { id: items.at(-1)!.id, at: "2026-11-04 00:00:00+00" } : null };
  });
  assert.deepEqual(collected, all);
  await assert.rejects(collectPublicPool(async () => ({ items: [all[0]!], next: { id: all[0]!.id, at: "same" } })), /repeated public item/);
  await assert.rejects(collectPublicPool(async () => ({ items: [], next: { id: "missing", at: "same" } })), /invalid continuation/);
});

test("report export follows enabled monthly neighbors beyond the index without reading disabled daily", async () => {
  const stamp = "2026-11-04T00:00:00.000Z";
  const keys = Array.from({ length: 405 }, (_, i) => `${1992 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, "0")}`);
  const index: ReportIndexEntry[] = keys.slice(-400).reverse().map(key => ({ key, title: `Issue ${key}`, generatedAt: stamp, count: 0 }));
  const read = new Set<string>();
  const responses = new Map<string, any>();
  const v1 = (key: string) => ({ schemaVersion: 1 as const, report: { kind: "monthly" as const, key: key === "latest" ? keys.at(-1)! : key,
    title: key, headline: null, overview: null, generatedAt: stamp, windowStart: stamp, windowEnd: stamp, revision: 1,
    links: { aihot: "/monthly" }, attribution: { name: SITE.name, url: "/monthly" }, lead: null, sections: [], stories: [], flashes: [] } });
  const reader: Parameters<typeof exportReportResponses>[0] = {
    listReports: async kind => { assert.notEqual(kind, "daily"); return kind === "monthly" ? index : []; },
    loadReport: async (kind, key): Promise<ReportDetail | null> => {
      assert.equal(kind, "monthly"); assert.ok(!read.has(key), "an issue should be read once"); read.add(key);
      const at = keys.indexOf(key); if (at < 0) return null;
      return { kind, key, title: key, windowStart: stamp, windowEnd: stamp, generatedAt: stamp, revision: 1,
        lead: null, overview: null, highlights: [], sections: [], stories: [], flashes: [], cover: null, metrics: {}, readingMinutes: 1,
        prev: keys[at - 1] ?? null, next: keys[at + 1] ?? null };
    },
    reportNavigation: (_kind, entries) => entries.map(({ key }) => ({ key })),
    loadReportMonth: async () => { throw new Error("Disabled daily archive must not be read"); },
    v1Dailies: async () => { throw new Error("Disabled daily must not be read"); },
    v1Daily: async () => { throw new Error("Disabled daily must not be read"); },
    v1Reports: async (kind, limit) => { assert.equal(limit, 180); const items = kind === "monthly" ? index.slice(0,limit).map(entry => ({
      kind, key: entry.key, title: entry.title, generatedAt: stamp, links: { aihot: `/monthly/${entry.key}` }, attribution: { name: SITE.name, url: `/monthly/${entry.key}` }
    })) : []; return { schemaVersion: 1, kind, count: items.length, items }; },
    v1Report: async (kind, key) => kind === "monthly" ? v1(key ?? "latest") : null,
  };
  assert.equal(await exportReportResponses(reader, (path, body) => { responses.set(path, body); }), true);
  assert.equal(read.size, 405);
  assert.equal(responses.get("/api/site/reports/monthly").items.length, 400);
  assert.equal(responses.get("/api/v1/reports/monthly").items.length, 180);
  assert.ok(![...responses.keys()].some(path => /daily|dailies/.test(path)));
  for (const key of keys) {
    const report = responses.get(`/api/site/reports/monthly/${key}`);
    for (const neighbor of [report.prev, report.next]) if (neighbor) assert.ok(responses.has(`/api/site/reports/monthly/${neighbor}`));
    assert.ok(responses.has(`/api/v1/reports/monthly/${key}`));
    assert.ok(responses.has(`/api/site/reports/monthly/navigation/${key}`));
  }
  await assert.rejects(exportReportResponses({ ...reader, loadReport: async () => null }, () => {}), /invalid public navigation/);
});

test("export process denies external sockets, HTTP, DNS, subprocesses and inherited credentials", () => {
  const script = `
    import assert from 'node:assert/strict';
    import net from 'node:net'; import http from 'node:http'; import https from 'node:https';
    import dns from 'node:dns'; import dnsPromises from 'node:dns/promises'; import cp from 'node:child_process';
    import { prepareEnvironment, validatedDatabaseUrl } from './scripts/export-cloudflare-preview.ts';
    process.env.OPENAI_API_KEY='deliberate-test-secret'; process.env.FEISHU_CONTENT_PUSH_ENABLED='true';
    prepareEnvironment(validatedDatabaseUrl('postgres://reader@127.0.0.1:55432/evalfrontier_local'));
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    for (const k of ['COLLECT_ENABLED','MODEL_CALLS_ENABLED','FEISHU_INTERNAL_ENABLED','FEISHU_CONTENT_PUSH_ENABLED','INDEXNOW_SUBMIT_ENABLED']) assert.equal(process.env[k], 'false');
    for (const action of [() => net.connect(443,'1.1.1.1'), () => new net.Socket().connect({port:443,host:'api.openai.com'}),
      () => net.connect(5432,'127.0.0.1'), () => http.get('http://example.com'), () => https.request('https://api.openai.com'),
      () => fetch('https://api.openai.com'), () => dns.lookup('api.openai.com',()=>{}), () => dnsPromises.resolve('api.openai.com'),
      () => cp.spawn('node',['-e','0'])]) assert.throws(action);
    console.log('guard verified');
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("../..", import.meta.url), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "guard verified");
});

test("discovery documents use only snapshot projections, preserve empty states and explain frozen time", () => {
  const script = String.raw`
    import assert from 'node:assert/strict'; import net from 'node:net';
    import { prepareEnvironment, validatedDatabaseUrl, addDiscoveryResponses } from './scripts/export-cloudflare-preview.ts';
    prepareEnvironment(validatedDatabaseUrl('postgres://reader@127.0.0.1:55432/evalfrontier_local'));
    net.Socket.prototype.connect=()=>{throw new Error('No database or network access is permitted')};
    const snapshot={generatedAt:'2026-11-04T12:00:00.000Z',contentUpdatedAt:'2026-10-02T12:00:00.000Z',siteUrl:'https://b.zhangmin.name',
      capabilities:{leaderboard:false,reports:false},responses:{},corpus:{items:{visible:{id:'visible',indexable:true},hidden:{id:'hidden',indexable:false}}}};
    await addDiscoveryResponses(snapshot);
    assert.equal(snapshot.generatedAt,'2026-11-04T12:00:00.000Z');
    const llms=snapshot.responses['/llms.txt'].body;
    assert.match(llms,/snapshot_required/); assert.match(llms,/不自动采集/);
    assert.doesNotMatch(llms,/每天 08:00/);
    const sitemap=snapshot.responses['/sitemap.xml'].body;
    assert.match(sitemap,/items\/visible/); assert.doesNotMatch(sitemap,/items\/hidden|leaderboard/);
    const spec=snapshot.responses['/openapi-v1.json'].body;
    assert.equal(spec.servers[0].url,'https://b.zhangmin.name');
    assert.match(spec.info.description,/导出时钟/);
    assert(!Object.keys(spec.paths).some(p=>p.includes('codex-resets')));
    assert(!JSON.stringify(spec).includes('{{'));
    console.log('discovery verified');
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("../..", import.meta.url), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "discovery verified");
});
