import { SITE, withSubject } from "@aihot/industry/site";
import { redirect, useLoaderData } from "react-router";
import { FEATURES } from "@aihot/industry/features";
import type { Route } from "./+types/report-latest";
import type { ReportDetail, ReportNavigationEntry } from "@aihot/contracts/site";
import { loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { beijingDate } from "../lib/format";
import { EmptyState } from "../components/ui/Page";
import { ReportLayout } from "../features/report/ReportLayout";
import { ReportPaper } from "../features/report/ReportPaper";
import { KIND_LABEL, disabledReportRedirect, kindFromPath } from "../features/report/format";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const moved = disabledReportRedirect(url.pathname);
  if (moved) throw redirect(moved, 308);
  const kind = kindFromPath(url.pathname);
  const { index, report } = await loadOr404<{ index: ReportNavigationEntry[]; report: ReportDetail | null }>(`/api/site/reports/${kind}/latest-page`, { signal: request.signal });
  return { kind, report, index, today: beijingDate(Date.now()), fromDaily: url.searchParams.get("from") === "daily" };
}

export function meta({ loaderData, location }: Route.MetaArgs) {
  const kind = loaderData?.kind ?? FEATURES.reports.defaultKind;
  return pageMeta({
    title: withSubject(KIND_LABEL[kind]),
    description: kind === "daily" ? `${SITE.name} 每天 08:00（北京时间）发布的${withSubject("日报")}。` : `${SITE.name} 的${withSubject(KIND_LABEL[kind])}，按${kind === "weekly" ? "周" : "月"}回顾已公开的精选资料与原始来源。`,
    path: location.pathname,
    image: `/og/pages/${kind}.png`,
  });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=300" };
}

export default function ReportLatestPage() {
  const { kind, report, index, today, fromDaily } = useLoaderData<typeof loader>();
  return (
    <ReportLayout kind={kind} index={index} current={report?.key ?? null} today={today}>
      {fromDaily && <p role="status" className="mb-5 rounded-card border border-line bg-bg-sunk px-4 py-3 text-[13px] leading-relaxed text-ink-3">本站已改为发布周报和月报。原日报链接已转到周报；可切换月报，历史数据保留。</p>}
      {report ? <ReportPaper report={report} index={index} /> : <EmptyState title={`还没有发布 AI ${KIND_LABEL[kind]}`}>第一期发布后会出现在这里。</EmptyState>}
    </ReportLayout>
  );
}
