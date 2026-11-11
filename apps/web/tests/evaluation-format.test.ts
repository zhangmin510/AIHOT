import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvaluationEvidenceClaim, PaperRef } from "@aihot/contracts/evaluation";
import { evidenceClaimFields, missingEvidenceLabels, paperListFilters, paperMaterialKey, paperVersionCaption } from "../app/features/item/evaluation.ts";
import { queryString } from "../app/lib/api.server.ts";

const claim: EvaluationEvidenceClaim = { id: "claim-1", statement: "Accuracy", model: null, modelVersion: null, benchmark: "Bench", benchmarkVersion: "1",
  metric: "accuracy", value: 0, unit: "%", split: null, conditions: [], sampleSize: null, confidenceInterval: { lower: 0, upper: 2, level: 95 },
  attribution: null, codeUrl: null, dataUrl: null, dataAvailability: null, support: { quote: null, start: 5, end: 20, label: null, url: "https://example.org/paper" } };

test("evidence fields preserve zero and show interval units without inventing openness or attribution", () => {
  const fields = new Map(evidenceClaimFields(claim));
  assert.equal(fields.get("数值"), "0 %");
  assert.equal(fields.get("置信区间"), "0–2 %（置信水平 95%）");
  assert.equal(fields.get("证据归属"), null);
  assert.equal(fields.get("数据开放状态"), null);
  assert.equal(fields.get("样本数"), null);
  assert.equal(new Map(evidenceClaimFields({ ...claim, dataAvailability: "restricted", attribution: "vendor" })).get("数据开放状态"), "原文声明受限");
  assert.deepEqual(missingEvidenceLabels(["modelVersion", "conditions", "dataAvailability", "conditions", "future_internal_field"]), ["模型版本", "测试条件", "数据开放状态", "其他测试信息"]);
});

test("paper references distinguish an unknown version from a known earlier version without duplicate captions", () => {
  const paper: PaperRef = { id: "arxiv:2611.12345", arxivId: "2611.12345", title: "Paper", canonicalUrl: "https://arxiv.org/abs/2611.12345", version: 1, latestVersion: 2 };
  assert.equal(paperVersionCaption(paper), "v1 · 已记录至 v2");
  assert.equal(paperVersionCaption({ ...paper, version: 2 }), "v2");
  assert.equal(paperVersionCaption({ ...paper, version: null }), "版本未确认 · 已记录至 v2");
  assert.equal(paperVersionCaption({ ...paper, version: null, latestVersion: null }), "版本未确认");
  const material = { itemId: "shared-item", sourceId: "source-a", sourceUrl: "https://arxiv.org/abs/2611.12345" };
  assert.notEqual(paperMaterialKey(material), paperMaterialKey({ ...material, sourceId: "source-b" }), "separate discoveries of one item need separate React keys");
});

test("paper pagination keeps the same type, literal search and source filter with a clean new cursor", () => {
  const filters = paperListFilters(new URLSearchParams("evaluationType=eval_method&q=%20Accuracy%25_%20&sourceId=source-a&cursor=arxiv%3A2611.00001"));
  assert.deepEqual(filters, { evaluationType: "eval_method", q: "Accuracy%_", sourceId: "source-a", cursor: "arxiv:2611.00001" });
  const next = new URL(`https://example.org/papers${queryString({ ...filters, cursor: "arxiv:2611.00002" })}`);
  assert.deepEqual(paperListFilters(next.searchParams), { ...filters, cursor: "arxiv:2611.00002" });
  assert.equal(paperListFilters(new URLSearchParams("evaluationType=unrecognised&q=%20%20")).evaluationType, null);
  assert.equal(paperListFilters(new URLSearchParams(`q=${"x".repeat(300)}`)).q!.length, 200);
});
