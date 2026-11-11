import { Link } from "react-router";
import { EVALUATION } from "@aihot/industry/evaluation";
import { SITE } from "@aihot/industry/site";
import { pageMeta } from "../lib/seo";
import { AsideCard, ReadingLayout } from "../components/ui/Page";
import { KIND_LABEL, KIND_PATH, KINDS } from "../features/report/format";

export function meta() {
  return pageMeta({ title: "评测方法与证据", description: `${SITE.name} 如何区分厂商声明、第三方评测、外部榜单聚合与本站实测。`, path: "/methodology" });
}

export default function MethodologyPage() {
  return (
    <ReadingLayout aside={<AsideCard title="继续阅读"><nav className="space-y-3 text-[13px] text-accent"><Link className="block" to="/leaderboard">外部模型榜 →</Link><Link className="block" to="/leaderboard/rules">共识排名计算方法 →</Link><Link className="block" to="/topics/reproducible-methods">可复现方法动态 →</Link></nav></AsideCard>}>
      <div className="mono text-[11px] font-semibold tracking-widest text-accent">{SITE.name} · METHOD</div>
      <h1 className="mt-2 text-[28px] font-semibold text-ink">评测方法与证据</h1>
      <p className="mt-4 text-[15px] leading-relaxed text-ink-3">{EVALUATION.lead}</p>
      <h2 className="mt-8 text-[19px] font-semibold text-ink">先确认，证据从哪里来</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {EVALUATION.evidence.map((entry) => <section key={entry.name} className="card p-5"><h3 className="text-[15px] font-semibold text-accent">{entry.name}</h3><p className="mt-2 text-[13.5px] leading-relaxed text-ink-3">{entry.detail}</p></section>)}
      </div>
      <p className="mt-4 text-[13px] leading-relaxed text-ink-4">文章标签由模型按原文生成，可能有误，请回到原文核对。没有标签表示证据类型未明确。可复现方法表示存在复现入口，不代表本站已经复现。精选分数衡量阅读价值，热点衡量独立来源关注度。</p>
      <h2 className="mt-8 text-[19px] font-semibold text-ink">一份可复现评测需要什么</h2>
      <ol className="mt-3 divide-y divide-line">
        {EVALUATION.checklist.map(([title, detail], i) => <li key={title} className="flex gap-4 py-4"><span className="mono text-accent">0{i + 1}</span><div><h3 className="text-[14px] font-semibold text-ink">{title}</h3><p className="mt-1 text-[13.5px] leading-relaxed text-ink-3">{detail}</p></div></li>)}
      </ol>
      <h2 className="mt-8 text-[19px] font-semibold text-ink">怎么选，怎么归并</h2>
      <p className="mt-3 text-[14px] leading-relaxed text-ink-3">从官方资料、评测机构、论文和 GitHub 原始信源收集候选，公开内容须以 AI 模型、Agent 或应用的评测为主题。优先新基准、真实任务测试、评测方法与复现审计，压低营销和重复转述。同一事件合并阅读，转述数量不等于独立实验数量。</p>
      <p className="mt-3 text-[14px] leading-relaxed text-ink-3">内容先经过严格的评测主题准入：新基准、实测结果、评测方法、复现与审计等；普通产品发布附带跑分、一般算法的常规实验和商业新闻不因此放行。无法确认主题的材料仅保留内部待审。通过准入后，精选沿用两次独立评分与五维加权。当前门槛为框架初始值，仍需使用人工标注样本校准。页面读取已经发布的结果；打开页面不会调用模型。</p>
      <h2 className="mt-8 text-[19px] font-semibold text-ink">按周与月回顾</h2>
      <p className="mt-3 text-[14px] leading-relaxed text-ink-3">周报和月报按各自时间范围回顾已经公开的精选资料，每条保留来源入口。报告是阅读线索，关键数字和实验条件仍应回到原文核对。</p>
      <nav aria-label="评测刊物" className="mt-4 flex gap-5 text-[14px] text-accent">{KINDS.map((kind) => <Link key={kind} to={KIND_PATH[kind]}>{KIND_LABEL[kind]} →</Link>)}</nav>
    </ReadingLayout>
  );
}
