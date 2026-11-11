// Deterministic evidence checks. These establish text/quantity correspondence, not scientific truth.
import { z } from "zod";
import { EVALUATION_TYPES, type EvaluationEvidenceClaim, type EvaluationType } from "@aihot/contracts/evaluation";
import type { AnalyzeInputArticle } from "./input.ts";
import { matchEntityIds } from "./writing.ts";

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional().default(null);
const ClaimSchema = z.object({
  model: nullableText(100), modelVersion: nullableText(80), benchmark: nullableText(120), benchmarkVersion: nullableText(80),
  metric: nullableText(100), value: z.number().finite().nullable().optional().default(null), unit: nullableText(50), split: nullableText(100),
  conditions: z.array(z.string().trim().min(1).max(160)).max(8).optional().default([]),
  sampleSize: z.number().int().positive().nullable().optional().default(null),
  confidenceInterval: z.object({ lower: z.number().finite(), upper: z.number().finite(), level: z.number().min(0).max(100).nullable().optional().default(null) }).nullable().optional().default(null),
  attribution: z.enum(["vendor", "third_party"]).nullable().optional().default(null),
  codeUrl: nullableText(1000), dataUrl: nullableText(1000),
  dataAvailability: z.enum(["public", "restricted"]).nullable().optional().default(null),
  supportingQuote: z.string().trim().min(1).max(1200), locator: nullableText(160),
});
export const EvaluationExtractionSchema = z.object({
  evaluationType: z.enum(EVALUATION_TYPES).nullable().optional().default(null),
  claims: z.array(ClaimSchema).max(6).optional().default([]),
});
export type EvaluationExtraction = z.infer<typeof EvaluationExtractionSchema>;
export interface CheckedEvidenceClaim extends EvaluationEvidenceClaim { issues: string[] }
export interface CheckedEvaluationEvidence {
  evaluationType: EvaluationType | null;
  status: "matched" | "needs_review";
  claims: CheckedEvidenceClaim[];
  issues: string[];
  missingFields: string[];
  checkedAt: string;
  inputRevision: number;
  validationVersion: string;
  copyBlocked: boolean;
}

export const EVIDENCE_VALIDATION_VERSION = "evidence-v2";
export const evidenceSourceText = (article: AnalyzeInputArticle) => `${article.title}\n${article.bodyText ?? article.excerpt ?? String(article.xPost?.text ?? "")}`;
const canonical = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const present = (text: string, value: string) => canonical(text).includes(canonical(value));
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function versionSupported(quote: string, entity: string | null, version: string) {
  if (!entity) return false;
  const name = canonical(entity), text = canonical(quote), release = canonical(version).replace(/^v(?:ersion)?\s*/, "");
  if (new RegExp(`(?:^|[^\\d])${escaped(release)}(?:$|[^\\w.])`, "i").test(name) && present(text, name)) return true;
  let position = text.indexOf(name);
  while (position >= 0) {
    const after = text.slice(position + name.length, position + name.length + release.length + 25);
    if (new RegExp(`^[\\s:/_()=\\-]*(?:v(?:ersion)?[\\s:\\-]*)?${escaped(release)}(?=$|[\\s,;:)/])`, "i").test(after)) return true;
    position = text.indexOf(name, position + name.length);
  }
  return false;
}

/** Retains offsets in the stored source while tolerating only whitespace/NFKC rendering changes. */
export function locateEvidence(source: string, quote: string): { start: number; end: number } | null {
  const exact = source.indexOf(quote);
  if (exact >= 0) return { start: exact, end: exact + quote.length };
  let normalized = "";
  const offsets: number[] = [];
  for (let index = 0; index < source.length; index++) {
    const chunk = source[index]!.normalize("NFKC");
    for (const character of chunk) {
      if (/\s/.test(character)) {
        if (normalized.endsWith(" ") || !normalized) continue;
        normalized += " "; offsets.push(index);
      } else { normalized += character; offsets.push(index); }
    }
  }
  const needle = quote.normalize("NFKC").replace(/\s+/g, " ").trim();
  const start = normalized.indexOf(needle);
  return start < 0 ? null : { start: offsets[start]!, end: offsets[start + needle.length - 1]! + 1 };
}

