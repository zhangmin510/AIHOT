// Every paper entry is derived only from currently listed publications. Private/withdrawn material
// cannot contribute a title, source, version or timestamp through the paper association graph.
import type { EvaluationType, PaperDetail, PaperHistoryResponse, PaperListItem, PaperListResponse, PaperMaterial, PaperRef, PaperVersion } from "@aihot/contracts/evaluation";
import { sql, type Db } from "../db.ts";
import { publicScopeCondition } from "../content/scope.ts";

interface PaperRow {
  paper_id: string; arxiv_id: string; canonical_url: string; version: number | null;
  item_id: string; title: string; source_id: string; source_name: string; source_url: string; discovered_at: Date;
  evaluation_type: EvaluationType | null;
}
const PUBLIC_PAPER_FROM = sql`FROM paper_materials pm JOIN papers paper ON paper.id=pm.paper_id
  JOIN publications p ON p.article_id=pm.article_id JOIN articles a ON a.id=p.article_id
  JOIN sources s ON s.id=p.source_id JOIN sources discovery_source ON discovery_source.id=pm.source_id
  LEFT JOIN article_evidence e ON e.analysis_id=p.analysis_id AND e.article_id=p.article_id AND e.input_revision=a.revision`;
const publicPaperCondition = (now: Date) => sql`p.visibility='public' AND p.eligible AND s.participation_mode='editorial' AND ${publicScopeCondition()}
  AND discovery_source.participation_mode='editorial' AND (NOT p.selected OR p.visible_after<=${now})`;

async function paperRows(ids: string[], now = new Date(), db: Db = sql): Promise<PaperRow[]> {
  if (!ids.length) return [];
  return db<PaperRow[]>`SELECT paper.id AS paper_id,paper.arxiv_id,paper.canonical_url,pm.version,
    p.article_id AS item_id,p.title,pm.source_id,discovery_source.name AS source_name,pm.source_url,pm.discovered_at,e.evaluation_type
    ${PUBLIC_PAPER_FROM} WHERE pm.paper_id=ANY(${ids}::text[]) AND ${publicPaperCondition(now)}
    ORDER BY pm.version DESC NULLS LAST,pm.discovered_at,p.article_id,pm.id`;
}

function material(row: PaperRow): PaperMaterial {
  return { itemId: row.item_id, sourceId: row.source_id, title: row.title, sourceName: row.source_name, sourceUrl: row.source_url,
    version: row.version, discoveredAt: row.discovered_at.toISOString(), evaluationType: row.evaluation_type };
}
function paperView(rows: PaperRow[]): PaperDetail {
  const first = rows[0]!;
  const versions = new Map<number | null, PaperVersion>();
  for (const row of rows) {
    const version = versions.get(row.version) ?? { version: row.version, firstSeenAt: row.discovered_at.toISOString(), materials: [] };
    if (row.discovered_at.toISOString() < version.firstSeenAt) version.firstSeenAt = row.discovered_at.toISOString();
    version.materials.push(material(row)); versions.set(row.version, version);
  }
  const seen = rows.map((row) => row.discovered_at.toISOString()).sort();
  const latestVersion = rows.reduce<number | null>((max, row) => row.version === null ? max : Math.max(max ?? 0, row.version), null);
  return { id: first.paper_id, arxivId: first.arxiv_id, title: first.title, canonicalUrl: first.canonical_url,
    version: latestVersion, latestVersion, firstSeenAt: seen[0]!, lastSeenAt: seen.at(-1)!,
    materialCount: new Set(rows.map((row) => row.item_id)).size,
    evaluationTypes: [...new Set(rows.map((row) => row.evaluation_type).filter((type): type is EvaluationType => type !== null))],
    materials: rows.map(material), versions: [...versions.values()] };
}
function ref(paper: PaperDetail, version = paper.version): PaperRef {
  return { id: paper.id, arxivId: paper.arxivId, title: paper.title, canonicalUrl: paper.canonicalUrl,
    version, latestVersion: paper.latestVersion };
}

export async function listPapers(options: { limit?: number; cursor?: string | null; evaluationType?: EvaluationType | null; sourceId?: string | null; q?: string | null; now?: Date } = {}): Promise<PaperListResponse> {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(100, Math.floor(options.limit!))) : 30;
  const now = options.now ?? new Date();
  const q = options.q?.trim().slice(0, 200) || null;
  const ids = await sql<{ id: string }[]>`SELECT DISTINCT paper.id ${PUBLIC_PAPER_FROM}
    WHERE ${publicPaperCondition(now)} AND (${options.cursor ?? null}::text IS NULL OR paper.id>${options.cursor ?? null})
      AND (${options.evaluationType ?? null}::text IS NULL OR e.evaluation_type=${options.evaluationType ?? null})
      AND (${options.sourceId ?? null}::text IS NULL OR pm.source_id=${options.sourceId ?? null})
      AND (${q}::text IS NULL OR strpos(lower(p.title),lower(${q}))>0 OR strpos(lower(paper.arxiv_id),lower(${q}))>0)
    ORDER BY paper.id LIMIT ${limit + 1}`;
  const visibleIds = ids.slice(0, limit).map((row) => row.id), rows = await paperRows(visibleIds, now);
  const items: PaperListItem[] = visibleIds.flatMap((id) => {
    const matching = rows.filter((row) => row.paper_id === id);
    if (!matching.length) return [];
    const { materials: _materials, versions: _versions, ...paper } = paperView(matching);
    return [paper];
  });
  return { items, nextCursor: ids.length > limit ? visibleIds.at(-1)! : null };
}

export async function loadPaper(id: string, now = new Date()): Promise<PaperDetail | null> {
  const rows = await paperRows([id], now);
  return rows.length ? paperView(rows) : null;
}
export async function loadPaperHistory(id: string, now = new Date()): Promise<PaperHistoryResponse | null> {
  const paper = await loadPaper(id, now);
  return paper ? { paper: ref(paper), versions: paper.versions } : null;
}

export async function loadPaperRefsByIds(ids: string[], db: Db = sql, now = new Date()): Promise<Map<string, PaperRef>> {
  if (!ids.length) return new Map();
  const links = await db<{ paper_id: string; article_id: string; version: number | null }[]>`
    SELECT DISTINCT pm.paper_id,pm.article_id,pm.version ${PUBLIC_PAPER_FROM}
    WHERE pm.article_id=ANY(${ids}::text[]) AND ${publicPaperCondition(now)} ORDER BY pm.version DESC NULLS LAST`;
  const rows = await paperRows([...new Set(links.map((row) => row.paper_id))], now, db);
  const result = new Map<string, PaperRef>();
  for (const link of links) {
    const matching = rows.filter((row) => row.paper_id === link.paper_id);
    if (!result.has(link.article_id) && matching.length) result.set(link.article_id, ref(paperView(matching), link.version));
  }
  return result;
}
export async function loadPaperRefByArticle(articleId: string, db: Db = sql, now = new Date()): Promise<PaperRef | null> {
  return (await loadPaperRefsByIds([articleId], db, now)).get(articleId) ?? null;
}
