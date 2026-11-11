// Reports through the public read layer: website DTOs and the v1 shapes. Only real reports are
// listed; a missing date is a 404, never another day. Withdrawn citations are marked, not shown.
import type { ReportCitation, ReportDetail, ReportIndexEntry, ReportNavigationEntry, ReportKind } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { cached, type Cached } from "../lib/cache.ts";
import { proxiedImage, proxiedImageSet } from "../media/imgproxy.ts";
import { dailyUrl, itemUrl, siteUrl } from "./links.ts";
import { SITE, withSubject } from "@aihot/industry/site";
import { CONTENT_SCOPE } from "@aihot/industry/scope";
import { publicScopeCondition } from "../content/scope.ts";
import { isReportKindEnabled } from "@aihot/industry/features";

export type { ReportKind };

interface ReportRow {
  kind: ReportKind;
  key: string;
  window_start: Date;
  window_end: Date;
  content: Record<string, any>;
  generated_at: Date;
  revision: number;
}

interface Availability {
  available: boolean;
  firstParty: boolean;
  sourceId: string | null;
  sourceIcon: string | null;
  storyPublicId: string | null;
  publishedAt: Date | null;
  title: string;
  summary: string | null;
  sourceName: string;
  sourceUrl: string;
}

/** A strict issue exists publicly only while at least one current citation is approved. */
export function publicReportCondition() {
  return CONTENT_SCOPE.requireExplicitPass ? sql`EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(jsonb_path_query_array(reports.content, '$.**.itemId')) AS citation(id)
    JOIN publications p ON p.article_id = citation.id
    WHERE p.visibility = 'public' AND p.eligible AND ${publicScopeCondition()})` : sql`true`;
}

async function availability(ids: string[]): Promise<Map<string, Availability>> {
  const out = new Map<string, Availability>();
  if (ids.length === 0) return out;
  const rows = await sql<{ id: string; visibility: string; eligible: boolean; scope_pass: boolean; first_party: boolean; source_id: string; source_name: string; title: string; summary: string | null; url: string; icon_url: string | null; story_public_id: string | null; at: Date | null }[]>`
    SELECT p.article_id AS id, p.visibility, p.eligible, p.first_party, p.source_id, s.icon_url, st.public_id::text AS story_public_id,
      ${publicScopeCondition()} AS scope_pass, p.title, p.summary, p.url, s.name AS source_name,
      coalesce(p.published_at, p.discovered_at) AS at
    FROM publications p LEFT JOIN sources s ON s.id = p.source_id LEFT JOIN stories st ON st.id = p.story_id
    WHERE p.article_id IN ${sql(ids)}`;
  for (const r of rows) {
    out.set(r.id, {
      available: r.visibility === "public" && r.eligible && r.scope_pass,
      firstParty: r.first_party,
      sourceId: r.source_id,
      sourceIcon: r.icon_url,
      storyPublicId: r.story_public_id,
      publishedAt: r.at,
      title: r.title, summary: r.summary, sourceName: r.source_name, sourceUrl: r.url,
    });
  }
  return out;
}

/** Ids among `ids` that are no longer public. Ids absent from this database stay cited as published. */
export async function unavailableIds(ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Set();
  if (CONTENT_SCOPE.requireExplicitPass) {
    const avail = await availability(unique);
    return new Set(unique.filter(id => !avail.get(id)?.available));
  }
  const rows = await sql<{ id: string }[]>`
    SELECT article_id AS id FROM publications
    WHERE article_id = ANY(${unique}::text[]) AND (visibility <> 'public' OR NOT eligible)`;
  return new Set(rows.map((r) => r.id));
}

function reportCitations(content: Record<string, any>): Array<Record<string, any>> {
  return [
    ...(content.sections ?? []).flatMap((s: any) => s.items ?? []),
    ...(content.flashes ?? []),
    ...(content.themes ?? []).flatMap((t: any) => t.storyRefs ?? []),
  ];
}

