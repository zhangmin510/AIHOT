// Opens the site's main pages and machine exits and checks each answers: the whole-site check after a
// deploy, and CI's check of the built site on an empty database.
//   node scripts/smoke.ts [--base http://localhost:3000]
import { SITE } from "@aihot/industry/site";
import { ENABLED_REPORT_KINDS, FEATURES, isReportKindEnabled } from "@aihot/industry/features";
import { MCP_TOOLS } from "@aihot/contracts/mcp";

const at = process.argv.indexOf("--base");
const base = (at > 0 ? process.argv[at + 1] : process.env.SITE_URL) ?? "http://localhost:3000";

const PAGES = ["/", "/all", "/hot", ...ENABLED_REPORT_KINDS.map(kind => `/${kind}`), "/topics", "/papers", "/radar", "/starred", "/agent", "/about", "/methodology", "/changelog", "/feedback", "/terms", "/privacy", "/more", "/admin/login"];
const MACHINE: Array<[path: string, type: RegExp]> = [
  ["/api/health", /json/],
  ["/api/v1/items", /json/],
  ["/api/v1/leaderboard-events", /json/],
  ["/api/v1/leaderboard-source-states", /json/],
  ["/api/v1/papers", /json/],
  ["/api/v1/hot-topics", /json/],
  ...ENABLED_REPORT_KINDS.map((kind): [string, RegExp] => [`/api/v1/reports/${kind}`, /json/]),
  ["/api/v1/selected/snapshot", /json/],
  ["/feed.xml", /xml/],
  ["/feed/all.xml", /xml/],
  ["/feed/leaderboard.xml", /xml/],
  ["/feed/papers.xml", /xml/],
  ...ENABLED_REPORT_KINDS.map((kind): [string, RegExp] => [`/feed/${kind}.xml`, /xml/]),
  ["/llms.txt", /text\/plain/],
  ["/robots.txt", /text\/plain/],
  ["/sitemap.xml", /xml/],
  ["/manifest.webmanifest", /manifest/],
  ["/openapi-v1.json", /json/],
  ["/og/site.png", /image\/png/],
  ["/icon.png", /image\/png/],
  ["/favicon.ico", /icon/],
];
// The leaderboard pages answer 503 until the first round is published (a fresh site computes it when
// the worker starts; with collection off there is nothing to compute).
const LEADERBOARD = FEATURES.leaderboard ? ["/leaderboard", "/leaderboard/rules", "/leaderboard/sources"] : [];
PAGES.push(...LEADERBOARD);
if (FEATURES.codexResetMonitor) PAGES.push("/codex-reset");

let failed = 0;
async function check(path: string, expect: (res: Response, body: string) => string | null, status = 200) {
  try {
    const res = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const body = res.headers.get("content-type")?.startsWith("image/") ? "" : await res.text();
    if (res.status === 503 && LEADERBOARD.includes(path)) {
      console.log(`– ${path}  no leaderboard round published yet`);
      return;
    }
    const problem = res.status !== status ? `HTTP ${res.status} (expected ${status})` : expect(res, body);
    console.log(`${problem ? "✗" : "✓"} ${path}${problem ? `  ${problem}` : ""}`);
    if (problem) failed += 1;
  } catch (error) {
    console.log(`✗ ${path}  ${String(error)}`);
    failed += 1;
  }
}

for (const path of PAGES) await check(path, (_res, body) => (body.includes(SITE.name) ? null : `the page does not name ${SITE.name}`));
for (const [path, type] of MACHINE) await check(path, (res) => (type.test(res.headers.get("content-type") ?? "") ? null : `content-type ${res.headers.get("content-type")}`));
if (!isReportKindEnabled("daily")) {
  for (const path of ["/daily", "/daily/archive", "/daily/2026-10-03"]) await check(path, res => res.headers.get("location") === `/${FEATURES.reports.defaultKind}?from=daily` ? null : `unexpected redirect ${res.headers.get("location")}`, 308);
  for (const path of ["/feed/daily.xml", "/api/site/reports/daily", "/api/site/reports/daily/latest-page", "/api/v1/dailies", "/api/v1/dailies/latest", "/api/v1/reports/daily", "/api/v1/reports/daily/latest"]) await check(path, () => null, 404);
}
// MCP: the handshake and tool inventory match the enabled read-only public surface.
async function rpc(method: string, params: unknown, id: number) {
  const response = await fetch(`${base}/api/mcp`, {
    method: "POST", signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream") ? text.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5))).find(value => value.id === id) : JSON.parse(text);
  if (payload?.id !== id || payload.error) throw new Error("Invalid MCP response");
  return payload.result;
}
try {
  const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } }, 1);
  if (initialized.serverInfo.name !== SITE.mcpPrefix) throw new Error("Unexpected MCP server name");
  const listed = await rpc("tools/list", {}, 2);
  const expected = MCP_TOOLS.map(tool => tool.name).sort();
  const actual = listed.tools.map((tool: { name: string }) => tool.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Unexpected MCP inventory: ${actual.join(", ")}`);
  console.log(`✓ /api/mcp initialize and ${expected.length} enabled tools`);
} catch (error) {
  console.log(`✗ /api/mcp  ${String(error)}`);
  failed += 1;
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
