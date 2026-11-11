import assert from "node:assert/strict";
import test from "node:test";
import { publicTimestamp, representativeSample, responseFamily } from "../../scripts/lib/preview-smoke-sampling.ts";

test("representative sampling keeps each group's size and time boundaries without mutation", () => {
  const values = Array.from({ length: 12 }, (_, i) => ({ id: `id${i}`, group: i < 10 ? "many" : "few", size: i === 3 ? 999 : i === 6 ? -1 : i, time: String(i).padStart(2, "0") }));
  const before = structuredClone(values);
  const options = { key: (v: typeof values[number]) => v.id, group: (v: typeof values[number]) => v.group, size: (v: typeof values[number]) => v.size, time: (v: typeof values[number]) => v.time };
  const sampled = representativeSample(values, options);
  assert.deepEqual(sampled.values.map(v => v.id), ["id0", "id3", "id6", "id9", "id10", "id11"]);
  assert.deepEqual(sampled.groups, [{ group: "few", total: 2, sampled: 2 }, { group: "many", total: 10, sampled: 4 }]);
  assert.deepEqual(values, before);
  assert.deepEqual(new Set(representativeSample([...values].reverse(), options).values.map(v => v.id)), new Set(sampled.values.map(v => v.id)));
});

test("response families retain states, filter shapes, board categories and report kinds", () => {
  assert.equal(responseFamily("/api/site/items/abc/original"), "/api/site/items/:id/original?");
  assert.notEqual(responseFamily("/api/site/items/abc"), responseFamily("/api/site/items/abc/original"));
  assert.equal(responseFamily("/api/site/groups/one/reports?topic=x&tag=y"), responseFamily("/api/site/groups/two/reports?tag=z&topic=q"));
  assert.notEqual(responseFamily("/api/site/groups/one/reports?topic=x"), responseFamily("/api/site/groups/one/reports?topic=x&tag=y"));
  assert.notEqual(responseFamily("/api/site/leaderboard/boards/coding"), responseFamily("/api/site/leaderboard/boards/overall"));
  assert.equal(responseFamily("/api/site/reports/weekly/navigation/2026-W40"), "/api/site/reports/weekly/navigation/:period?");
  assert.notEqual(responseFamily("/api/site/reports/daily/2026-10-01"), responseFamily("/api/site/reports/daily/latest-page"));
  assert.notEqual(responseFamily("/api/site/reports/daily/2026-10-01"), responseFamily("/api/site/reports/monthly/2026-10"));
});

test("empty collections remain empty and small route/status groups are not reduced", () => {
  const options = { key: (v: number) => String(v), group: (v: number) => v < 4 ? "200" : "404", size: (v: number) => v, time: () => "" };
  assert.deepEqual(representativeSample([], options), { values: [], groups: [] });
  assert.deepEqual(representativeSample([1, 2, 3, 4, 5], options).values, [1, 2, 3, 4, 5]);
});

test("research response families group IDs while retaining prefixes, subresources and filter shapes", () => {
  for (const prefix of ["/api/site", "/api/v1"]) {
    assert.equal(responseFamily(`${prefix}/papers/arxiv%3A2611.00123`), `${prefix}/papers/:id?`);
    assert.equal(responseFamily(`${prefix}/papers/arxiv%3A2611.00123/history`), `${prefix}/papers/:id/history?`);
    assert.equal(responseFamily(`${prefix}/leaderboard-events/event-one`), `${prefix}/leaderboard-events/:id?`);
    assert.equal(responseFamily(`${prefix}/leaderboard-model-history/model-one`), `${prefix}/leaderboard-model-history/:slug?`);
    assert.equal(responseFamily(`${prefix}/items/article-one/evidence`), `${prefix}/items/:id/evidence?`);
    assert.notEqual(responseFamily(`${prefix}/papers`), responseFamily(`${prefix}/papers/arxiv%3A2611.00123`));
    assert.notEqual(responseFamily(`${prefix}/papers/arxiv%3A2611.00123`), responseFamily(`${prefix}/papers/arxiv%3A2611.00123/history`));
    assert.notEqual(responseFamily(`${prefix}/leaderboard-model-histories`), responseFamily(`${prefix}/leaderboard-model-history/model-one`));
    assert.notEqual(responseFamily(`${prefix}/items/article-one`), responseFamily(`${prefix}/items/article-one/evidence`));
    assert.equal(responseFamily(`${prefix}/papers/arxiv%3A2611.00123/history?sourceId=one&q=x`), responseFamily(`${prefix}/papers/arxiv%3A2611.00999/history?q=y&sourceId=two`));
    assert.notEqual(responseFamily(`${prefix}/papers?sourceId=one`), responseFamily(`${prefix}/papers?sourceId=one&q=x`));
  }
  assert.notEqual(responseFamily("/api/site/papers/one/history"), responseFamily("/api/v1/papers/two/history"));
  assert.notEqual(responseFamily("/api/v1/papers/one"), responseFamily("/api/v1/leaderboard-events/two"));
});

