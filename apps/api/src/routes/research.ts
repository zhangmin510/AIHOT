// Research views share the same anonymous publication readers across site and public APIs.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { EVALUATION_TYPES } from "@aihot/contracts/evaluation";
import { listLeaderboardEvents, leaderboardEvent, leaderboardEventFeed, leaderboardSourceStates, modelEvidenceHistory, listModelEvidenceHistories } from "@aihot/backend/publication/leaderboard-events";
import { loadItemEvidence } from "@aihot/backend/publication/evidence";
import { listPapers, loadPaper, loadPaperHistory } from "@aihot/backend/publication/papers";
import { looseQuery, sendJsonWithEtag, sendTextWithEtag, sendProblem } from "../http/respond.ts";
import { publicHandler } from "./v1.ts";
import { siteHandler } from "./site.ts";
import { paperFeed } from "@aihot/backend/publication/research-feeds";

const pageQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().min(1).max(2048).optional() });
const optionalText = z.preprocess(value => value === "" ? undefined : value, z.string().min(1).max(128).optional());
const radarQuery = pageQuery.extend({ source: optionalText, type: z.preprocess(value => value === "" ? undefined : value, z.enum(["new_leader", "top10_entry", "new_board", "methodology_change"]).optional()), model: optionalText }).strict();
const paperQuery = pageQuery.extend({ evaluationType: z.preprocess(value => value === "" ? undefined : value, z.enum(EVALUATION_TYPES).optional()), sourceId: optionalText, q: optionalText }).strict();

export function registerResearch(app: FastifyInstance) {
  for (const prefix of ["/api/site", "/api/v1"]) {
    const wrap = prefix === "/api/v1" ? publicHandler : siteHandler;
    app.get(`${prefix}/leaderboard-model-histories`, wrap(async (req, reply) => {
      if (!z.object({}).strict().safeParse(looseQuery(req)).success) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "The model history directory does not accept filters" });
      return sendJsonWithEtag(req, reply, await listModelEvidenceHistories(), { etagPrefix: "model-history-directory", cacheControl: "no-store" });
    }));
    app.get(`${prefix}/leaderboard-events`, wrap(async (req, reply) => {
      const parsed = radarQuery.safeParse(looseQuery(req));
      if (!parsed.success) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "Invalid event filters" });
      try {
        const result = await listLeaderboardEvents(parsed.data);
        return sendJsonWithEtag(req, reply, result, { etagPrefix: "radar", cacheControl: "public, max-age=30" });
      } catch (error) {
        if (error instanceof Error && /cursor|filter|event type/i.test(error.message)) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "Invalid event cursor or filters" });
        throw error;
      }
    }));
    app.get(`${prefix}/leaderboard-events/:id`, wrap(async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const result = id.length <= 128 ? await leaderboardEvent(id) : null;
      if (!result) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "Event not found" });
      return sendJsonWithEtag(req, reply, result, { etagPrefix: "radar-event", cacheControl: "public, max-age=30" });
    }));
    app.get(`${prefix}/leaderboard-source-states`, wrap(async (req, reply) => {
      return sendJsonWithEtag(req, reply, await leaderboardSourceStates(), { etagPrefix: "source-states", cacheControl: "public, max-age=30" });
    }));
    app.get(`${prefix}/leaderboard-model-history/:slug`, wrap(async (req, reply) => {
      const slug = (req.params as { slug: string }).slug;
      const result = slug.length <= 128 ? await modelEvidenceHistory(slug) : null;
      if (!result) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "Public model history not found" });
      return sendJsonWithEtag(req, reply, result, { etagPrefix: "model-history", cacheControl: "public, max-age=30" });
    }));
    app.get(`${prefix}/papers`, wrap(async (req, reply) => {
      const parsed = paperQuery.safeParse(looseQuery(req));
      if (!parsed.success) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "Invalid paper filters" });
      try {
        return sendJsonWithEtag(req, reply, await listPapers(parsed.data), { etagPrefix: "papers", cacheControl: "public, max-age=30" });
      } catch (error) {
        if (error instanceof Error && /cursor/i.test(error.message)) return sendProblem(req, reply, { status: 400, code: "invalid_cursor", detail: "Invalid paper cursor" });
        throw error;
      }
    }));
    app.get(`${prefix}/papers/:id`, wrap(async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const paper = id.length <= 128 ? await loadPaper(id) : null;
      if (!paper) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "Paper not found" });
      return sendJsonWithEtag(req, reply, paper, { etagPrefix: "paper", cacheControl: "public, max-age=30" });
    }));
    app.get(`${prefix}/papers/:id/history`, wrap(async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (id.length > 128 || !await loadPaper(id)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "Paper not found" });
      return sendJsonWithEtag(req, reply, await loadPaperHistory(id), { etagPrefix: "paper-history", cacheControl: "public, max-age=30" });
    }));
    app.get(`${prefix}/items/:id/evidence`, wrap(async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const evidence = id.length <= 80 ? await loadItemEvidence(id) : null;
      if (!evidence) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "Public evidence not found" });
      return sendJsonWithEtag(req, reply, evidence, { etagPrefix: "evaluation-evidence", cacheControl: "public, max-age=30" });
    }));
  }
  app.get("/feed/leaderboard.xml", async (req, reply) => sendTextWithEtag(req, reply, await leaderboardEventFeed(), { etagPrefix: "radar-feed", contentType: "application/rss+xml; charset=utf-8", cacheControl: "public, max-age=60" }));
  app.get("/feed/papers.xml", async (req, reply) => sendTextWithEtag(req, reply, await paperFeed(), { etagPrefix: "paper-feed", contentType: "application/rss+xml; charset=utf-8", cacheControl: "public, max-age=60" }));
}
