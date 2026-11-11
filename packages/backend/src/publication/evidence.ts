// Public evidence is a projection, never the private extraction/receipt or an unlicensed excerpt.
import type { PublicEvaluationEvidence, EvaluationEvidenceClaim } from "@aihot/contracts/evaluation";
import { sql, type Db } from "../db.ts";
import type { CheckedEvaluationEvidence } from "../editorial/evidence.ts";
import { publicScopeCondition } from "../content/scope.ts";

export async function loadEvidenceByIds(ids: string[], db: Db = sql): Promise<Map<string, PublicEvaluationEvidence>> {
  if (!ids.length) return new Map();
  const rows = await db<{ id: string; payload: CheckedEvaluationEvidence; quote_allowed: boolean }[]>`
    SELECT p.article_id AS id,e.payload,
      (p.body_mode='full' AND s.site_fulltext AND s.syndicate_fulltext) AS quote_allowed
    FROM publications p JOIN sources s ON s.id=p.source_id JOIN articles a ON a.id=p.article_id
    JOIN article_evidence e ON e.analysis_id=p.analysis_id AND e.article_id=p.article_id AND e.input_revision=a.revision
    WHERE p.article_id=ANY(${ids}::text[]) AND p.visibility='public' AND s.participation_mode='editorial' AND ${publicScopeCondition()}`;
  const result = new Map<string, PublicEvaluationEvidence>();
  for (const row of rows) {
    let quoteBudget = row.quote_allowed ? 480 : 0;
    const claims: EvaluationEvidenceClaim[] = row.payload.claims.filter((claim) => claim.issues.length === 0).map(({ issues: _issues, ...claim }) => {
      const quote = quoteBudget > 0 && claim.support.quote ? Array.from(claim.support.quote).slice(0, Math.min(160, quoteBudget)).join("") : null;
      quoteBudget -= quote?.length ?? 0;
      return { ...claim, support: { ...claim.support, quote } };
    });
    result.set(row.id, { evaluationType: row.payload.evaluationType, status: row.payload.status, claims,
      issues: row.payload.issues, missingFields: row.payload.missingFields, checkedAt: row.payload.checkedAt,
      inputRevision: row.payload.inputRevision, validationVersion: row.payload.validationVersion });
  }
  return result;
}

export async function loadItemEvidence(articleId: string, db: Db = sql): Promise<PublicEvaluationEvidence | null> {
  return (await loadEvidenceByIds([articleId], db)).get(articleId) ?? null;
}
