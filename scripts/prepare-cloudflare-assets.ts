// Offline share images and public brand assets for the read-only Worker. Never reads .env or a DB.
// Run after the Cloudflare web build and export-cloudflare-preview.ts.
import assert from "node:assert/strict";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { SITE, withSubject } from "@aihot/industry/site";
import { FEATURES } from "@aihot/industry/features";
import { CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import { beijingDate } from "@aihot/contracts/time";
import type { ReportDetail, StoryDetail } from "@aihot/contracts/site";
import type { OgCard } from "../apps/api/src/og/render.ts";
import { snapshotResponse, snapshotResponseEntries, validateSnapshot, validateSnapshotScope, type PreviewSnapshot } from "../deploy/cloudflare/snapshot.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUTPUT = path.join(ROOT, "apps/web/build-cloudflare/client");
const snapshot = JSON.parse(await readFile(path.join(ROOT, ".data/cloudflare-preview/snapshot.json"), "utf8")) as PreviewSnapshot;
assert.ok(snapshot.schemaVersion === 1 || snapshot.schemaVersion === 2);
validateSnapshot(snapshot);
validateSnapshotScope(snapshot);
assert.equal(snapshot.preview.readOnly, true);
assert.equal(snapshot.preview.capacityOnly, undefined, "An in-progress capacity artifact must not be prepared for deployment");
const origin = new URL(snapshot.siteUrl);
assert.equal(origin.protocol, "https:");
assert.equal(origin.username + origin.password + origin.port, "");
assert.ok(Object.keys(snapshot.corpus.items).length, "Cannot render an empty public snapshot");
assert.ok((await lstat(path.join(OUTPUT, "assets"))).isDirectory(), "Build the Cloudflare web bundle first");

// Only these renderer dependencies are imported after the environment is isolated. Prevent accidental
// HTTP/DB/subprocess work even if a renderer dependency changes; data: QR images are decoded locally.
const cacheDir = await mkdtemp(path.join(os.tmpdir(), "evalfrontier-preview-assets-"));
const keep = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "USER", "LOGNAME"]);
for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
Object.assign(process.env, {
  NODE_ENV: "development", SITE_URL: origin.origin, AIHOT_DATA_DIR: cacheDir,
  AIHOT_CREDENTIALS_DIR: path.join(cacheDir, "no-credentials"), COLLECT_ENABLED: "false",
  MODEL_CALLS_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false", FEISHU_CONTENT_PUSH_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false",
});
const denied = (): never => { throw new Error("Preview asset generation forbids network access and subprocesses"); };
const localFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  // Satori initializes its embedded WASM and QR images through data: URLs; neither opens a socket.
  return url.startsWith("data:") ? localFetch(input, init) : denied();
};
net.Socket.prototype.connect = denied;
http.request = denied; http.get = denied; https.request = denied; https.get = denied;
childProcess.spawn = denied; childProcess.spawnSync = denied; childProcess.exec = denied as unknown as typeof childProcess.exec;
childProcess.execSync = denied; childProcess.execFile = denied as unknown as typeof childProcess.execFile; childProcess.execFileSync = denied; childProcess.fork = denied;
syncBuiltinESMExports();

const safeSegment = (value: string) => {
  assert.match(value, /^[a-zA-Z0-9_-]+$/, "Unexpected public asset identifier");
  return value;
};
async function output(relative: string, bytes: string | Uint8Array) {
  const target = path.resolve(OUTPUT, relative);
  assert.ok(target.startsWith(`${OUTPUT}${path.sep}`));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}
let copied = 0, rendered = 0;
async function copy(source: string, relative: string) {
  assert.ok((await lstat(source)).isFile(), "Only regular public files may be copied");
  const target = path.resolve(OUTPUT, relative);
  assert.ok(target.startsWith(`${OUTPUT}${path.sep}`));
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
  copied++;
}