/** Stored prose has no sentence-level citations. Hide dependent prose when its evidence is gone. */
function publicReportContent(content: Record<string, any>, kind: ReportKind, key: string, gone: Set<string>, avail?: Map<string, Availability>): Record<string, any> {
  if (CONTENT_SCOPE.requireExplicitPass) {
    // Stored prose/citation wording has no revision-bound provenance. Rehydrate approved evidence
    // from its current publication and omit old narrative instead of inferring that it is safe.
    const cite = (item: Record<string, any>) => {
      const a = item.itemId ? avail?.get(item.itemId) : null;
      return a?.available ? [{ itemId: item.itemId, title: a.title, summary: a.summary, sourceName: a.sourceName, sourceUrl: a.sourceUrl }] : [];
    };
    return {
      ...content, lead: null, headline: "", overview: null, metrics: {},
      title: `${SITE.name} ${kind === "weekly" ? "周报" : kind === "monthly" ? "月报" : "日报"} · ${key}`,
      sections: (content.sections ?? []).map((section: any) => ({ label: "本期内容", items: (section.items ?? []).flatMap(cite) })).filter((section: any) => section.items.length),
      themes: (content.themes ?? []).map((theme: any) => ({ heading: "本期内容", summary: null, storyRefs: (theme.storyRefs ?? []).flatMap(cite) })).filter((theme: any) => theme.storyRefs.length),
      flashes: (content.flashes ?? []).flatMap(cite),
    };
  }
  const unavailable = (item: Record<string, any>) => item.itemId && gone.has(item.itemId);
  if (!reportCitations(content).some(unavailable)) return content;
  return {
    ...content,
    lead: null,
    headline: "",
    overview: null,
    ...(kind === "daily" ? {} : { title: `${SITE.name} ${kind === "weekly" ? "周报" : "月报"} · ${key}` }),
    themes: (content.themes ?? []).map((theme: any) => (theme.storyRefs ?? []).some(unavailable) ? { ...theme, heading: "本期内容", summary: null } : theme),
  };
}

/** Directory/feed metadata only: citation summaries and full report prose stay in the detail read. */
export async function reportIndexRows(kind: ReportKind, limit: number) {
  if (!isReportKindEnabled(kind)) return [];
  return sql<{ key: string; content: Record<string, any>; generated_at: Date }[]>`
    SELECT key, generated_at, jsonb_build_object(
      'lead', content->'lead', 'headline', content->'headline', 'title', content->'title',
      'flashes', (SELECT coalesce(jsonb_agg(jsonb_build_object('itemId', item->'itemId')), '[]'::jsonb)
        FROM jsonb_array_elements(jsonb_path_query_array(content, '$.flashes[*]')) item),
      CASE WHEN kind = 'daily' THEN 'sections' ELSE 'themes' END,
      jsonb_build_array(jsonb_build_object(CASE WHEN kind = 'daily' THEN 'items' ELSE 'storyRefs' END,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('itemId', item->'itemId', 'title', item->'title') ORDER BY ord), '[]'::jsonb)
         FROM jsonb_array_elements(jsonb_path_query_array(content,
           CASE WHEN kind = 'daily' THEN '$.sections[*].items[*]'::jsonpath ELSE '$.themes[*].storyRefs[*]'::jsonpath END
         )) WITH ORDINALITY AS cited(item, ord))))) AS content
    FROM reports WHERE kind = ${kind} AND ${publicReportCondition()} ORDER BY key DESC LIMIT ${limit}`;
}

/**
 * A report's headline for indexes and feeds: its lead, else the first cited item that is still public.
 * `content` has already dropped prose whose citations are unavailable; `gone` covers the candidates.
 */
export function reportHeadline(content: Record<string, any>, kind: "daily" | "periodic", gone: Set<string>): string | null {
  if (kind === "daily" && content.lead?.title) return String(content.lead.title);
  if (kind === "periodic" && periodicHeadline(content)) return periodicHeadline(content);
  const items: Array<Record<string, any>> = kind === "daily" ? (content.sections ?? []).flatMap((s: any) => s.items ?? []) : (content.themes ?? []).flatMap((t: any) => t.storyRefs ?? []);
  const first = items.find((i) => !i.itemId || !gone.has(i.itemId));
  return first?.title ?? null;
}

/** A weekly or monthly's own headline; the composer's "<site> 周报 · 2026-W38" names the issue, not its news. */
function periodicHeadline(content: Record<string, any>): string | null {
  const text = String(content.headline ?? content.title ?? "");
  return text && !/^.+ [周月]报 · \d{4}-/.test(text) ? text : null;
}

