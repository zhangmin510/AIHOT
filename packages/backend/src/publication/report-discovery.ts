// Shared by the live API and snapshot exporter; industry configuration controls report discovery.
import { ENABLED_REPORT_KINDS, isReportKindEnabled } from "@aihot/industry/features";

export interface ReportOpenApiDocument {
  paths: Record<string, unknown>;
  info?: { description?: string };
  components?: Record<string, unknown>;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, unknown>) => ({ type: "object", required: Object.keys(properties), properties });
const array = (items: unknown) => ({ type: "array", items });
const REPORT_SCHEMAS = ["ReportKind", "ReportKey", "ReportLinks", "ReportCitation", "ReportEntry", "Report", "ReportsResponse", "ReportResponse"];

/** Return a new document: keep the industry template reusable, including optional daily support. */
export function configureReportOpenApi<T extends ReportOpenApiDocument>(doc: T): T {
  const configured = structuredClone(doc);
  const kinds = [...ENABLED_REPORT_KINDS];
  if (!isReportKindEnabled("daily")) {
    for (const path of Object.keys(configured.paths)) if (/^\/api\/v1\/dailies(?:\/|$)/.test(path)) delete configured.paths[path];
  }
  for (const path of ["/api/v1/reports/{kind}", "/api/v1/reports/{kind}/{key}"]) delete configured.paths[path];
  const components = configured.components ??= {};
  const schemas = (components.schemas ??= {}) as Record<string, unknown>;
  if (!isReportKindEnabled("daily")) {
    for (const name of Object.keys(schemas)) if (/^Dail(?:y|ies)/.test(name)) delete schemas[name];
  }
  for (const name of REPORT_SCHEMAS) delete schemas[name];
  if (configured.info) {
    let description = configured.info.description ?? "";
    if (!isReportKindEnabled("daily")) description = description.replace(/Show the daily digest\s*->\s*\/api\/v1\/dailies\/latest\.\s*/g, "");
    description = description.replace(/\n\nEdited reports:[^\n]*/g, "");
    configured.info.description = `${description}\n\nEdited reports: ${kinds.length ? `enabled kinds are ${kinds.join(", ")}. List issues at /api/v1/reports/{kind}, then read /api/v1/reports/{kind}/{key}; latest resolves to the newest existing issue. Missing periods return 404 and are never replaced with another issue. Reports can be regenerated or have withdrawn evidence removed; honour ETag and Cache-Control.` : "disabled for this industry."}`;
  }
  if (!kinds.length) return configured;

  const text = { type: "string" };
  const nullableText = { type: ["string", "null"] };
  const timestamp = { type: "string", format: "date-time" };
  const keyPatterns = {
    daily: "^\\d{4}-\\d{2}-\\d{2}$",
    weekly: "^\\d{4}-W(?:0[1-9]|[1-4]\\d|5[0-3])$",
    monthly: "^\\d{4}-(?:0[1-9]|1[0-2])$",
  };
  Object.assign(schemas, {
    ReportKind: { type: "string", enum: kinds },
    ReportKey: { type: "string", anyOf: kinds.map(kind => ({ pattern: keyPatterns[kind] })), description: "A real calendar date, ISO week, or month matching kind. An impossible ISO week is invalid even when its spelling matches the pattern." },
    ReportLinks: object({ aihot: { type: "string", format: "uri" } }),
    ReportCitation: object({
      itemId: nullableText, title: text, summary: nullableText, source: object({ name: text }),
      links: object({ aihot: { type: ["string", "null"], format: "uri" }, original: { type: "string", description: "Original source URL when present; may be empty." } }),
      attribution: ref("Attribution"),
    }),
    ReportEntry: object({ kind: ref("ReportKind"), key: ref("ReportKey"), title: nullableText, generatedAt: timestamp, links: ref("ReportLinks"), attribution: ref("Attribution") }),
    Report: object({
      kind: ref("ReportKind"), key: ref("ReportKey"), title: text, headline: nullableText, overview: nullableText,
      generatedAt: timestamp, windowStart: timestamp, windowEnd: timestamp, revision: { type: "integer", minimum: 1 },
      links: ref("ReportLinks"), attribution: ref("Attribution"),
      lead: { ...object({ title: text, leadParagraph: text }), type: ["object", "null"] },
      sections: array(object({ label: text, summary: nullableText, items: array(ref("ReportCitation")) })),
      stories: array(ref("ReportCitation")), flashes: array(ref("ReportCitation")),
    }),
    ReportsResponse: object({ schemaVersion: { const: 1 }, kind: ref("ReportKind"), count: { type: "integer", minimum: 0 }, items: array(ref("ReportEntry")) }),
    ReportResponse: object({ schemaVersion: { const: 1 }, report: ref("Report") }),
  });
  const kindParameter = { name: "kind", in: "path", required: true, schema: ref("ReportKind"), description: "An enabled report kind from the industry configuration." };
  const parameters = [{ $ref: "#/components/parameters/ActorUserAgent" }, { $ref: "#/components/parameters/IfNoneMatch" }, kindParameter];
  const responses = (schema: string) => ({
    "200": { description: "Public report projection. Withdrawn citations and dependent prose are filtered.", headers: { ETag: { schema: text }, "Cache-Control": { schema: text } }, content: { "application/json": { schema: ref(schema) } } },
    "304": { description: "Unchanged; empty response body." },
    "400": { description: "Invalid query or report key.", content: { "application/problem+json": { schema: ref("Problem") } } },
    "404": { description: "Disabled kind or missing issue. No substitute period is returned.", content: { "application/problem+json": { schema: ref("Problem") } } },
  });
  configured.paths["/api/v1/reports/{kind}"] = { get: {
    operationId: "reports", summary: "List existing public report issues", description: "Newest issue key first. Only real, generated issues are listed; an empty collection returns items: []. Unknown query parameters are rejected.",
    parameters: [...parameters, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 180, default: 30 } }], responses: responses("ReportsResponse"),
  } };
  configured.paths["/api/v1/reports/{kind}/{key}"] = { get: {
    operationId: "reportByKey", summary: "Read an existing public report issue", description: "Omit no path segment: use latest or an existing issue key. Weekly keys use real ISO weeks (YYYY-Www); monthly keys use YYYY-MM. Statistics cover [windowStart, windowEnd), with the original generation time and revision returned. No query parameters are accepted.",
    parameters: [...parameters, { name: "key", in: "path", required: true, schema: { anyOf: [{ const: "latest" }, ref("ReportKey")] } }], responses: responses("ReportResponse"),
  } };
  return configured;
}
