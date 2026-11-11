// Every public radar outlet consumes these permission-filtered DTOs, including static exports.
import type { LeaderboardEvent, LeaderboardEventPage, LeaderboardEventType, LeaderboardModelHistory, LeaderboardModelHistoryList } from "@aihot/contracts/radar";
import { SITE } from "@aihot/industry/site";
import { sql } from "../db.ts";
import { config } from "../config.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import { escapeXml } from "../lib/text.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { loadSourceStates, sourcePolicies, sourcePolicyVersion } from "../leaderboard/policy.ts";
import { protocolOf } from "../leaderboard/protocol.ts";

interface EventRow {
  id:string; event_key:string; source_key:string; type:LeaderboardEventType; metric_key:string|null; configuration_key:string|null;
  protocol:string; previous_protocol:string; state:"comparable"|"observation"; occurred_at:Date; detected_at:Date; time_basis:"upstream_publication"|"first_observed";
  payload: Pick<LeaderboardEvent,"sourceName"|"sourceUrl"|"model"|"title"|"summary"|"oldEvidence"|"newEvidence">;
}

const eventUrl = (id: string) => new URL(`/radar/${id}`,config.siteUrl).href;
function dto(row: EventRow, attribution: string): LeaderboardEvent {
  const version=sha256(stableJson({eventKey:row.event_key,state:row.state,payload:row.payload,protocol:row.protocol,previousProtocol:row.previous_protocol,attribution}));
  return { ...row.payload,id:row.id,version,type:row.type,sourceKey:row.source_key,metricKey:row.metric_key,configurationKey:row.configuration_key,
    protocol:row.protocol,previousProtocol:row.previous_protocol,state:row.state,occurredAt:row.occurred_at.toISOString(),detectedAt:row.detected_at.toISOString(),timeBasis:row.time_basis,url:eventUrl(row.id),attribution };
}

export async function listLeaderboardEvents(opts: {limit?:number;cursor?:string;source?:string;type?:LeaderboardEventType;model?:string} = {}): Promise<LeaderboardEventPage> {
  const limit = Math.max(1,Math.min(100,Math.trunc(opts.limit ?? 30)));
  const sources = await sql<{source_key:string}[]>`SELECT DISTINCT source_key FROM lb_events WHERE withdrawn_at IS NULL`;
  const policies = await sourcePolicies(sources.map((source) => source.source_key));
  const allowed = [...policies.values()].filter((policy) => policy.publicEvents && policy.publicRows && (!opts.source || policy.sourceKey===opts.source)).map((policy) => policy.sourceKey);
  const binding = queryBinding({source:opts.source??null,type:opts.type??null,model:opts.model??null,policy:sourcePolicyVersion(policies)});
  let after: {at:string;id:string;binding:string}|null=null;
  if (opts.cursor) {
    after=decodeCursor("lbe1",opts.cursor);
    if (after.binding!==binding || typeof after.id!=="string" || typeof after.at!=="string" || !Number.isFinite(Date.parse(after.at))) throw new InvalidCursorError("leaderboard event cursor does not match query");
  }
  if (!allowed.length) return {items:[],nextCursor:null};
  const rows = await sql<EventRow[]>`SELECT * FROM lb_events WHERE withdrawn_at IS NULL AND source_key=ANY(${allowed})
    ${opts.type ? sql`AND type=${opts.type}` : sql``} ${opts.model ? sql`AND payload->'model'->>'slug'=${opts.model}` : sql``}
    ${after ? sql`AND (occurred_at,id)<(${after.at}::timestamptz,${after.id})` : sql``}
    ORDER BY occurred_at DESC,id DESC LIMIT ${limit+1}`;
  const page=rows.slice(0,limit),last=page.at(-1);
  return {items:page.map((row)=>dto(row,policies.get(row.source_key)!.attribution)),nextCursor:rows.length>limit&&last?encodeCursor("lbe1",{at:last.occurred_at.toISOString(),id:last.id,binding}):null};
}

export async function leaderboardEvent(id:string):Promise<LeaderboardEvent|null> {
  const [row]=await sql<EventRow[]>`SELECT * FROM lb_events WHERE id=${id} AND withdrawn_at IS NULL`;
  if(!row)return null;
  const policy=(await sourcePolicies([row.source_key])).get(row.source_key)!;
  return policy.publicEvents&&policy.publicRows?dto(row,policy.attribution):null;
}

