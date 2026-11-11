import { useState } from "react";
import { Link, useLoaderData } from "react-router";
import type { LeaderboardModelHistoryList } from "@aihot/contracts/radar";
import { loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { IconArrowRight } from "../components/icons";

export async function loader({ request }: { request: Request }) {
  return loadOr404<LeaderboardModelHistoryList>("/api/site/leaderboard-model-histories", { signal: request.signal });
}

export const meta = () => pageMeta({
  title: "模型评测记录",
  description: "按模型查看已获公开许可的来源成绩。每组评测版本和运行配置分别保留，不依赖综合排名。",
  path: "/leaderboard/history",
});
export const headers = () => ({ "Cache-Control": "no-store" });

export default function LeaderboardHistoryDirectory() {
  const { items } = useLoaderData<typeof loader>();
  const [query, setQuery] = useState("");
  const keyword = query.trim().toLowerCase();
  const shown = keyword ? items.filter((item) => item.name.toLowerCase().includes(keyword) || item.slug.toLowerCase().includes(keyword)) : items;
  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-12">
      <header className="py-6">
        <p className="mono text-[11px] font-semibold tracking-wide text-accent">MODEL EVALUATION RECORDS</p>
        <h1 className="mt-2 text-[25px] font-semibold text-ink">模型评测记录</h1>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-3">查看各模型已允许公开的来源成绩，按评测版本和运行配置分别展示。即使暂时没有综合排名，也可以核对这些原始记录。</p>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-4">只有一条记录的来源暂不能反映变化趋势；没有记录不等于模型得分为零。</p>
        <Link to="/radar" className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent">查看评测变动雷达 <IconArrowRight size={14} /></Link>
      </header>
      <label className="block text-[13px] text-ink-3">
        搜索模型
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="模型名称" className="mt-2 block w-full rounded-control border border-line bg-surface p-3 text-[14px] text-ink" />
      </label>
      <p className="my-4 text-[12px] text-ink-4" aria-live="polite">{shown.length} 个模型有可公开的评测记录</p>
      <ul className="grid gap-3 sm:grid-cols-2">
        {shown.map((item) => (
          <li key={item.slug} className="card p-4">
            <Link to={`/leaderboard/${encodeURIComponent(item.slug)}/history`} className="group flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block break-words text-[14px] font-semibold text-ink group-hover:text-accent">{item.name}</span>
                <span className="mt-1 block text-[12px] text-ink-4">{item.sourceCount} 个来源 · {item.pointCount} 条记录</span>
              </span>
              <IconArrowRight size={15} className="mt-0.5 shrink-0 text-accent" />
            </Link>
          </li>
        ))}
      </ul>
      {!shown.length && <p className="card p-6 text-[13px] text-ink-3">{keyword ? "没有匹配的模型名称。" : "当前还没有可公开的模型评测记录。"}</p>}
    </div>
  );
}