test("research families keep status and content-type groups and their size/time boundaries", () => {
  const values = Array.from({ length: 8 }, (_, i) => ({ path: `/api/v1/papers/arxiv%3A2611.0000${i}/history`, status: 200, contentType: "application/json", size: i === 2 ? 1000 : i === 3 ? 0 : 20,
    body: { versions: [{ firstSeenAt: i === 6 ? "2026-01-01T00:00:00Z" : i === 5 ? "2026-11-06T00:00:00Z" : "2026-10-01T00:00:00Z" }] } }));
  values.push({ path: "/api/v1/papers/not-found/history", status: 404, contentType: "application/problem+json", size: 1, body: { versions: [] } });
  const selected = representativeSample(values, { key: row => row.path, group: row => `${responseFamily(row.path)}|${row.status}|${row.contentType}`, size: row => row.size, time: row => publicTimestamp(row.body) });
  assert.equal(selected.groups.length, 2);
  assert.deepEqual(selected.groups.map(group => [group.total, group.sampled]), [[8, 4], [1, 1]]);
  assert.deepEqual(selected.values.map(row => row.path), [values[2].path, values[3].path, values[5].path, values[6].path, values[8].path]);
});

test("radar and model history timestamps use public dates without fabricating unknown values", () => {
  assert.equal(publicTimestamp({ occurredAt: "2026-10-01T00:00:00Z", detectedAt: "2026-11-06T00:00:00Z" }), "2026-10-01T00:00:00Z");
  assert.equal(publicTimestamp({ detectedAt: "2026-11-06T00:00:00Z" }), "2026-11-06T00:00:00Z");
  assert.equal(publicTimestamp({ series: [{ points: [{ at: null }, { at: "2026-10-01T00:00:00Z" }] }, { points: [{ at: "2026-11-01T00:00:00Z" }] }] }), "2026-11-01T00:00:00Z");
  assert.equal(publicTimestamp({ series: [{ points: [{ at: null }] }] }), "");
  assert.equal(publicTimestamp({ checkedAt: "2026-11-06T00:00:00Z" }), "2026-11-06T00:00:00Z");
});

test("real story DTO timestamps preserve oldest and newest events independently of UUID and size", () => {
  const stories = [
    { publicId: "m-oldest", latestAt: "2026-09-30T10:00:00Z", firstReportAt: "2026-09-30T10:00:00Z", digestUpdatedAt: "2026-11-04T16:00:00Z", size: 30 },
    { publicId: "n-newest", latestAt: "2026-11-04T15:22:00Z", firstReportAt: "2026-11-01T10:00:00Z", digestUpdatedAt: "2026-11-04T16:00:00Z", size: 40 },
    { publicId: "a-smallest", latestAt: "2026-11-03T10:00:00Z", size: 1 },
    { publicId: "z-largest", latestAt: "2026-11-03T11:00:00Z", size: 999 },
    { publicId: "d-middle", latestAt: "2026-11-03T12:00:00Z", size: 20 },
  ];
  const sample = representativeSample(stories, { key: s => s.publicId, group: () => "story", size: s => s.size, time: publicTimestamp });
  assert.deepEqual(sample.values.map(s => s.publicId), ["m-oldest", "n-newest", "a-smallest", "z-largest"]);
  assert.equal(publicTimestamp(stories[0]), "2026-09-30T10:00:00Z");
  assert.equal(publicTimestamp({ reports: [{ publishedAt: "2026-10-01T00:00:00Z" }, { publishedAt: "2026-11-01T00:00:00Z" }] }), "2026-11-01T00:00:00Z");
  assert.equal(publicTimestamp({ items: [{ timelineAt: "2026-10-02T00:00:00Z" }] }), "2026-10-02T00:00:00Z");
  assert.equal(publicTimestamp({ developments: [{ latestAt: "2026-11-03T00:00:00Z" }] }), "2026-11-03T00:00:00Z");
});