interface Quantity { value: number; dimension: string; start: number; end: number; unitEnd: number }
function quantity(value: number, unit: string | null) {
  const normalized = canonical(unit ?? "").replace(/\./g, "");
  if (["%", "percent", "percentage", "百分比"].includes(normalized)) return { value: value / 100, dimension: "ratio" };
  if (["ratio", "fraction", "比例"].includes(normalized)) return { value, dimension: "ratio" };
  if (["ms", "milliseconds", "millisecond", "毫秒"].includes(normalized)) return { value: value / 1000, dimension: "time" };
  if (["s", "sec", "seconds", "second", "秒"].includes(normalized)) return { value, dimension: "time" };
  if (["m", "million", "百万"].includes(normalized)) return { value: value * 1e6, dimension: "count" };
  if (["b", "billion", "十亿"].includes(normalized)) return { value: value * 1e9, dimension: "count" };
  if (normalized === "万") return { value: value * 1e4, dimension: "count" };
  if (normalized === "亿") return { value: value * 1e8, dimension: "count" };
  if (["token", "tokens", "samples", "sample", "样本"].includes(normalized)) return { value, dimension: "count" };
  if (["$", "usd", "美元"].includes(normalized)) return { value, dimension: "currency:usd" };
  return { value, dimension: normalized || "number" };
}

function quantities(text: string): Quantity[] {
  const out: Quantity[] = [];
  const pattern = /[+-]?\d[\d,]*(?:\.\d+)?(?:e[+-]?\d+)?/gi;
  for (const match of text.matchAll(pattern)) {
    const index = match.index!;
    let raw = match[0];
    if (/^[+-]/.test(raw) && /[\p{L}\d]/u.test(text[index - 1] ?? "")) raw = raw.slice(1); // GPT-4.1 is not negative.
    const tail = text.slice(index + match[0].length);
    const unitMatch = /^\s*(%|percent(?:age)?\b|milliseconds?\b|ms\b|seconds?\b|sec\b|s\b|million\b|billion\b|M\b|B\b|tokens?\b|samples?\b|USD\b|百万|十亿|万|亿|毫秒|秒|美元)/i.exec(tail);
    const unit = unitMatch?.[1]
      ?? (/\$\s*$/.test(text.slice(Math.max(0, index - 3), index)) ? "$" : null);
    const parsed = quantity(Number(raw.replaceAll(",", "")), unit);
    if (Number.isFinite(parsed.value)) out.push({ ...parsed, start: index, end: index + match[0].length, unitEnd: index + match[0].length + (unitMatch?.[0].length ?? 0) });
  }
  return out;
}

function equalQuantity(actual: Pick<Quantity, "value" | "dimension">, expected: Pick<Quantity, "value" | "dimension">) {
  const compatible = actual.dimension === expected.dimension
    || (["number", "ratio"].includes(actual.dimension) && ["number", "ratio"].includes(expected.dimension))
    || (["number", "count"].includes(actual.dimension) && ["number", "count"].includes(expected.dimension));
  return compatible && Math.abs(actual.value - expected.value) <= 1e-8 * Math.max(1, Math.abs(expected.value));
}

/** A scalar cannot silently stand for a change, bound or range in this schema. Inspect only the
 * selected number's clause and immediate neighbours, so another result cannot taint this one. */
