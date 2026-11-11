// Real production SSR with a local API fixture: withdrawn report citations never become navigation.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

let web: ChildProcess;
let origin: string;
let logs = '';
let withLead = false;
const apiPaths: string[] = [];
const gone = { itemId: 'withdrawn-item', title: '撤稿验收标题', summary: null, sourceName: '', sourceUrl: '', sourceId: null, sourceIconUrl: null, firstParty: false, role: null, storyPublicId: null, publishedAt: null, available: false };
const live = { ...gone, itemId: 'available-item', title: '公开验收标题', summary: '公开验收摘要', sourceName: '本地验收来源', sourceUrl: 'https://example.invalid/article', available: true };
const api = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const pathname = new URL(req.url!, 'http://api.local').pathname;
  apiPaths.push(pathname);
  if (pathname === '/api/site/meta') return res.end(JSON.stringify({ changelogVersion: '2026-10-03T00:00' }));
  if (pathname === '/api/health') return res.end(JSON.stringify({ ok: true }));
  if (pathname === '/api/site/reports/weekly/latest-page') return res.end(JSON.stringify({ index: [], report: null }));
  const reportPath = pathname.match(/^\/api\/site\/reports\/(weekly|monthly)\/(navigation\/)?(2026-W40|2026-10)$/);
  if (reportPath?.[2]) return res.end(JSON.stringify({ items: [{ key: reportPath[3], title: '本地验收刊物' }] }));
  if (reportPath) return res.end(JSON.stringify({
    kind: reportPath[1], key: reportPath[3], title: '本地验收刊物', windowStart: '2026-10-02T00:00:00Z', windowEnd: '2026-10-03T00:00:00Z', generatedAt: '2026-10-03T00:00:00Z', revision: 1,
    lead: withLead ? { title: '编辑导语', leadParagraph: '编辑导语正文' } : null, overview: null,
    highlights: [gone, live], sections: [{ label: '大模型', summary: null, items: [gone, live] }], stories: [gone, live], flashes: [gone, live], cover: null, metrics: {}, readingMinutes: 1, prev: null, next: null,
  }));
  res.statusCode = 404;
  res.end(JSON.stringify({ code: 'not_found' }));
});

before(async () => {
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  web = spawn(process.execPath, [fileURLToPath(new URL('../server.ts', import.meta.url))], {
    env: { ...process.env, WEB_PORT: '0', API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`web did not start: ${logs}`)), 15_000);
    web.on('exit', () => { clearTimeout(timeout); reject(new Error(`web exited: ${logs}`)); });
    web.stderr!.on('data', chunk => { logs += String(chunk); });
    web.stdout!.on('data', chunk => {
      logs += String(chunk);
      const match = logs.match(/"msg":"web started","port":(\d+)/);
      if (match) { origin = `http://127.0.0.1:${match[1]}`; clearTimeout(timeout); resolve(); }
    });
  });
});

after(async () => {
  if (web && web.exitCode === null) { web.kill('SIGTERM'); await once(web, 'exit'); }
  api.closeAllConnections();
  await new Promise<void>(resolve => api.close(() => resolve()));
});

for (const [kind, key] of [['weekly', '2026-W40'], ['monthly', '2026-10']]) for (const lead of [false, true]) test(`${kind}: withdrawn citations stay marked but have no links with ${lead ? 'an editorial' : 'a fallback'} lead`, async () => {
  withLead = lead;
  const response = await fetch(`${origin}/${kind}/${key}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /该内容已按来源方要求下架或调整展示方式/);
  assert.match(html, /href="\/items\/available-item"/);
  assert.doesNotMatch(html, /href="(?:\/items\/withdrawn-item|#r-withdrawn-item)"/);
  assert.doesNotMatch(html, /href=""/);
  assert.match(html, new RegExp(`<link rel="canonical" href="[^"]*/${kind}/${key}"`));
  assert.match(html, /href="\/weekly"/);
  assert.match(html, /href="\/monthly"/);
  assert.doesNotMatch(html, /href="\/daily(?:\/|"|\?)/);
  const frontPage = html.slice(html.indexOf('aria-label="头版"'), html.indexOf('id="s-1"'));
  assert.doesNotMatch(frontPage, /撤稿验收标题/);
  assert.match(frontPage, lead ? /编辑导语/ : /公开验收标题/);
});

test('legacy daily latest, archive and detail redirect before reading daily data', async () => {
  apiPaths.length = 0;
  for (const path of ['/daily', '/daily/archive', '/daily/2026-10-03']) {
    const response = await fetch(`${origin}${path}`, { redirect: 'manual' });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), '/weekly?from=daily');
  }
  assert.ok(apiPaths.every(path => !path.startsWith('/api/site/reports/daily')));
  const response = await fetch(`${origin}/weekly?from=daily`);
  const html = await response.text();
  assert.match(html, /本站已改为发布周报和月报/);
  assert.match(html, /<link rel="canonical" href="[^"?]*\/weekly"/);
});

test('Agent report documentation advertises only supported weekly and monthly interfaces', async () => {
  for (const [tab, expected] of [
    ['mcp', ['_get_weekly', '_get_monthly']],
    ['rss', ['/feed/weekly.xml', '/feed/monthly.xml']],
    ['api', ['/api/v1/reports/weekly', '/api/v1/reports/monthly']],
  ] as const) {
    const response = await fetch(`${origin}/agent?tab=${tab}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    for (const text of expected) assert.ok(html.includes(text), `missing ${text}`);
    assert.doesNotMatch(html, /_get_daily|\/feed\/daily\.xml|\/api\/v1\/dailies/);
    assert.doesNotMatch(html, /href="\/daily(?:\/|"|\?)/);
  }
});
