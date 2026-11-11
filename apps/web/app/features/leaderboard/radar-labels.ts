import type { LeaderboardEventType } from "@aihot/contracts/radar";

export const radarLabels: Record<LeaderboardEventType, string> = {
  new_leader: "榜首变化",
  top10_entry: "首次进入前十",
  new_board: "新榜单",
  methodology_change: "方法论改版",
};