function citationFrom(raw: Record<string, any>, avail: Map<string, Availability>): ReportCitation {
  const id = raw.itemId ?? null;
  const a = id ? avail.get(id) : undefined;
  // Items absent from this database (older than the imported window) stay cited as they were published.
  const available = id ? (a ? a.available : !CONTENT_SCOPE.requireExplicitPass) : !CONTENT_SCOPE.requireExplicitPass;
  if (!available) {
    // Withdrawn since: the reader sees a marked title; the summary and links are not sent at all.
    return {
      itemId: id, title: String(raw.title ?? ""), summary: null, sourceName: "", sourceUrl: "", sourceId: null, sourceIconUrl: null,
      firstParty: false, role: raw.role ?? null, storyPublicId: null, publishedAt: null, available: false,
    };
  }
  return {
    itemId: id,
    title: String(raw.title ?? ""),
    summary: raw.summary ?? null,
    sourceName: String(raw.sourceName ?? raw.source?.name ?? ""),
    sourceUrl: String(raw.sourceUrl ?? raw.links?.original ?? ""),
    sourceId: raw.sourceId ?? a?.sourceId ?? null,
    sourceIconUrl: a?.sourceIcon ? proxiedImage(a.sourceIcon, "avatar") : null,
    ...(a?.sourceIcon && proxiedImageSet(a.sourceIcon, "avatar") ? { sourceIconSrcSet: proxiedImageSet(a.sourceIcon, "avatar")! } : {}),
    firstParty: raw.firstParty ?? a?.firstParty ?? false,
    role: raw.role ?? null,
    storyPublicId: raw.storyPublicId ?? a?.storyPublicId ?? null,
    publishedAt: a?.publishedAt?.toISOString() ?? null,
    available,
  };
}

const bigrams = (text: string) => {
  const chars = [...text.toLowerCase().replace(/[\s\p{P}]/gu, "")];
  return new Set(chars.slice(1).map((ch, i) => chars[i] + ch));
};

/**
 * The item a daily's front page leads with. Without an editors' lead it is the first highlight (else
 * the first story), as the page sets it. The editors' lead is written about one of the items, so it is
 * the item whose title shares most of the lead's character pairs, if most of them are shared; a lead
 * that matches no item clearly has none.
 */
export function leadItemOf(leadTitle: string | undefined, highlights: ReportCitation[], all: ReportCitation[]): ReportCitation | undefined {
  if (!leadTitle) return highlights[0] ?? all[0];
  const want = bigrams(leadTitle);
  if (want.size === 0) return undefined;
  let best: { c: ReportCitation; share: number } | undefined;
  for (const c of all) {
    const have = bigrams(c.title);
    const share = [...want].filter((b) => have.has(b)).length / want.size;
    if (!best || share > best.share) best = { c, share };
  }
  return best && best.share >= 0.5 ? best.c : undefined;
}

/**
 * A picture for the front page's lead item: its own first sizeable image, else one from another public
 * report of the same event (first-hand first). Items shown as summaries only lend no pictures.
 */
async function leadCover(itemId: string): Promise<{ url: string; srcSet?: string; width: number | null; height: number | null } | null> {
  const [row] = await sql<{ m: { url: string; width?: number; height?: number } }[]>`
    SELECT img.m
    FROM publications p JOIN articles a ON a.id = p.article_id
    CROSS JOIN LATERAL (
      SELECT m FROM jsonb_array_elements(coalesce(a.media, '[]'::jsonb)) m
      WHERE m->>'kind' = 'image' AND coalesce((m->>'width')::numeric, 800) >= 480 LIMIT 1
    ) img
    WHERE (p.article_id = ${itemId} OR p.story_id = (SELECT parent.story_id FROM publications parent WHERE parent.article_id = ${itemId} AND ${publicScopeCondition(sql`parent.article_id`)}))
      AND p.visibility = 'public' AND p.eligible AND ${publicScopeCondition()} AND p.body_mode <> 'summary'
    ORDER BY (p.article_id = ${itemId}) DESC, p.first_party DESC, coalesce(p.score, 0) DESC, p.article_id
    LIMIT 1`;
  if (!row) return null;
  const url = proxiedImage(row.m.url, "full");
  if (!url) return null;
  return { url, ...(proxiedImageSet(row.m.url, "hero") ? { srcSet: proxiedImageSet(row.m.url, "hero")! } : {}), width: typeof row.m.width === "number" ? row.m.width : null, height: typeof row.m.height === "number" ? row.m.height : null };
}