function unsupportedQuantityRelation(text: string, entry: Quantity): boolean {
  const boundaries = [...text.matchAll(/[;；。!?！？]|\.(?=\s|$)/g)].map(match => match.index!);
  const start = boundaries.filter(at => at < entry.start).at(-1) ?? -1;
  const end = boundaries.find(at => at >= entry.unitEnd) ?? text.length;
  const before = text.slice(Math.max(start + 1, entry.start - 100), entry.start);
  const after = text.slice(entry.unitEnd, Math.min(end, entry.unitEnd + 60));
  const numeral = "[+-]?\\d[\\d,]*(?:\\.\\d+)?(?:\\s*(?:%|percent(?:age)?|ms|s))?";
  if (/^\s*(?:[-–—−]|to\b|through\b)\s*[+-]?\d/.test(after)
    || new RegExp(`${numeral}\\s*(?:[-–—−]|to|through)\\s*$`).test(before)
    || (/\bbetween\b/.test(before) && (/^\s*and\s+\d/.test(after) || new RegExp(`${numeral}\\s+and\\s*$`).test(before)))) return true;
  // "increased to 80%" is a result; "increased by 80%" and "80% reduction" are changes.
  const change = /\b(?:improv\w*|increas\w*|decreas\w*|reduc\w*|exceed\w*|outperform\w*|gain\w*|grew|rose|fell|higher|lower|better|worse)\b/;
  if (change.test(before) && /\b(?:by|of|up to)(?:\s+(?:about|around|approximately|roughly|up to|at least|as much as))*\s*$/.test(before)) return true;
  if (/\b(?:improved|increased|decreased|reduced|gained|exceeded)(?:\s+(?:about|around|approximately|roughly))*\s*$/.test(before)) return true;
  if (/\b(?:improvement|increase|decrease|reduction|gain|drop)(?:\s+(?:of|was|is|about|around|approximately|roughly))*\s*$/.test(before)) return true;
  if (/^\s*(?:(?:relative|absolute|percentage|point)\s+)*(?:improvement|increase|decrease|reduction|gain|drop)\b/.test(after)) return true;
  return /(?:提高|提升|增加|减少|降低|下降|上升|高出|超出|超过)(?:了|约|大约|达)?\s*$/.test(before)
    || /^\s*(?:的)?(?:相对)?(?:提升|提高|增长|降幅|增幅|降低|减少)/.test(after);
}

function metricQuantityIssue(quote: string, metric: string, value: number, unit: string | null): string | null {
  const text = canonical(quote), label = canonical(metric);
  const at = text.indexOf(label);
  if (at < 0) return "metric_value_mismatch";
  const expected = quantity(value, unit);
  const candidates = quantities(text).map((entry) => ({ entry, distance: entry.start >= at + label.length ? entry.start - at - label.length : at - entry.end }))
    .filter(({ distance, entry }) => distance >= 0 && distance <= 60 && !/[;；。!?！？]|\.(?=\s|$)/.test(text.slice(Math.min(at, entry.end), Math.max(at + label.length, entry.start))))
    .sort((a, b) => a.distance - b.distance);
  const selected = candidates[0]?.entry;
  if (!selected) return "metric_value_mismatch";
  if (unsupportedQuantityRelation(text, selected)) return "quantity_relation_not_supported";
  return equalQuantity(selected, expected) ? null : "metric_value_mismatch";
}

/** The nearest quantity belongs to this metric; a number elsewhere in the table is insufficient. */
export function metricQuantityMatches(quote: string, metric: string, value: number, unit: string | null): boolean {
  return metricQuantityIssue(quote, metric, value, unit) === null;
}

function supportedUrl(source: string, value: string | null): string | null {
  if (!value || !source.includes(value)) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}

function statement(claim: z.infer<typeof ClaimSchema>): string {
  return [claim.model && [claim.model, claim.modelVersion].filter(Boolean).join(" "),
    claim.benchmark && [claim.benchmark, claim.benchmarkVersion].filter(Boolean).join(" "),
    claim.metric && `${claim.metric}${claim.value === null ? "" : ` ${claim.value}${claim.unit ? ` ${claim.unit}` : ""}`}`,
    claim.split && `split: ${claim.split}`].filter(Boolean).join(" · ");
}

