import { sql, type Db } from "../db.ts";
import { paperIdentityOf } from "./identity.ts";

export interface PaperMaterialInput {
  articleId: string;
  sourceId: string;
  url: string;
  raw?: unknown;
  revision: number;
  discoveredAt: Date;
}

export async function associateMaterialPaper(input: PaperMaterialInput, db: Db = sql): Promise<boolean> {
  const run = (tx: Db) => associateIn(input, tx);
  return "begin" in db ? (db as typeof sql).begin(run) : run(db);
}

async function associateIn(input: PaperMaterialInput, db: Db): Promise<boolean> {
  const paper = paperIdentityOf(input.url, input.raw);
  if (!paper) return false;
  await db`INSERT INTO papers(id, arxiv_id, canonical_url, first_seen_at, last_seen_at)
    VALUES (${paper.id},${paper.arxivId},${paper.canonicalUrl},${input.discoveredAt},${input.discoveredAt})
    ON CONFLICT(id) DO UPDATE SET first_seen_at=least(papers.first_seen_at,EXCLUDED.first_seen_at),
      last_seen_at=greatest(papers.last_seen_at,EXCLUDED.last_seen_at)`;
  if (paper.version !== null) {
    await db`INSERT INTO paper_versions(paper_id,version,first_seen_at) VALUES (${paper.id},${paper.version},${input.discoveredAt})
      ON CONFLICT(paper_id,version) DO UPDATE SET first_seen_at=least(paper_versions.first_seen_at,EXCLUDED.first_seen_at)`;
  }
  await db`INSERT INTO paper_materials(paper_id,article_id,source_id,source_url,version,material_revision,discovered_at)
    VALUES (${paper.id},${input.articleId},${input.sourceId},${input.url},${paper.version},${input.revision},${input.discoveredAt})
    ON CONFLICT(paper_id,article_id,source_id,source_url,version) DO UPDATE
      SET material_revision=greatest(paper_materials.material_revision,EXCLUDED.material_revision)`;
  if (paper.version !== null) {
    // Upgrade the same input's formerly unknown version only after its explicit link is durable.
    // Other known versions and unknown observations of older input revisions remain untouched.
    await db`DELETE FROM paper_materials WHERE paper_id=${paper.id} AND article_id=${input.articleId}
      AND source_id=${input.sourceId} AND source_url=${input.url} AND material_revision=${input.revision} AND version IS NULL`;
  }
  return true;
}

/** Stored-material backfill only: no fetches, models, publication changes or invented paper versions. */
export async function backfillPaperAssociations(options: { afterId?: string | null; limit?: number; sourceId?: string | null } = {}) {
  const limit = Math.min(1000, Math.max(1, Math.floor(options.limit ?? 200)));
  const rows = await sql<{ id: string; source_id: string; url: string; raw: unknown; revision: number; discovered_at: Date }[]>`
    SELECT id,source_id,url,raw,revision,discovered_at FROM articles
    WHERE (${options.afterId ?? null}::text IS NULL OR id > ${options.afterId ?? null})
      AND (${options.sourceId ?? null}::text IS NULL OR source_id=${options.sourceId ?? null}) ORDER BY id LIMIT ${limit + 1}`;
  let associated = 0;
  for (const row of rows.slice(0, limit)) {
    if (await associateMaterialPaper({ articleId: row.id, sourceId: row.source_id, url: row.url, raw: row.raw,
      revision: row.revision, discoveredAt: row.discovered_at })) associated++;
  }
  return { processed: Math.min(rows.length, limit), associated, nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
}
