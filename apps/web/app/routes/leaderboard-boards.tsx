import { SITE, withSubject } from "@aihot/industry/site";
import { isRouteErrorResponse, Link, Outlet, useRouteError } from "react-router";
import { EmptyState } from "../components/ui/Page";
import { BoardTabs } from "../features/leaderboard/BoardTabs";
import { IconArrowUpRight } from "../components/icons";

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

/** Shared frame for the overall and category boards; only the board below it changes. */
export default function LeaderboardFrame() {
  return <BoardFrame><Outlet /></BoardFrame>;
}

function BoardFrame({ children }: { children: React.ReactNode }) {
  const chip = "inline-flex h-8 items-center gap-1 rounded-full border border-line-strong bg-surface px-3.5 text-[12.5px] text-ink-2 transition-colors hover:border-ink-4 hover:text-ink";
  return (
    <div className="pb-10">
      <header className="flex flex-col gap-3 pb-4 pt-5 sm:flex-row sm:items-end sm:justify-between lg:pt-1">
        <div>
          <div className="mono text-[11px] font-semibold tracking-[0.16em] text-accent">{SITE.name.toUpperCase()} LEADERBOARD</div>
          <h1 className="mt-1.5 text-[24px] font-semibold leading-[1.3] text-ink">AI 模型排行榜</h1>
        </div>
        <div className="flex gap-2">
          <Link to="/leaderboard/sources" className={chip}>
            评测来源 <IconArrowUpRight size={13} />
          </Link>
          <Link to="/leaderboard/rules" className={chip}>
            排名怎么算 <IconArrowUpRight size={13} />
          </Link>
        </div>
      </header>
      <p className="mb-4 rounded-control bg-bg-sunk px-4 py-3 text-[13px] leading-relaxed text-ink-3">外部榜单聚合 · 以下排名来自评测方公开成绩，共识指数不是正确率。尚未发布本站实测。<Link to="/methodology" className="ml-2 text-accent">证据类型与局限 →</Link></p>
      <div className="-mx-4 px-4 lg:mx-0 lg:px-0">
        <BoardTabs />
      </div>
      {children}
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  return <BoardFrame><EmptyState title={status === 404 ? "没有这个榜单" : "暂无可用榜单"} action={<Link to="/methodology" className="mt-4 text-[13px] text-accent">阅读评测方法 →</Link>}>{status === 404 ? "请选择上方的有效栏目。" : "首次计算尚未完成，或评测证据暂不可用。有效结果发布前不展示示例名次或成绩。"}</EmptyState></BoardFrame>;
}