function copyIssues(copy: { titleZh: string; summaryZh: string }, claims: CheckedEvidenceClaim[]): string[] {
  const text = `${copy.titleZh}\n${copy.summaryZh}`.replace(/https?:\/\/\S+/g, " ");
  const matched = claims.filter((claim) => claim.issues.length === 0);
  const facts = matched.flatMap((claim) => [claim.statement, ...claim.conditions,
    claim.sampleSize === null ? "" : `${claim.sampleSize} samples`,
    claim.confidenceInterval ? `${claim.confidenceInterval.lower} ${claim.unit ?? ""} ${claim.confidenceInterval.upper} ${claim.unit ?? ""} ${claim.confidenceInterval.level ?? ""}%` : ""]);
  const allowed = quantities(facts.join("\n")), errors: string[] = [];
  if (quantities(text).some((q) => !allowed.some((a) => equalQuantity(q, a)))) errors.push("copy_number_not_supported");
  const commonMetrics: Record<string, string[]> = { accuracy: ["准确率", "正确率"], recall: ["召回率"], precision: ["精确率", "查准率"], latency: ["延迟", "时延"] };
  const segments = text.split(/[。！？;；\n]+/).filter(Boolean);
  for (const segment of segments) {
    for (const metric of [...new Set(matched.map((claim) => claim.metric).filter((value): value is string => !!value))]) {
      const aliases = [metric, ...(commonMetrics[canonical(metric)] ?? [])];
      const mentioned = aliases.find((alias) => present(segment, alias));
      if (!mentioned) continue;
      const options = matched.filter((claim) => claim.metric === metric && claim.value !== null);
      if (!options.length) continue;
      const hasModel = options.some((claim) => claim.model && present(segment, claim.model));
      const hasBenchmark = options.some((claim) => claim.benchmark && present(segment, claim.benchmark));
      const scoped = options.filter((claim) => (!hasModel || (claim.model && present(segment, claim.model)))
        && (!hasBenchmark || (claim.benchmark && present(segment, claim.benchmark))));
      if ((!hasModel && !hasBenchmark && new Set(options.map((claim) => `${claim.value}:${claim.unit}`)).size > 1)
        || !scoped.some((claim) => metricQuantityMatches(segment, mentioned, claim.value!, claim.unit))) errors.push("copy_metric_value_mismatch");
    }
    for (const claim of matched) {
      for (const [entity, version] of [[claim.model, claim.modelVersion], [claim.benchmark, claim.benchmarkVersion]]) {
        if (!entity || !version) continue;
        const pattern = new RegExp(`${escaped(entity)}[\\s\\-]*(?:v(?:ersion)?\\s*)?(\\d+(?:\\.\\d+)*)`, "ig");
        for (const found of segment.matchAll(pattern)) if (canonical(found[1]!) !== canonical(version).replace(/^v(?:ersion)?\s*/, "")) errors.push("copy_version_not_supported");
      }
    }
  }
  const conditions = [...text.matchAll(/\b(?:zero|one|few|\d+)[- ]shot\b|\b(?:with|without|no) (?:tools|retrieval)\b/gi)].map((match) => canonical(match[0]).replaceAll(" ", "-"));
  const allowedConditions = matched.flatMap((claim) => claim.conditions.map((condition) => canonical(condition).replaceAll(" ", "-")));
  if (conditions.some((condition) => !allowedConditions.some((allowed) => allowed.includes(condition)))) errors.push("copy_condition_not_supported");
  return errors;
}

