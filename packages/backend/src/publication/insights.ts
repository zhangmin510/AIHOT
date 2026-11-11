// Batch augmentation for every public item outlet. Readers here enforce current visibility/licences.
import type { EvaluationType, PaperRef, PublicEvaluationEvidence } from "@aihot/contracts/evaluation";
import { loadEvidenceByIds } from "./evidence.ts";
import { loadPaperRefsByIds } from "./papers.ts";
import { sql, type Db } from "../db.ts";

export interface PublicItemInsights {
  evaluationType?: EvaluationType | null;
  evidence?: PublicEvaluationEvidence | null;
  paper?: PaperRef | null;
}

export async function withPublicInsights<T extends { id: string }>(items: T[], db: Db = sql, now = new Date()): Promise<Array<T & PublicItemInsights>> {
  if (!items.length) return [];
  const ids = [...new Set(items.map(item => item.id))];
  const [evidence, papers] = await Promise.all([loadEvidenceByIds(ids, db), loadPaperRefsByIds(ids, db, now)]);
  return items.map(item => {
    const card = evidence.get(item.id), paper = papers.get(item.id);
    // Ledger payloads can already carry an older card. Absence of current permission/evidence must
    // remove it, not preserve it via an object spread of the historical payload.
    const clean = { ...item } as T & PublicItemInsights;
    delete clean.evaluationType; delete clean.evidence; delete clean.paper;
    return { ...clean, ...(card ? { evaluationType: card.evaluationType, evidence: card } : {}), ...(paper ? { paper } : {}) };
  });
}