try {
  // A later export may withdraw articles. Never keep share images from the previous snapshot.
  for (const directory of ["og", "contact"]) await rm(path.join(OUTPUT, directory), { recursive: true, force: true });
  // Asset requests bypass the SSR Worker, so their preview and cache headers belong here.
  await output("_headers", `/*\n  X-Robots-Tag: noindex, nofollow\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Preview-Snapshot: ${snapshot.generatedAt}\n\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/og/*\n  Cache-Control: public, max-age=300, must-revalidate\n\n/model-providers/*\n  Cache-Control: public, max-age=86400\n\n/leaderboard-sources/*\n  Cache-Control: public, max-age=86400\n`);
  for (const file of ["favicon.ico", "icon.png", "icon-192.png", "apple-icon.png", "logo.svg"]) await copy(path.join(ROOT, "industry/brand", file), file);
  for (const directory of ["model-providers", "leaderboard-sources"]) {
    for (const file of await readdir(path.join(ROOT, "assets", directory))) {
      if (/^[a-z0-9-]+\.(?:svg|png)$/.test(file)) await copy(path.join(ROOT, "assets", directory, file), `${directory}/${file}`);
    }
  }
  // Contact media is copied only when explicitly referenced by the public snapshot and shipped in
  // the public industry pack. An unresolved reference fails the build instead of shipping a dead URL.
  const contact = snapshotResponse(snapshot, "/api/site/contact")?.body as Record<string, unknown> | undefined;
  for (const value of Object.values(contact ?? {})) {
    if (typeof value !== "string" || !value.startsWith("/contact/")) continue;
    const file = value.slice("/contact/".length);
    assert.match(file, /^[\w.-]+\.(?:png|jpg|jpeg|webp)$/);
    assert.ok(!file.includes(".."));
    await copy(path.join(ROOT, "industry/brand/contact", file), `contact/${file}`);
  }
  const { renderOg } = await import("../apps/api/src/og/render.ts");
  const { renderPoster } = await import("../apps/api/src/og/poster.ts");
  async function og(relative: string, card: OgCard) {
    await output(relative, (await renderOg(card)).png);
    rendered++;
  }
  await og("og/site.png", { kicker: SITE.name, title: SITE.tagline, subtitle: SITE.description });
  console.log(JSON.stringify({ stage: "brand-and-site-ready", copied, rendered }));

  const pages: Record<string, OgCard> = {
    all: { kicker: withSubject("动态"), title: "所有信源的最新动态，一站看完", subtitle: "按时间汇总各信源的最新动态，可按类别与标签筛选。" },
    hot: { kicker: "热点榜", title: "公开事件与来源", subtitle: "当前快照中的热点、趋势与公开报道。", accent: "hot" },
    daily: { kicker: withSubject("日报"), title: "每天值得关注的动态", subtitle: "已发布日报的公开快照。" },
    weekly: { kicker: withSubject("周报"), title: "一周大事，一次看清", subtitle: "本周的主线、重要发布与值得回看的讨论。" },
    monthly: { kicker: withSubject("月报"), title: "一个月的变化", subtitle: "月度主线与关键事件回顾。" },
    topics: { kicker: "主题", title: "长期追踪的方向", subtitle: "公司与机构、专题方向、内容形态。" },
    about: { kicker: "关于", title: `关于 ${SITE.name}`, subtitle: SITE.description },
    terms: { kicker: "使用规则", title: "预览状态", subtitle: "使用规则待运营者确认，当前不发布法律模板。" },
    privacy: { kicker: "隐私说明", title: "预览状态", subtitle: "隐私说明待运营者确认，当前不发布法律模板。" },
    changelog: { kicker: "更新日志", title: `${SITE.name} 更新日志`, subtitle: "功能更新、优化、公告与下线记录。" },
    feedback: { kicker: "反馈", title: "只读预览暂不接收反馈", subtitle: "反馈提交与截图上传尚未开放。" },
    agent: { kicker: "Agent 接入", title: `让 Agent 直接使用 ${SITE.name}`, subtitle: "MCP、RSS 与 REST API v1，匿名只读。" },
  };
  for (const kind of ["daily", "weekly", "monthly"] as const) if (!(FEATURES.reports.kinds as readonly string[]).includes(kind)) delete pages[kind];
  if (FEATURES.leaderboard) pages.leaderboard = { kicker: "模型榜", title: "多家公开评测的共识排名", subtitle: "公开评测的快照，缺测不补零。" };
  if (FEATURES.codexResetMonitor) pages["codex-reset"] = { kicker: "重置监控", title: "Codex 额度重置窗口", accent: "amber" };
  for (const [name, card] of Object.entries(pages)) await og(`og/pages/${name}.png`, card);

  const jobs: Array<() => Promise<void>> = [];
  for (const detail of Object.values(snapshot.corpus.items)) {
    const id = safeSegment(detail.id);
    const kicker = detail.category ? CATEGORY_LABELS[detail.category] : withSubject("动态");
    const source = detail.source.name.replace(/（[^）]*）\s*$/, "");
    const date = beijingDate(detail.timelineAt);
    jobs.push(() => og(`og/items/${id}.png`, { kicker, title: detail.title, subtitle: detail.summary, meta: `${source} · ${date}`, badge: detail.selected && detail.score !== null ? { value: String(Math.round(detail.score)), label: "精选评分" } : null }));
    jobs.push(async () => {
      const poster = { url: `${origin.origin}/items/${id}`, kicker, title: detail.title, summary: detail.summary, source, date, score: detail.selected ? detail.score : null };
      await output(`og/posters/${id}.png`, (await renderPoster(poster)).png);
      rendered++;
    });
  }
  for (const [route, response] of snapshotResponseEntries(snapshot)) {
    if (response.status !== 200) continue;
    const story = /^\/api\/site\/stories\/([^/?]+)$/.exec(route);
    const topic = /^\/api\/site\/topics\/([^/?]+)$/.exec(route);
    const report = /^\/api\/site\/reports\/(daily|weekly|monthly)\/([\dW-]+)$/.exec(route);
    if (story) {
      const data = response.body as StoryDetail;
      jobs.push(() => og(`og/stories/${safeSegment(story[1]!)}.png`, { kicker: data.whyHot.rank ? `热点第 ${data.whyHot.rank} · 事件` : "事件", title: data.title, subtitle: data.latest ?? data.digest, meta: `${data.sourceCount} 个来源 · ${data.reportCount} 篇报道`, accent: data.whyHot.rank ? "hot" : "teal" }));
    } else if (topic) {
      const data = response.body as { topic: { name: string; definition: string } };
      jobs.push(() => og(`og/topics/${safeSegment(topic[1]!)}.png`, { kicker: "主题", title: data.topic.name, subtitle: data.topic.definition }));
    } else if (report) {
      const data = response.body as ReportDetail;
      const label = { daily: "日报", weekly: "周报", monthly: "月报" }[data.kind];
      jobs.push(() => og(`og/reports/${data.kind}/${safeSegment(data.key)}.png`, { kicker: `${withSubject(label)} · ${data.key}`, title: data.lead?.title ?? data.title, subtitle: data.lead?.leadParagraph ?? data.overview, meta: `${data.stories.length} 条核心新闻 · 约 ${data.readingMinutes} 分钟读完` }));
    }
  }
  let next = 0, completed = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (next < jobs.length) {
      await jobs[next++]!();
      completed++;
      if (completed % 20 === 0) console.log(JSON.stringify({ stage: "rendering-public-content", completed, total: jobs.length }));
    }
  }));
  const current = JSON.parse(await readFile(path.join(ROOT, ".data/cloudflare-preview/snapshot.json"), "utf8")) as PreviewSnapshot;
  assert.equal(current.contentHash, snapshot.contentHash, "Snapshot changed while rendering. Rerun asset preparation for the final export.");
  console.log(JSON.stringify({ output: path.relative(ROOT, OUTPUT), generatedAt: snapshot.generatedAt, copied, rendered, outboundRequests: 0 }));
} finally {
  await rm(cacheDir, { recursive: true, force: true });
}