function readingMinutes(text: string): number {
  return Math.max(1, Math.round([...text].length / 450));
}

async function neighbors(kind: ReportKind, key: string): Promise<{ prev: string | null; next: string | null }> {
  const [row] = await sql<{ prev: string | null; next: string | null }[]>`
    SELECT (SELECT key FROM reports WHERE kind = ${kind} AND ${publicReportCondition()} AND key < ${key} ORDER BY key DESC LIMIT 1) AS prev,
      (SELECT key FROM reports WHERE kind = ${kind} AND ${publicReportCondition()} AND key > ${key} ORDER BY key ASC LIMIT 1) AS next`;
  return { prev: row?.prev ?? null, next: row?.next ?? null };
}

export async function loadReport(kind: ReportKind, key: string): Promise<ReportDetail | null> {
  if (!isReportKindEnabled(kind)) return null;
  const [r] = await sql<ReportRow[]>`SELECT kind, key, window_start, window_end, content, generated_at, revision FROM reports WHERE kind = ${kind} AND key = ${key} AND ${publicReportCondition()}`;
  if (!r) return null;
  const rawItems = reportCitations(r.content);
  const avail = await availability([...new Set(rawItems.map((i) => i.itemId).filter(Boolean))]);
  const gone = new Set([...avail].filter(([, item]) => !item.available).map(([id]) => id));
  const c = publicReportContent(r.content, kind, key, gone, avail);
  if (CONTENT_SCOPE.requireExplicitPass && !reportCitations(c).length) return null;
  const cite = (raw: Record<string, any>) => citationFrom(raw, avail);

  const sections = kind === "daily"
    ? (c.sections ?? []).map((s: any) => ({ label: String(s.label), summary: null, items: (s.items ?? []).map(cite) }))
    : (c.themes ?? []).map((t: any) => ({ label: String(t.heading), summary: t.summary ?? null, items: (t.storyRefs ?? []).map(cite) }));
  const labelled: Array<ReportCitation & { label: string }> = sections.flatMap((s: { label: string; items: ReportCitation[] }) => s.items.map((i) => ({ ...i, label: s.label })));
  // Weekly and monthly reports carry the editor's reading order across themes.
  const order: string[] = Array.isArray(c.storyOrder) ? c.storyOrder : [];
  const rank = new Map(order.map((id, i) => [id, i]));
  const stories = order.length
    ? [...labelled].sort((a, b) => (rank.get(a.itemId ?? "") ?? order.length) - (rank.get(b.itemId ?? "") ?? order.length))
    : labelled;
  const all: ReportCitation[] = labelled;
  const highlightIds: string[] = c.highlights ?? [];
  const highlights = highlightIds.length
    ? highlightIds.map((id) => all.find((x: ReportCitation) => x.itemId === id)).filter((x): x is ReportCitation => !!x)
    : all.slice(0, 3);
  const text = [c.lead?.leadParagraph ?? "", c.overview ?? "", ...all.map((i: ReportCitation) => `${i.title}${i.summary ?? ""}`)].join("");
  // A weekly or monthly's picture comes from its first highlight and is captioned with that story.
  const leadItem = kind === "daily" ? leadItemOf(c.lead?.title, highlights, all) : (highlights[0] ?? all[0]);
  const [{ prev, next }, picture] = await Promise.all([neighbors(kind, key), leadItem?.itemId && leadItem.available ? leadCover(leadItem.itemId) : null]);
  const cover = picture && leadItem ? { ...picture, caption: kind === "daily" ? null : leadItem.title } : null;
  const headline = kind === "daily" ? null : periodicHeadline(c);
  const title = kind === "daily" ? `${withSubject("日报")} · ${key}` : String(c.title ?? (kind === "weekly" ? `${SITE.name} 周报 · ${key}` : `${SITE.name} 月报 · ${key}`));
  return {
    kind,
    key,
    title,
    windowStart: r.window_start.toISOString(),
    windowEnd: r.window_end.toISOString(),
    generatedAt: r.generated_at.toISOString(),
    revision: r.revision,
    lead: c.lead ?? (headline ? { title: headline, leadParagraph: String(c.overview ?? "") } : null),
    overview: c.overview ?? null,
    highlights,
    sections,
    stories,
    flashes: (c.flashes ?? []).map(cite),
    cover,
    metrics: c.metrics ?? {},
    readingMinutes: readingMinutes(text),
    prev,
    next,
  };
}

