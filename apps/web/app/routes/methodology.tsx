import { Link } from "react-router";
import { EVALUATION } from "@aihot/industry/evaluation";
import { SITE } from "@aihot/industry/site";
import { pageMeta } from "../lib/seo";
import { AsideCard, ReadingLayout } from "../components/ui/Page";

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
      <p className="mt-3 text-[14px] leading-relaxed text-ink-3">优先官方模型与 Agent 发布、评测机构、论文和 GitHub 原始信源。优先新基准、真实任务评测、可复现方法与重要产品变化，压低营销和重复转述。同一事件合并阅读，转述数量不等于独立实验数量。</p>
      <p className="mt-3 text-[14px] leading-relaxed text-ink-3">精选沿用预筛、两次独立评分与五维加权。当前门槛为框架初始值，仍需使用人工标注样本校准。页面读取已经发布的结果；打开页面不会调用模型。</p>
    </ReadingLayout>
  );
}
