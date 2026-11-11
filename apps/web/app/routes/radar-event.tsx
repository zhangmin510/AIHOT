import { Link, useLoaderData } from "react-router";
import type { LeaderboardEvent } from "@aihot/contracts/radar";
import { loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { radarLabels } from "../features/leaderboard/radar-labels";

export async function loader({ request, params }: { request: Request; params: { id?: string } }) {
  return loadOr404<LeaderboardEvent>(`/api/site/leaderboard-events/${encodeURIComponent(params.id ?? "")}`, { signal: request.signal });
}
export function meta({ loaderData }: { loaderData?: LeaderboardEvent }) { return pageMeta({ title: loaderData?.title ?? "榜单变化", path: loaderData ? `/radar/${loaderData.id}` : "/radar" }); }
export const headers = () => ({ "Cache-Control": "public, max-age=0, s-maxage=30" });

export default function RadarEventPage() {
  const event = useLoaderData<typeof loader>();
  return <div className="mx-auto max-w-[var(--page-max-reading)] pb-12">
    <Link className="mt-5 inline-block text-sm text-accent" to="/radar">← 评测雷达</Link>
    <header className="py-6"><p className="text-xs text-ink-4">{radarLabels[event.type]} · {event.sourceName}</p><h1 className="mt-2 text-2xl font-semibold leading-snug text-ink">{event.title}</h1><p className="mt-4 text-base leading-relaxed text-ink-2">{event.summary}</p><p className="mt-3 text-xs text-ink-4">{event.timeBasis === "upstream_publication" ? "上游发布时间" : "本站首次观察时间"}：{event.occurredAt} · 记录于 {event.detectedAt}</p></header>
    <section className="card overflow-x-auto p-5"><h2 className="mb-4 font-semibold text-ink">变更前后证据</h2><table className="w-full text-left text-sm"><thead><tr className="border-b border-line"><th className="py-2">项目</th><th>变更前</th><th>变更后</th></tr></thead><tbody>{[
      ["原始名次", event.oldEvidence.rank, event.newEvidence.rank], ["原始分数", event.oldEvidence.score, event.newEvidence.score],
      ["样本数", event.oldEvidence.sampleSize, event.newEvidence.sampleSize], ["配置", event.oldEvidence.configurationLabel, event.newEvidence.configurationLabel],
      ["置信区间下界", event.oldEvidence.lowerBound, event.newEvidence.lowerBound], ["置信区间上界", event.oldEvidence.upperBound, event.newEvidence.upperBound],
      ["方法口径", event.oldEvidence.protocol, event.newEvidence.protocol], ["上游发布", event.oldEvidence.publishedAt, event.newEvidence.publishedAt],
    ].map(([label, before, after]) => <tr key={String(label)} className="border-b border-line last:border-0"><th className="py-3 pr-4 font-normal text-ink-4">{label}</th><td className="break-words py-3 pr-4 text-ink-2">{before ?? "未知"}</td><td className="break-words py-3 text-ink-2">{after ?? "未知"}</td></tr>)}</tbody></table></section>
    {event.model && <Link className="mt-5 inline-block text-sm text-accent" to={`/leaderboard/${encodeURIComponent(event.model.slug)}/history`}>查看 {event.model.name} 的成绩历史 →</Link>}
    <p className="mt-5 text-sm text-ink-3">{event.state === "observation" ? "本记录仅供观察，不能据此断言模型能力提升。" : "名次变化描述该榜单及配置下的记录，不单独证明能力提升或统计显著。"}</p>
    <p className="mt-3 text-xs text-ink-4">{event.attribution}</p><a className="mt-3 inline-block text-sm text-accent" href={event.sourceUrl} target="_blank" rel="noopener noreferrer">核对来源原文 ↗</a>
  </div>;
}
