// The MCP tool names, from the site's prefix (industry/site.ts): llms.txt, the agent page and the server
// list the same names.
import { SITE } from "@aihot/industry/site";
import { isReportKindEnabled } from "@aihot/industry/features";

const p = SITE.mcpPrefix;

export const MCP_TOOL_NAMES = {
  latest: `${p}_get_latest`,
  search: `${p}_search`,
  hot: `${p}_get_hot_topics`,
  story: `${p}_get_story`,
  daily: `${p}_get_daily`,
  weekly: `${p}_get_weekly`,
  monthly: `${p}_get_monthly`,
  radar: `${p}_get_leaderboard_events`,
  papers: `${p}_get_papers`,
  paper: `${p}_get_paper`,
  evidence: `${p}_get_evidence`,
  modelHistory: `${p}_get_model_history`,
} as const;

export const MCP_TOOLS = Object.entries(MCP_TOOL_NAMES)
  .filter(([key]) => !["daily", "weekly", "monthly"].includes(key) || isReportKindEnabled(key))
  .map(([, name]) => ({ name }));