export async function leaderboardEventFeed():Promise<string> {
  const page=await listLeaderboardEvents({limit:50});
  const home=new URL("/radar",config.siteUrl).href,self=new URL("/feed/leaderboard.xml",config.siteUrl).href;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${escapeXml(`${SITE.name} · 评测变动`)}</title><link>${escapeXml(home)}</link><description>榜单变化与方法论版本观察；数字来自来源快照。</description><atom:link href="${escapeXml(self)}" rel="self" type="application/rss+xml" />${page.items.map((event)=>`<item><guid isPermaLink="false">${escapeXml(event.id)}</guid><title>${escapeXml(event.title)}</title><link>${escapeXml(event.url)}</link><pubDate>${new Date(event.occurredAt).toUTCString()}</pubDate><description>${escapeXml(`${event.summary}\n${event.attribution}\n原始来源：${event.sourceUrl}`)}</description></item>`).join("")}</channel></rss>`;
}

export async function leaderboardSourceStates() { return loadSourceStates(); }

/** Enumerate only models with authorised, selected raw evidence; a composite run is unnecessary. */
export async function listModelEvidenceHistories(): Promise<LeaderboardModelHistoryList> {
  const sources = await sql<{ source_key: string }[]>`
    SELECT DISTINCT s.source_key FROM lb_scores c JOIN lb_snapshots s ON s.id=c.snapshot_id
    WHERE c.selected_for_product AND c.raw_score IS NOT NULL`;
  const policies = await sourcePolicies(sources.map((source) => source.source_key));
  const allowed = [...policies.values()].filter((policy) => policy.publicRows).map((policy) => policy.sourceKey);
  if (!allowed.length) return { items: [] };
  const rows = await sql<{ slug: string; name: string; source_count: number; point_count: number }[]>`
    SELECT m.slug,m.name,count(DISTINCT s.source_key)::int AS source_count,
      count(DISTINCT (c.snapshot_id,c.metric_key,split_part(c.configuration_key,'@',1)))::int AS point_count
    FROM lb_scores c JOIN lb_snapshots s ON s.id=c.snapshot_id
    LEFT JOIN lb_aliases a ON a.source_key=s.source_key AND a.alias=c.source_model_name
    JOIN lb_models m ON m.id=coalesce(a.model_id,c.model_id)
    WHERE s.source_key=ANY(${allowed}) AND c.selected_for_product AND c.raw_score IS NOT NULL
    GROUP BY m.id,m.slug,m.name ORDER BY lower(m.name),m.slug`;
  return { items: rows.map((row) => ({ slug: row.slug, name: row.name, sourceCount: row.source_count, pointCount: row.point_count })) };
}

export async function modelEvidenceHistory(slug:string,opts:{limit?:number}={}):Promise<LeaderboardModelHistory|null> {
  const [model]=await sql<{id:string;slug:string;name:string}[]>`SELECT id,slug,name FROM lb_models WHERE slug=${slug}`;
  if(!model)return null;
  const sourceRows=await sql<{source_key:string}[]>`SELECT DISTINCT s.source_key FROM lb_scores c JOIN lb_snapshots s ON s.id=c.snapshot_id LEFT JOIN lb_aliases a ON a.source_key=s.source_key AND a.alias=c.source_model_name WHERE coalesce(a.model_id,c.model_id)=${model.id}`;
  const policies=await sourcePolicies(sourceRows.map((row)=>row.source_key));
  const allowed=[...policies.values()].filter((policy)=>policy.publicRows).map((policy)=>policy.sourceKey);
  if(!allowed.length)return null;
  const limit=Math.max(1,Math.min(400,Math.trunc(opts.limit??120)));
  const rows=await sql<Array<{source_key:string;source_name:string;source_url:string|null;metric_key:string;configuration_key:string;raw_score:number;source_rank:number|null;lower_bound:number|null;upper_bound:number|null;sample_size:number|null;snapshot_id:string;source_published_at:Date|null;published_at:Date|null;metadata:Record<string,unknown>}>>`
    SELECT s.source_key,s.source_name,s.source_url,c.metric_key,c.configuration_key,c.raw_score,c.source_rank,c.lower_bound,c.upper_bound,c.sample_size,c.snapshot_id,c.source_published_at,s.published_at,s.metadata
    FROM lb_scores c JOIN lb_snapshots s ON s.id=c.snapshot_id LEFT JOIN lb_aliases a ON a.source_key=s.source_key AND a.alias=c.source_model_name
    WHERE coalesce(a.model_id,c.model_id)=${model.id} AND s.source_key=ANY(${allowed}) AND c.selected_for_product AND c.raw_score IS NOT NULL
    ORDER BY s.fetched_at DESC,c.metric_key,c.configuration_priority DESC,(c.configuration_kind='FIRST_PARTY') DESC,length(c.source_model_name),c.source_model_name,c.configuration_key LIMIT ${limit}`;
  const groups=new Map<string,LeaderboardModelHistory["series"][number]>();
  const represented=new Set<string>();
  for(const row of rows){
    const protocol=protocolOf(row.source_key,row.metadata),configurationKey=row.configuration_key.split("@")[0]!;
    const key=JSON.stringify([row.source_key,row.metric_key,protocol,configurationKey]);
    const representative=JSON.stringify([row.snapshot_id,row.metric_key,configurationKey]);
    if(represented.has(representative))continue;
    represented.add(representative);
    if(!groups.has(key)){
      let sourceUrl:string|null=null;
      try{const url=new URL(row.source_url??"");if(["http:","https:"].includes(url.protocol)&&!url.username&&!url.password)sourceUrl=url.href;}catch{}
      const policy=policies.get(row.source_key)!;
      groups.set(key,{sourceKey:row.source_key,sourceName:row.source_name,metricKey:row.metric_key,protocol,configurationKey,sourceUrl,attribution:policy.attribution,licenseName:policy.licenseName,evidenceUrl:policy.evidenceUrl,points:[]});
    }
    groups.get(key)!.points.push({at:row.source_published_at?.toISOString()??row.published_at?.toISOString()??null,score:row.raw_score,rank:row.source_rank,lowerBound:row.lower_bound,upperBound:row.upper_bound,sampleSize:row.sample_size,snapshotId:row.snapshot_id,configurationKey:row.configuration_key});
  }
  return {model:{slug:model.slug,name:model.name},series:[...groups.values()].map((series)=>({...series,points:series.points.reverse()}))};
}
