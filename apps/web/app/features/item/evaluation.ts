import { EVALUATION_TYPES, type EvaluationEvidenceClaim, type EvaluationType, type PaperMaterial, type PaperRef } from "@aihot/contracts/evaluation";

export const evaluationLabels: Record<EvaluationType, string> = {
  new_benchmark: "新评测基准", evaluation_result: "评测结果", eval_method: "评测方法",
  eval_critique: "评测争议与更正", safety_eval: "安全评测", agent_eval: "Agent 评测",
};
const missingLabels: Record<string, string> = {
  model: "测试对象", modelVersion: "模型版本", benchmark: "评测基准", benchmarkVersion: "基准版本",
  metric: "指标", value: "数值", unit: "单位", split: "数据划分", sampleSize: "样本数", conditions: "测试条件",
  attribution: "证据归属", dataAvailability: "数据开放状态", confidenceInterval: "置信区间", codeUrl: "代码入口", dataUrl: "数据入口",
};
export const missingEvidenceLabels = (fields: string[]) => [...new Set(fields.map(field => missingLabels[field] ?? "其他测试信息"))];

export function evidenceClaimFields(claim: EvaluationEvidenceClaim): Array<[string, string | null]> {
  const interval = claim.confidenceInterval;
  return [
    ["测试对象", [claim.model, claim.modelVersion].filter(Boolean).join(" · ") || null],
    ["评测基准", [claim.benchmark, claim.benchmarkVersion].filter(Boolean).join(" · ") || null],
    ["指标", claim.metric], ["数值", claim.value === null ? null : `${claim.value}${claim.unit ? ` ${claim.unit}` : ""}`],
    ["数据划分", claim.split], ["证据归属", claim.attribution === "vendor" ? "厂商声明" : claim.attribution === "third_party" ? "第三方评测" : null],
    ["样本数", claim.sampleSize === null ? null : String(claim.sampleSize)],
    ["置信区间", interval ? `${interval.lower}–${interval.upper}${claim.unit ? ` ${claim.unit}` : ""}${interval.level === null ? "（置信水平未确认）" : `（置信水平 ${interval.level}%）`}` : null],
    ["数据开放状态", claim.dataAvailability === "public" ? "原文声明公开" : claim.dataAvailability === "restricted" ? "原文声明受限" : null],
  ];
}

export function paperVersionCaption(paper: PaperRef): string {
  const version = paper.version === null ? "版本未确认" : `v${paper.version}`;
  return paper.latestVersion !== null && paper.latestVersion !== paper.version ? `${version} · 已记录至 v${paper.latestVersion}` : version;
}
export const paperMaterialKey = (material: Pick<PaperMaterial, "itemId" | "sourceId" | "sourceUrl">) => JSON.stringify([material.itemId, material.sourceId, material.sourceUrl]);

export function paperListFilters(search: URLSearchParams) {
  const type = search.get("evaluationType");
  return {
    evaluationType: EVALUATION_TYPES.includes(type as EvaluationType) ? type as EvaluationType : null,
    q: search.get("q")?.trim().slice(0, 200) || null,
    sourceId: search.get("sourceId")?.trim() || null,
    cursor: search.get("cursor") || null,
  };
}