export function validateEvaluationEvidence(extraction: EvaluationExtraction, article: AnalyzeInputArticle, copy?: { titleZh: string; summaryZh: string }, now = new Date()): CheckedEvaluationEvidence {
  const source = evidenceSourceText(article);
  const claims: CheckedEvidenceClaim[] = [];
  const issues: string[] = [], missing = new Set<string>();
  for (const [index, claim] of extraction.claims.entries()) {
    const errors: string[] = [];
    const located = locateEvidence(source, claim.supportingQuote);
    if (!located || claim.supportingQuote.trim().length < 8) errors.push("support_not_found");
    const quote = located ? source.slice(located.start, located.end) : "";
    for (const field of ["model", "benchmark", "metric", "split"] as const) {
      if (claim[field] && !present(quote, claim[field]!)) errors.push(`${field}_not_supported`);
    }
    if (claim.modelVersion && !versionSupported(quote, claim.model, claim.modelVersion)) errors.push("modelVersion_not_supported");
    if (claim.benchmarkVersion && !versionSupported(quote, claim.benchmark, claim.benchmarkVersion)) errors.push("benchmarkVersion_not_supported");
    for (const condition of claim.conditions) if (!present(quote, condition)) errors.push("condition_not_supported");
    if (claim.value !== null) {
      const issue = claim.metric ? metricQuantityIssue(quote, claim.metric, claim.value, claim.unit) : "metric_value_mismatch";
      if (issue) errors.push(issue);
    }
    if (claim.value === null && claim.unit !== null) errors.push("value_missing");
    if (!claim.model && !claim.benchmark && !claim.metric) errors.push("claim_fields_missing");
    if (claim.sampleSize !== null && !new RegExp(`(?:\\bn\\s*[=:]\\s*${claim.sampleSize}\\b|\\b${claim.sampleSize}\\s*(?:samples?|tasks?|examples?)\\b|${claim.sampleSize}\\s*(?:个|条)?样本)`, "i").test(quote)) errors.push("sample_size_not_supported");
    if (claim.confidenceInterval) {
      const ci = claim.confidenceInterval;
      if (ci.lower > ci.upper || !/\bci\b|confidence|置信/i.test(quote)
        || ![ci.lower, ci.upper, ...(ci.level === null ? [] : [ci.level])].every((n) => quantities(quote).some((q) => equalQuantity(q, quantity(n, n === ci.level ? "%" : claim.unit))))) errors.push("confidence_interval_not_supported");
    }
    if (claim.attribution === "third_party" && article.source.ownerEntityId && matchEntityIds([claim.model]).includes(article.source.ownerEntityId)) errors.push("vendor_claim_not_independent");
    if (claim.attribution === "third_party" && !/\bwe (?:evaluated|tested|ran|measured)\b|\bindependent (?:evaluation|test|assessment)\b|\bthird[- ]party\b|独立(?:评测|测试)|第三方(?:评测|测试)|我们(?:评测|测试|实测)/i.test(quote)) errors.push("independent_test_not_supported");
    if (claim.dataAvailability === "public" && !/\b(?:data|dataset)(?:\s+(?:is|are|will|be|made|available|now|freely)){0,6}\s+(?:public|open)\b|\bpublic(?:ly)?(?:\s+(?:available|released))?\s+(?:data|dataset)\b|(?:数据|数据集).{0,12}(?:公开|开放)|(?:公开|开放).{0,6}(?:数据|数据集)/i.test(quote)) errors.push("data_availability_not_supported");
    if (claim.dataAvailability === "restricted" && !/\b(?:data|dataset)(?:\s+(?:is|are|will|be|remain|available)){0,6}\s+(?:restricted|private|closed)\b|\b(?:restricted|private|closed)\s+(?:data|dataset)\b|(?:数据|数据集).{0,12}(?:受限|不公开|未开放)/i.test(quote)) errors.push("data_availability_not_supported");
    const codeUrl = supportedUrl(source, claim.codeUrl), dataUrl = supportedUrl(source, claim.dataUrl);
    if (claim.codeUrl && !codeUrl) errors.push("code_url_not_supported");
    if (claim.dataUrl && !dataUrl) errors.push("data_url_not_supported");
    if (claim.value !== null) for (const field of ["modelVersion", "benchmarkVersion", "split", "sampleSize"] as const) if (claim[field] === null) missing.add(field);
    if (claim.value !== null && claim.conditions.length === 0) missing.add("conditions");
    if (claim.attribution === null) missing.add("attribution");
    if (claim.dataAvailability === null) missing.add("dataAvailability");
    issues.push(...errors);
    const { supportingQuote: _quote, locator, ...fields } = claim;
    claims.push({ ...fields, id: `claim-${index + 1}`, statement: statement(claim), codeUrl, dataUrl,
      support: { quote: located ? quote : null, start: located?.start ?? 0, end: located?.end ?? 0,
        label: locator && present(source, locator) ? locator : null, url: article.url }, issues: [...new Set(errors)] });
  }
  if (!claims.length) issues.push("evidence_missing");
  // A matching extracted score cannot bless another, invented number in the generated summary.
  if (copy) issues.push(...copyIssues(copy, claims));
  const uniqueIssues = [...new Set(issues)];
  return { evaluationType: extraction.evaluationType, status: uniqueIssues.length || missing.size ? "needs_review" : "matched", claims,
    issues: uniqueIssues, missingFields: [...missing], checkedAt: now.toISOString(), inputRevision: article.revision,
    validationVersion: EVIDENCE_VALIDATION_VERSION, copyBlocked: uniqueIssues.length > 0 };
}
