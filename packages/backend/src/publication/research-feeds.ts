import { SITE } from "@aihot/industry/site";
import { escapeXml } from "../lib/text.ts";
import { siteUrl } from "./links.ts";
import { listPapers } from "./papers.ts";

export async function paperFeed(now = new Date()): Promise<string> {
  const { items } = await listPapers({ limit: 50, now });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${escapeXml(`${SITE.name} · 论文索引`)}</title><link>${escapeXml(siteUrl("/papers"))}</link><description>已有公开论文的来源与版本记录；评测类型待逐步核对，重要结论请回原文。</description>${items.map(paper => `<item><guid isPermaLink="false">${escapeXml(paper.id)}</guid><title>${escapeXml(paper.title)}</title><link>${escapeXml(siteUrl(`/papers/${encodeURIComponent(paper.id)}`))}</link><pubDate>${new Date(paper.lastSeenAt).toUTCString()}</pubDate><description>${escapeXml(`${paper.arxivId} · ${paper.latestVersion === null ? "版本未确认" : `v${paper.latestVersion}`} · ${paper.materialCount}份来源材料\n${paper.canonicalUrl}`)}</description></item>`).join("")}</channel></rss>`;
}
