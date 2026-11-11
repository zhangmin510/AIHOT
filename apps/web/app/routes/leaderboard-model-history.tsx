import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import type { LeaderboardModelHistory } from "@aihot/contracts/radar";
import { loadOr404 } from "../lib/api.server";
import { breadcrumbLd, pageMeta, titled } from "../lib/seo";
import { IconArrowLeft, IconArrowRight } from "../components/icons";

export async function loader({ params, request }: LoaderFunctionArgs) {
  if (!params.slug) throw new Response("Not found", { status: 404 });
  return loadOr404<LeaderboardModelHistory>(`/api/site/leaderboard-model-history/${encodeURIComponent(params.slug)}`, { signal: request.signal });
}

export function meta({ loaderData }: { loaderData?: LeaderboardModelHistory }) {
  if (!loaderData) return [{ title: titled("历史记录不存在") }];
  const { model } = loaderData;
  return pageMeta({
    title: `${model.name} 的评测历史`,
    description: `按来源、评测版本和运行配置查看 ${model.name} 的历史原始成绩。`,
    path: `/leaderboard/${model.slug}/history`,
    jsonLd: breadcrumbLd([{ name: "模型评测记录", path: "/leaderboard/history" }, { name: model.name, path: `/leaderboard/${model.slug}/history` }]),
  });
}

export const headers = () => ({ "Cache-Control": "no-store" });
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 5 });
const showNumber = (value: number | null) => value == null ? "未公开" : number.format(value);
function sourceDate(value: string | null): string {
  return value ? value.slice(0, 10) : "来源日期未知";
}
function protocolLabel(value: string): string {
  const description = value.split(":protocol-v1:")[1];
  if (!description || description === "unknown") return "来源未声明，保留为独立观察";
  const labels: Record<string, string> = { methodologyVersion: "方法版本", protocolVersion: "评测协议", intelligenceIndexVersion: "AA 指数版本", editionId: "评测批次", datasetVersion: "数据版本", benchmarkVersion: "基准版本", arenaConfig: "Arena 配置", arenaCategory: "任务分类", datasetRef: "题集", harness: "运行系统", scoringField: "计分字段", officialBoard: "来源榜单", comparisonSubject: "比较对象", release: "发布版本" };
  try {
    return Object.entries(JSON.parse(description) as Record<string, unknown>).map(([key, version]) => `${labels[key] ?? key}：${String(version)}`).join(" · ");
  } catch {
    return "来源版本说明待核实";
  }
}

export default function LeaderboardModelHistoryPage() {
  const history = useLoaderData<typeof loader>();
  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-12">
      <Link to="/leaderboard/history" className="mt-4 inline-flex items-center gap-1.5 py-2 text-[13px] text-ink-3 hover:text-accent">
        <IconArrowLeft size={14} /> 模型评测记录
      </Link>
      <header className="py-5">
        <p className="mono text-[11px] font-semibold tracking-wide text-accent">EVALUATION HISTORY</p>
        <h1 className="mt-2 text-[25px] font-semibold text-ink">{history.model.name} 的评测历史</h1>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-3">每个来源、评测版本和运行配置分别展示。表内是来源原始分数，不同表的分数尺度和测试条件可能不同。</p>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-4">日期来自来源记录或上游发布；没有公开日期时保持未知。区间沿用来源口径，可能是标准误或置信区间，不统一视为 95% 置信区间。</p>
      </header>
      {history.series.length === 0 && <p className="card p-6 text-[13px] text-ink-3">该模型目前没有可公开的历史成绩。</p>}
      <div className="space-y-5">
        {history.series.map((series) => (
          <section key={JSON.stringify([series.sourceKey, series.metricKey, series.protocol, series.configurationKey])} className="card overflow-hidden p-4 sm:p-5">
            <h2 className="text-[16px] font-semibold text-ink">{series.sourceName}</h2>
            <dl className="mt-3 grid gap-2 text-[12px] leading-relaxed text-ink-3">
              <div><dt className="inline text-ink-4">指标：</dt><dd className="inline break-all">{series.metricKey}</dd></div>
              <div><dt className="inline text-ink-4">运行配置：</dt><dd className="inline break-all">{series.configurationKey === "source_default:default" ? "来源默认配置，运行条件未明确" : series.configurationKey.replace("first_party:", "第一方配置 · ")}</dd></div>
              <div><dt className="inline text-ink-4">评测版本：</dt><dd className="inline break-all">{protocolLabel(series.protocol)}</dd></div>
            </dl>
            <div className="mt-4 overflow-x-auto" tabIndex={0} role="region" aria-label={`${series.sourceName} 历史成绩表`}>
              <table className="w-full min-w-[560px] text-left text-[12px]">
                <thead className="text-ink-4"><tr className="border-b border-line">
                  <th className="py-2 pr-4 font-medium" scope="col">来源记录日期（UTC）</th>
                  <th className="py-2 pr-4 font-medium" scope="col">原始分数</th>
                  <th className="py-2 pr-4 font-medium" scope="col">原榜名次</th>
                  <th className="py-2 pr-4 font-medium" scope="col">来源区间</th>
                  <th className="py-2 font-medium" scope="col">样本数</th>
                </tr></thead>
                <tbody>{series.points.map((point) => (
                  <tr key={`${point.snapshotId}:${point.configurationKey}`} className="border-b border-line-soft last:border-0">
                    <td className="num whitespace-nowrap py-3 pr-4 text-ink-3">{point.at ? <time dateTime={point.at}>{sourceDate(point.at)}</time> : "来源日期未知"}</td>
                    <td className="mono py-3 pr-4 text-ink">{showNumber(point.score)}</td>
                    <td className="num py-3 pr-4 text-ink-3">{point.rank == null ? "未公开" : `第 ${point.rank} 名`}</td>
                    <td className="mono whitespace-nowrap py-3 pr-4 text-ink-3">{point.lowerBound == null || point.upperBound == null ? "未公开" : `${showNumber(point.lowerBound)} — ${showNumber(point.upperBound)}`}</td>
                    <td className="num py-3 text-ink-3">{showNumber(point.sampleSize)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            {series.attribution && <p className="mt-3 text-[12px] leading-relaxed text-ink-4">{series.attribution}</p>}
            <div className="mt-3 flex flex-wrap gap-4 text-[12px] text-accent">
              {series.sourceUrl && <a href={series.sourceUrl} target="_blank" rel="noopener noreferrer">核对原始来源 ↗</a>}
              {series.evidenceUrl && <a href={series.evidenceUrl} target="_blank" rel="noopener noreferrer">{series.licenseName ?? "查看使用许可"} ↗</a>}
            </div>
          </section>
        ))}
      </div>
      <Link to={`/radar?model=${encodeURIComponent(history.model.slug)}`} className="mt-6 inline-flex items-center gap-1 text-[13px] font-medium text-accent">查看该模型的变动事件 <IconArrowRight size={14} /></Link>
    </div>
  );
}