/**
 * Cache the newest 400 issues, but check citations on each read so a cached lead cannot outlive its
 * evidence. Archives, navigation and feeds all use the same filtered content.
 */
const INDEX_LIMIT = 400;
const indexes = new Map<ReportKind, Cached<Awaited<ReturnType<typeof reportIndexRows>>>>();
export async function reportIndex(kind: ReportKind) {
  if (!isReportKindEnabled(kind)) return { rows: [], gone: new Set<string>() };
  let entry = indexes.get(kind);
  if (!entry) {
    entry = cached(() => reportIndexRows(kind, INDEX_LIMIT), { freshMs: 60_000, maxStaleMs: 10 * 60_000 });
    indexes.set(kind, entry);
  }
  const rows = CONTENT_SCOPE.requireExplicitPass ? await reportIndexRows(kind, INDEX_LIMIT) : await entry.get();
  const ids = rows.flatMap((r) => reportCitations(r.content).map((item) => item.itemId)).filter(Boolean);
  const avail = CONTENT_SCOPE.requireExplicitPass ? await availability([...new Set(ids)]) : undefined;
  const gone = avail ? new Set(ids.filter(id => !avail.get(id)?.available)) : await unavailableIds(ids);
  return { rows: rows.map((r) => ({ ...r, content: publicReportContent(r.content, kind, r.key, gone, avail) }))
    .filter(r => !CONTENT_SCOPE.requireExplicitPass || reportCitations(r.content).length > 0), gone };
}

export async function listReports(kind: ReportKind, limit = INDEX_LIMIT): Promise<ReportIndexEntry[]> {
  const index = await reportIndex(kind);
  const rows = index.rows.slice(0, limit);
  const shape = kind === "daily" ? "daily" : "periodic";
  const gone = index.gone;
  return rows.map((r) => {
    const items = kind === "daily" ? (r.content.sections ?? []).flatMap((s: any) => s.items ?? []) : (r.content.themes ?? []).flatMap((t: any) => t.storyRefs ?? []);
    return {
      key: r.key,
      title: reportHeadline(r.content, shape, gone),
      generatedAt: r.generated_at.toISOString(),
      count: items.length,
    };
  });
}

// ---------------------------------------------------------------------------
// v1
// ---------------------------------------------------------------------------

const attribution = (url: string) => ({ name: SITE.name, url });

export async function v1Dailies(limit: number) {
  const index = await reportIndex("daily");
  const rows = index.rows.slice(0, limit);
  const gone = index.gone;
  const items = rows.map((r) => {
    const url = dailyUrl(r.key);
    return {
      date: r.key,
      generatedAt: r.generated_at.toISOString(),
      leadTitle: reportHeadline(r.content, "daily", gone),
      leadParagraph: r.content.lead?.leadParagraph ?? null,
      links: { aihot: url },
      attribution: attribution(url),
    };
  });
  return { schemaVersion: 1 as const, count: items.length, items };
}

