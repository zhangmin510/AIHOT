import type { ReportKind } from "./site.ts";
import { isValidDate, isoWeekRange } from "./time.ts";

/** Valid keys identify a real edition, never a nearby date substituted for it. */
export function isReportKey(kind: ReportKind, key: string): boolean {
  if (kind === "daily") return isValidDate(key);
  if (kind === "weekly") return isoWeekRange(key) !== null;
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(key) && isValidDate(`${key}-01`);
}
