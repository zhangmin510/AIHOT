import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CATEGORY_KEYS, PUBLIC_API_CATEGORY_KEYS, toPublicApiCategory } from "@aihot/contracts/taxonomy";
import { EVIDENCE_TAGS } from "@aihot/industry/evaluation";
import { TOPIC_TAGS } from "@aihot/industry/taxonomy";
import { normalizeTags } from "@aihot/backend/editorial/vocabulary";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";

test("website, API and RSS share the three evaluation categories", () => {
  assert.deepEqual(CATEGORY_KEYS, ["ai-models", "agent", "ai-products"]);
  assert.deepEqual(PUBLIC_API_CATEGORY_KEYS, CATEGORY_KEYS);
  for (const key of CATEGORY_KEYS) assert.equal(toPublicApiCategory(key), key);
  assert.equal(toPublicApiCategory("tip"), null);
});

test("automated vocabulary preserves explicit evidence and cannot create site test results", () => {
  for (const tag of EVIDENCE_TAGS) assert.ok((TOPIC_TAGS as readonly string[]).includes(tag));
  assert.deepEqual(normalizeTags(["评测/基准", "第三方评测", "可复现方法"]), ["评测/基准", "第三方评测", "可复现方法"]);
  assert.deepEqual(normalizeTags(["模型发布", "本站实测"]), ["模型发布"]);
  assert.deepEqual(normalizeTags(["模型发布"]), ["模型发布"]);
});

test("initial source pack has valid unique configurations and no fulltext permission assumption", () => {
  const { sources } = JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8"));
  assert.equal(new Set(sources.map((s: { id: string }) => s.id)).size, sources.length);
  for (const source of sources) {
    assertSupportedConfig(source.kind, source.config);
    assert.equal(source.site_fulltext, false);
    assert.equal(source.syndicate_fulltext, false);
    assert.equal(source.participation_mode, "editorial");
  }
});
