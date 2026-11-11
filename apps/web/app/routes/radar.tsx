import { Form, Link, useLoaderData } from "react-router";
import type { LeaderboardEventPage, LeaderboardSourceState } from "@aihot/contracts/radar";
import { loadOr404 } from "../lib/api.server";
import { queryString } from "../lib/query";
import { pageMeta } from "../lib/seo";
import { fullDateTime } from "../lib/format";
import { radarLabels } from "../features/leaderboard/radar-labels";

export async function loader({ request }: { request: Request }) {
  const q = new URL(request.url).searchParams;
  const filters = { source: q.get("source"), type: q.get("type"), model: q.get("model") };
  const [page, sources] = await Promise.all([
    loadOr404<LeaderboardEventPage>(`/api/site/leaderboard-events${queryString({ ...filters, cursor: q.get("cursor"), limit: 30 })}`, { signal: request.signal }),
    loadOr404<LeaderboardSourceState[]>("/api/site/leaderboard-source-states", { signal: request.signal }),
  ]);
  return { page, sources, filters };
}
const freshnessLabels = { fresh: "正常", stale: "已过期", unknown: "未知" };
const dateLabel = (value: string | null) => value ? fullDateTime(value) : "未知";
export const meta = () => pageMeta({ title: "评测雷达", path: "/radar", description: "追踪榜单变化、方法论改版和来源数据时效，保留变更前后的证据。" });
export const headers = () => ({ "Cache-Control": "public, max-age=0, s-maxage=30" });

export default function RadarPage() {
  const { page, sources, filters } = useLoaderData<typeof loader>();
  return <div className="mx-auto max-w-[var(--page-max-reading)] pb-12">
    <header className="py-6"><h1 className="text-2xl font-semibold text-ink">评测雷达</h1><p className="mt-2 text-sm leading-relaxed text-ink-3">追踪同一评测口径下的变化。方法论改版单独记录，初次导入只建立基线。</p><a href="/feed/leaderboard.xml" className="mt-3 inline-block text-xs text-accent">订阅榜单变化 RSS ↗</a></header>
    <Link to="/leaderboard/history" className="mb-5 inline-flex text-sm font-medium text-accent">查看模型评测记录 →</Link>
    <Form method="get" className="mb-5 flex flex-wrap gap-3 text-sm">
      <label>来源 <select className="ml-1 rounded-lg border border-line bg-surface p-2" name="source" defaultValue={filters.source ?? ""}><option value="">全部</option>{sources.filter(source => source.policy.publicEvents).map(source => <option key={source.sourceKey} value={source.sourceKey}>{source.sourceName}</option>)}</select></label>
      <label>变化 <select className="ml-1 rounded-lg border border-line bg-surface p-2" name="type" defaultValue={filters.type ?? ""}><option value="">全部</option>{Object.entries(radarLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <button className="rounded-lg border border-line px-4 py-2">筛选</button>
    </Form>
    <ul className="space-y-3">{page.items.map(event => <li key={event.id} className="card p-5"><div className="flex flex-wrap gap-2 text-xs text-ink-4"><span>{radarLabels[event.type]}</span><span>{event.sourceName}</span><time>{event.occurredAt.slice(0, 16).replace("T", " ")}</time><span>{event.state === "observation" ? "观察记录" : "同口径变化"}</span></div><Link to={`/radar/${encodeURIComponent(event.id)}`} className="mt-3 block text-lg font-semibold text-ink hover:text-accent">{event.title}</Link><p className="mt-2 text-sm leading-relaxed text-ink-3">{event.summary}</p></li>)}</ul>
    {!page.items.length && <p className="card p-8 text-sm text-ink-3">当前没有符合筛选条件、可公开的变化事件。首次导入不会生成历史推送。</p>}
    {page.nextCursor && <Link className="mt-5 inline-block rounded-lg border border-line px-4 py-2 text-sm" to={`/radar${queryString({ ...filters, cursor: page.nextCursor })}`}>下一页</Link>}
    <details className="mt-8 rounded-xl border border-line p-4"><summary className="cursor-pointer text-sm font-semibold text-ink">来源时效与使用范围</summary><p className="mt-3 text-xs text-ink-4">抓取成功与上游发布是两种时间。未确认的数据日期保持未知。</p><ul className="mt-3 space-y-4">{sources.map(source => <li key={source.sourceKey} className="border-t border-line pt-3 text-xs leading-relaxed text-ink-3"><span className="font-semibold text-ink">{source.sourceName}</span><p>抓取时效：{freshnessLabels[source.freshness.fetchStatus]} · 数据时效：{freshnessLabels[source.freshness.dataStatus]}</p><p>最近尝试：{dateLabel(source.freshness.lastAttemptAt)}（{source.freshness.lastAttemptOk === null ? "尚无结果" : source.freshness.lastAttemptOk ? "成功" : "失败"}） · 最近成功：{dateLabel(source.freshness.lastSuccessAt)}</p><p>上游发布：{dateLabel(source.freshness.upstreamPublishedAt)}（UTC+8）</p><p>公开原分：{source.policy.publicRows ? "允许" : "未授权"} · 公开聚合：{source.policy.publicDerived ? "允许" : "未授权"} · {source.policy.licenseName}</p>{source.policy.evidenceUrl && <a className="text-accent" href={source.policy.evidenceUrl} target="_blank" rel="noopener noreferrer">许可依据 ↗</a>}</li>)}</ul></details>
  </div>;
}