export async function v1Daily(date: string | "latest") {
  if (!isReportKindEnabled("daily")) return null;
  const [r] = date === "latest"
    ? await sql<ReportRow[]>`SELECT kind, key, window_start, window_end, content, generated_at, revision FROM reports WHERE kind = 'daily' AND ${publicReportCondition()} ORDER BY key DESC LIMIT 1`
    : await sql<ReportRow[]>`SELECT kind, key, window_start, window_end, content, generated_at, revision FROM reports WHERE kind = 'daily' AND key = ${date} AND ${publicReportCondition()}`;
  if (!r) return null;
  const raw = reportCitations(r.content);
  const avail = await availability([...new Set(raw.map((i: any) => i.itemId).filter(Boolean))] as string[]);
  const gone = new Set([...avail].filter(([, item]) => !item.available).map(([id]) => id));
  const c = publicReportContent(r.content, "daily", r.key, gone, avail);
  const ok = (i: any) => !i.itemId || (avail.get(i.itemId)?.available ?? true);
  const links = (i: any) => ({ aihot: i.itemId ? itemUrl(i.itemId) : null, original: String(i.sourceUrl ?? "") });
  const url = dailyUrl(r.key);
  return {
    schemaVersion: 1 as const,
    report: {
      date: r.key,
      generatedAt: r.generated_at.toISOString(),
      windowStart: r.window_start.toISOString(),
      windowEnd: r.window_end.toISOString(),
      links: { aihot: url },
      attribution: attribution(url),
      lead: c.lead ? { title: String(c.lead.title), leadParagraph: String(c.lead.leadParagraph) } : null,
      sections: (c.sections ?? []).map((s: any) => ({
        label: String(s.label),
        items: (s.items ?? []).filter(ok).map((i: any) => ({
          title: String(i.title),
          summary: String(i.summary ?? ""),
          source: { name: String(i.sourceName ?? "") },
          links: links(i),
          attribution: attribution(i.itemId ? itemUrl(i.itemId) : url),
        })),
      })),
      flashes: (c.flashes ?? []).filter(ok).map((i: any) => ({
        title: String(i.title),
        source: { name: String(i.sourceName ?? "") },
        links: links(i),
        publishedAt: new Date(i.publishedAt ?? r.generated_at).toISOString(),
        attribution: attribution(i.itemId ? itemUrl(i.itemId) : url),
      })),
    },
  };
}

/** The same enabled report projection for API and MCP, including periodic editions. */
export async function v1Reports(kind: ReportKind, limit = 30) {
  const entries = await listReports(kind, limit);
  const items = entries.map((entry) => {
    const url = siteUrl(`/${kind}/${entry.key}`);
    return { kind, key: entry.key, title: entry.title, generatedAt: entry.generatedAt, links: { aihot: url }, attribution: attribution(url) };
  });
  return { schemaVersion: 1 as const, kind, count: items.length, items };
}

export async function v1Report(kind: ReportKind, key = "latest") {
  if (!isReportKindEnabled(kind)) return null;
  const resolved = key === "latest" ? (await listReports(kind, 1))[0]?.key : key;
  const report = resolved ? await loadReport(kind, resolved) : null;
  if (!report) return null;
  const url = siteUrl(`/${kind}/${report.key}`);
  const cite = (item: ReportCitation) => ({
    itemId: item.itemId, title: item.title, summary: item.summary,
    source: { name: item.sourceName },
    links: { aihot: item.itemId ? itemUrl(item.itemId) : null, original: item.sourceUrl },
    attribution: attribution(item.itemId ? itemUrl(item.itemId) : url),
  });
  return { schemaVersion: 1 as const, report: {
    kind, key: report.key, title: report.title, headline: report.lead?.title ?? null,
    overview: report.overview, generatedAt: report.generatedAt, windowStart: report.windowStart, windowEnd: report.windowEnd,
    revision: report.revision, links: { aihot: url }, attribution: attribution(url), lead: report.lead,
    sections: report.sections.map((section) => ({ label: section.label, summary: section.summary, items: section.items.filter((item) => item.available).map(cite) })),
    stories: report.stories.filter((item) => item.available).map(cite), flashes: report.flashes.filter((item) => item.available).map(cite),
  } };
}

export { siteUrl };

export function reportNavigation(kind: ReportKind, index: ReportIndexEntry[], key: string): ReportNavigationEntry[] {
  const at = index.findIndex((e) => e.key === key);
  return index.map((entry, n) => ({ key: entry.key,
    ...(kind !== "daily" || entry.key.slice(0, 7) === key.slice(0, 7) || n < 3 || Math.abs(n - at) <= 1 ? { title: entry.title } : {}),
  }));
}

export async function loadReportNavigation(kind: ReportKind, key: string) {
  return reportNavigation(kind, await listReports(kind), key);
}

export async function loadReportMonth(kind: ReportKind, month: string) {
  return (await listReports(kind)).filter((e) => e.key.startsWith(month)).map(({ key, title }) => ({ key, title }));
}
