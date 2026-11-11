// Admission to this industry's public corpus. UNKNOWN is private; importance scores are untouched.
import { CONTENT_SCOPE } from "@aihot/industry/scope";
import { sql, type Db, type Tx } from "../db.ts";
import { collapseWhitespace } from "../lib/text.ts";

export type ScopeDecision = "PASS" | "BLOCK" | "UNKNOWN";
export interface ScopeRecord {
  id: number;
  article_id: string;
  input_revision: number;
  scope_key: string;
  policy_version: string;
  decision: ScopeDecision;
  origin: "prefilter" | "agent-review" | "human-review";
  reason: string;
  evidence_quote: string | null;
  analysis_id: number | null;
  prompt_version: string | null;
  created_at: Date;
}
export interface ScopeDecisionInput {
  articleId: string;
  inputRevision: number;
  decision: ScopeDecision;
  origin: ScopeRecord["origin"];
  reason: string;
  evidenceQuote?: string | null;
  analysisId?: number | null;
  promptVersion?: string | null;
  scopeKey?: string;
  policyVersion?: string;
}

/** Correlated with the real current revision, including before an old publication is re-derived. */
export function publicScopeCondition(articleId: ReturnType<typeof sql> = sql`p.article_id`) {
  if (!CONTENT_SCOPE.requireExplicitPass) return sql`true`;
  return sql`EXISTS (SELECT 1 FROM articles scope_article WHERE scope_article.id = ${articleId}
    AND (SELECT scope_decision.decision FROM article_scope_decisions scope_decision
      WHERE scope_decision.article_id = scope_article.id AND scope_decision.input_revision = scope_article.revision
        AND scope_decision.scope_key = ${CONTENT_SCOPE.key} AND scope_decision.policy_version = ${CONTENT_SCOPE.version}
      ORDER BY scope_decision.id DESC LIMIT 1) = 'PASS')`;
}

export async function loadScopeDecision(articleId: string, inputRevision: number, db: Db = sql): Promise<ScopeRecord | null> {
  const [record] = await db<ScopeRecord[]>`SELECT * FROM article_scope_decisions
    WHERE article_id = ${articleId} AND input_revision = ${inputRevision}
      AND scope_key = ${CONTENT_SCOPE.key} AND policy_version = ${CONTENT_SCOPE.version}
    ORDER BY id DESC LIMIT 1`;
  return record ?? null;
}

/** Caller supplies the transaction used for the analysis/import; no model, queue worker or network. */
export async function recordScopeDecision(db: Db, input: ScopeDecisionInput): Promise<ScopeRecord> {
  if ("begin" in db) return (db as typeof sql).begin(tx => recordScopeDecision(tx, input)) as Promise<ScopeRecord>;
  if (!["PASS", "BLOCK", "UNKNOWN"].includes(input.decision) || !["prefilter", "agent-review", "human-review"].includes(input.origin)) throw new Error("Invalid scope decision or origin");
  if (!input.reason?.trim()) throw new Error("A scope decision requires its reason");
  const [article] = await db<{ revision: number; title: string; body_text: string | null; excerpt: string | null; x_post: Record<string, any> | null; x_article: Record<string, any> | null }[]>`
    SELECT revision,title,body_text,excerpt,x_post,x_article FROM articles WHERE id = ${input.articleId} FOR UPDATE`;
  if (!article || article.revision !== input.inputRevision) throw new Error("Scope decision does not match the current material revision");
  const quote = input.evidenceQuote?.trim() || null;
  if (input.decision === "PASS") {
    const normalize = (text: string) => collapseWhitespace(text.normalize("NFKC")).toLowerCase();
    // Match the original X Article composition read by the prefilter, never a generated translation.
    const post = article.x_post;
    const xArticle = article.x_article;
    const postText = post && xArticle?.text ? [String(post.text ?? "").trim(), xArticle.title ? `【X 长文】${xArticle.title}` : "【X 长文】", xArticle.text].filter(Boolean).join("\n\n") : post?.text ?? "";
    const material = normalize([article.title, article.body_text ?? "", article.excerpt ?? "", article.x_post?.text ?? "",
      postText, article.x_post?.quoted?.text ?? "", article.x_article?.title ?? "", article.x_article?.text ?? ""].join("\n"));
    if (!quote || !material.includes(normalize(quote))) throw new Error("A PASS scope decision requires a quote present in the current material");
  }
  if (input.analysisId) {
    const [analysis] = await db`SELECT 1 FROM analyses WHERE id = ${input.analysisId} AND article_id = ${input.articleId} AND input_revision = ${input.inputRevision}`;
    if (!analysis) throw new Error("Scope analysis does not match the current material");
  }
  const [record] = await db<ScopeRecord[]>`INSERT INTO article_scope_decisions
    (article_id,input_revision,scope_key,policy_version,decision,origin,reason,evidence_quote,analysis_id,prompt_version)
    VALUES (${input.articleId},${input.inputRevision},${input.scopeKey ?? CONTENT_SCOPE.key},${input.policyVersion ?? CONTENT_SCOPE.version},
      ${input.decision},${input.origin},${input.reason.trim()},${quote},${input.analysisId ?? null},${input.promptVersion ?? null}) RETURNING *`;
  // PASS waits for the normal publisher. A denial retracts the previous projection in this commit.
  if (CONTENT_SCOPE.requireExplicitPass && input.decision !== "PASS") {
    const { publishArticleTx } = await import("../publication/publish.ts");
    await publishArticleTx(db as Tx, input.articleId);
  }
  return record!;
}
