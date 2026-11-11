import { Link } from "react-router";
import type { PaperRef, PublicEvaluationEvidence } from "@aihot/contracts/evaluation";
import { evaluationLabels, evidenceClaimFields, missingEvidenceLabels, paperVersionCaption } from "./evaluation";

export { evaluationLabels } from "./evaluation";

export function EvaluationCard({ evidence, paper }: { evidence?: PublicEvaluationEvidence | null; paper?: PaperRef | null }) {
  if (!evidence && !paper) return null;
  return <section className="my-6 rounded-xl border border-line bg-bg-sunk p-5" aria-label="评测证据">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-base font-semibold text-ink">评测证据</h2>
      {evidence?.evaluationType && <span className="rounded-full bg-surface px-3 py-1 text-xs text-ink-3">{evaluationLabels[evidence.evaluationType]}</span>}
    </div>
    {paper && <p className="mt-3 text-sm text-ink-2">论文：<Link className="text-accent underline underline-offset-4" to={`/papers/${encodeURIComponent(paper.id)}`}>{paper.arxivId}</Link> · {paperVersionCaption(paper)}</p>}
    {evidence && <>
      <p className="mt-2 text-sm text-ink-3">{evidence.status === "matched" ? "已匹配原文中的文字与数值，不代表本站独立复现。" : evidence.claims.length ? "部分证据仍需复核，请结合原文判断。" : "当前没有通过原文匹配的主张，请查看原文。"}</p>
      {evidence.claims.map(claim => <article key={claim.id} className="mt-4 border-t border-line pt-4">
        <p className="break-words font-medium text-ink">{claim.statement}</p>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {evidenceClaimFields(claim).map(([label, value]) => <div key={label}><dt className="text-xs text-ink-4">{label}</dt><dd className="mt-0.5 break-words text-ink-2">{value ?? "未确认"}</dd></div>)}
        </dl>
        {claim.conditions.length > 0 && <p className="mt-3 text-sm text-ink-3">测试条件：{claim.conditions.join("；")}</p>}
        {claim.support.quote && <blockquote className="mt-3 border-l-2 border-accent pl-3 text-sm leading-relaxed text-ink-3">{claim.support.quote}</blockquote>}
        <div className="mt-3 flex flex-wrap gap-4 text-sm text-accent">
          <a href={claim.support.url} target="_blank" rel="noopener noreferrer">原文证据{claim.support.label ? ` · ${claim.support.label}` : ""}</a>
          {claim.codeUrl && <a href={claim.codeUrl} target="_blank" rel="noopener noreferrer">代码</a>}
          {claim.dataUrl && <a href={claim.dataUrl} target="_blank" rel="noopener noreferrer">数据</a>}
        </div>
      </article>)}
      {evidence.missingFields.length > 0 && <p className="mt-4 text-xs text-ink-4">尚未确认：{missingEvidenceLabels(evidence.missingFields).join("、")}</p>}
    </>}
  </section>;
}
