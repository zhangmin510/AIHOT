import assert from "node:assert/strict";
import { test } from "node:test";
import { archiveGroups, chipLabel, disabledReportRedirect, KINDS, kindFromPath, metricItems, REPORT_LABEL } from "../app/features/report/format.ts";

const entry = (key: string) => ({ key, title: null });

test("report navigation exposes weekly and monthly while preserving legacy URL redirects", () => {
  assert.deepEqual(KINDS, ["weekly", "monthly"]);
  assert.equal(REPORT_LABEL, "周报 / 月报");
  for (const path of ["/daily", "/daily/archive", "/daily/2026-10-03"]) assert.equal(disabledReportRedirect(path), "/weekly?from=daily");
  for (const path of ["/weekly", "/weekly/2026-W40", "/monthly", "/monthly/2026-10"]) assert.equal(disabledReportRedirect(path), null);
  assert.equal(kindFromPath("/monthly/2026-10"), "monthly");
  assert.equal(kindFromPath("/weekly/2026-W40"), "weekly");
  assert.deepEqual(metricItems({ totalEvents: 2, reportsCovered: 7 }), [{ value: 2, unit: "件大事" }]);
});

test("weekly archive and mobile labels use calendar Mondays, even when earlier issues are missing", () => {
  const only = [entry("2026-W40")]; // Monday September 28: fourth Monday in September.
  assert.deepEqual(archiveGroups("weekly", only), [{
    id: "2026-09", label: "2026 年 9 月", entries: [{ ...only[0], short: "第4周" }],
  }]);
  assert.equal(chipLabel("weekly", "2026-W40", only, "2026-10-03"), "9月第4周");
  assert.equal(chipLabel("weekly", "2026-W40", [], "2026-10-03"), "9月第4周");
  const sparse = archiveGroups("weekly", [entry("2026-W40"), entry("2026-W38")]);
  assert.deepEqual(sparse[0]!.entries.map(e => e.short), ["第4周", "第2周"]);
});

test("weekly month labels follow the Monday across month and ISO-year boundaries", () => {
  const cases = [
    ["2026-W36", "2026-08", "第5周", "8月第5周"], // August 31–September 6.
    ["2026-W37", "2026-09", "第1周", "9月第1周"], // September 7–13.
    ["2026-W01", "2025-12", "第5周", "12月第5周"], // December 29–January 4.
    ["2026-W02", "2026-01", "第1周", "1月第1周"], // January 5–11.
  ];
  for (const [key, month, short, chip] of cases) {
    const index = [entry(key!)];
    const [group] = archiveGroups("weekly", index);
    assert.equal(group!.id, month);
    assert.equal(group!.entries[0]!.short, short);
    assert.equal(chipLabel("weekly", key!, index, "2026-10-03"), chip);
  }
});
