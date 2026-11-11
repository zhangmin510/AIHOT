import { Link, useLoaderData } from "react-router";
import type { PaperDetail } from "@aihot/contracts/evaluation";
import { loadOr404 } from "../lib/api.server";
import { queryString } from "../lib/query";
import { pageMeta } from "../lib/seo";
import { beijingDate } from "../lib/format";
import { paperMaterialKey } from "../features/item/evaluation";

export async function loader({ request, params }: { request: Request; params: { id?: string } }) {
  return loadOr404<PaperDetail>(`/api/site/papers/${encodeURIComponent(params.id ?? "")}`, { signal: request.signal });
}
export function meta({ loaderData }: { loaderData?: PaperDetail }) { return pageMeta({ title: loaderData?.title ?? "论文", path: loaderData ? `/papers/${encodeURIComponent(loaderData.id)}` : "/papers" }); }
export const headers = () => ({ "Cache-Control": "public, max-age=0, s-maxage=30" });

export default function PaperPage() {
  const paper = useLoaderData<typeof loader>();
  return <div className="mx-auto max-w-[var(--page-max-reading)] pb-12">
    <Link className="mt-5 inline-block text-sm text-accent" to="/papers">← 论文索引</Link>
    <header className="py-6"><p className="mono text-xs text-ink-4">arXiv {paper.arxivId}</p><h1 className="mt-2 text-2xl font-semibold leading-snug text-ink">{paper.title}</h1><a className="mt-3 inline-block text-sm text-accent" href={paper.canonicalUrl} target="_blank" rel="noopener noreferrer">打开论文原文 ↗</a></header>
    <h2 className="mb-4 text-lg font-semibold text-ink">版本与来源</h2>
    <div className="space-y-4">{paper.versions.map(version => <section key={version.version ?? "unknown"} className="card p-5"><h3 className="font-semibold text-ink">{version.version === null ? "版本未确认" : `版本 ${version.version}`}</h3><p className="mt-1 text-xs text-ink-4">首次收录 {beijingDate(version.firstSeenAt)}</p><ul className="mt-4 space-y-3">{version.materials.map(material => <li key={paperMaterialKey(material)}><Link className="text-sm text-ink hover:text-accent" to={`/items/${encodeURIComponent(material.itemId)}`}>{material.title}</Link><p className="mt-1 text-xs text-ink-4"><Link to={`/papers${queryString({ sourceId: material.sourceId })}`} className="hover:text-accent">{material.sourceName}</Link> · <a href={material.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-accent">来源原文</a></p></li>)}</ul></section>)}</div>
  </div>;
}
