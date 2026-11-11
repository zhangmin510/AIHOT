import { Form, Link, useLoaderData } from "react-router";
import type { PaperListResponse } from "@aihot/contracts/evaluation";
import { EVALUATION_TYPES } from "@aihot/contracts/evaluation";
import { loadOr404 } from "../lib/api.server";
import { queryString } from "../lib/query";
import { pageMeta } from "../lib/seo";
import { evaluationLabels, paperListFilters } from "../features/item/evaluation";

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const filters = paperListFilters(url.searchParams);
  const result = await loadOr404<PaperListResponse>(`/api/site/papers${queryString({ ...filters, limit: 30 })}`, { signal: request.signal });
  return { result, ...filters };
}
export const meta = () => pageMeta({ title: "论文索引", path: "/papers", description: "关联已有公开论文的来源与明确版本，逐步核对评测类型。" });
export const headers = () => ({ "Cache-Control": "public, max-age=0, s-maxage=30" });

export default function PapersPage() {
  const { result, evaluationType, q, sourceId } = useLoaderData<typeof loader>();
  return <div className="mx-auto max-w-[var(--page-max-reading)] pb-12">
    <header className="py-6"><h1 className="text-2xl font-semibold text-ink">论文索引</h1><p className="mt-2 text-sm text-ink-3">收录站内已有公开论文，关联来源与原文明确的版本。评测类型待逐步核对；仅展示已记录的版本。</p></header>
    <Form method="get" className="mb-5 flex flex-wrap items-end gap-3">
      {sourceId && <input type="hidden" name="sourceId" value={sourceId} />}
      <label className="text-sm text-ink-3">搜索论文<input type="search" name="q" defaultValue={q ?? ""} placeholder="论文标题或 arXiv 编号" className="ml-2 max-w-full rounded-lg border border-line bg-surface p-2" /></label>
      <label className="text-sm text-ink-3">评测类型 <select name="evaluationType" defaultValue={evaluationType ?? ""} className="ml-2 rounded-lg border border-line bg-surface p-2"><option value="">全部</option>{EVALUATION_TYPES.map(type => <option key={type} value={type}>{evaluationLabels[type]}</option>)}</select></label>
      <button className="rounded-lg border border-line bg-surface px-4 py-2 text-sm">筛选</button>
      {sourceId && <Link className="py-2 text-sm text-accent" to={`/papers${queryString({ evaluationType, q })}`}>查看所有来源</Link>}
    </Form>
    <ul className="space-y-3">{result.items.map(paper => <li key={paper.id} className="card p-5"><Link className="text-base font-semibold text-ink hover:text-accent" to={`/papers/${encodeURIComponent(paper.id)}`}>{paper.title}</Link><p className="mt-2 text-xs text-ink-4">{paper.arxivId} · {paper.materialCount} 份来源材料 · {paper.latestVersion === null ? "版本未确认" : `已记录至 v${paper.latestVersion}`}</p><p className="mt-2 text-sm text-ink-3">{paper.evaluationTypes.map(type => evaluationLabels[type]).join(" · ")}</p></li>)}</ul>
    {!result.items.length && <p className="card p-8 text-sm text-ink-3">当前筛选没有已公开的论文记录。</p>}
    {result.nextCursor && <Link className="mt-5 inline-block rounded-lg border border-line px-4 py-2 text-sm" to={`/papers${queryString({ evaluationType, q, sourceId, cursor: result.nextCursor })}`}>下一页</Link>}
  </div>;
}
