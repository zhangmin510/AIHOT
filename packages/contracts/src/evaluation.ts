// Optional technical attributes; these do not replace the industry's editorial categories.
export const EVALUATION_TYPES = ["new_benchmark", "evaluation_result", "eval_method", "eval_critique", "safety_eval", "agent_eval"] as const;
export type EvaluationType = typeof EVALUATION_TYPES[number];

export interface EvaluationEvidenceClaim {
  id: string;
  /** Rendered from matched structured fields, never an unchecked model-written assertion. */
  statement: string;
  model: string | null;
  modelVersion: string | null;
  benchmark: string | null;
  benchmarkVersion: string | null;
  metric: string | null;
  value: number | null;
  unit: string | null;
  split: string | null;
  conditions: string[];
  sampleSize: number | null;
  confidenceInterval: { lower: number; upper: number; level: number | null } | null;
  attribution: "vendor" | "third_party" | null;
  codeUrl: string | null;
  dataUrl: string | null;
  dataAvailability: "public" | "restricted" | null;
  /** Offsets refer to the stored title + newline + original text; unlicensed quotes stay null. */
  support: { quote: string | null; start: number; end: number; label: string | null; url: string };
}

export interface PublicEvaluationEvidence {
  evaluationType: EvaluationType | null;
  /** Matched means text/quantity checks passed, not that the research was independently reproduced. */
  status: "matched" | "needs_review";
  claims: EvaluationEvidenceClaim[];
  issues: string[];
  missingFields: string[];
  checkedAt: string;
  inputRevision: number;
  validationVersion: string;
}

export interface PaperRef {
  id: string;
  arxivId: string;
  title: string;
  canonicalUrl: string;
  version: number | null;
  latestVersion: number | null;
}

export interface PaperMaterial {
  itemId: string;
  sourceId: string;
  title: string;
  sourceName: string;
  sourceUrl: string;
  version: number | null;
  discoveredAt: string;
  evaluationType: EvaluationType | null;
}

export interface PaperVersion {
  version: number | null;
  firstSeenAt: string;
  materials: PaperMaterial[];
}

export interface PaperListItem extends PaperRef {
  firstSeenAt: string;
  lastSeenAt: string;
  materialCount: number;
  evaluationTypes: EvaluationType[];
}

export interface PaperListResponse { items: PaperListItem[]; nextCursor: string | null }
export interface PaperDetail extends PaperListItem { materials: PaperMaterial[]; versions: PaperVersion[] }
export interface PaperHistoryResponse { paper: PaperRef; versions: PaperVersion[] }
