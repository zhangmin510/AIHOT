import { createRequestHandler, type ServerBuild } from "react-router";
import { isApiOwned, resolveRedirect } from "../../packages/contracts/src/http-policy.ts";
import * as build from "../../apps/web/build-cloudflare/server/index.js";
import snapshotData from "../../.data/cloudflare-preview/snapshot.json";
import { createSnapshotApi } from "./api.ts";
import type { PreviewSnapshot } from "./snapshot.ts";

const snapshot = snapshotData as unknown as PreviewSnapshot;
const api = createSnapshotApi(snapshot);
const ssr = createRequestHandler(build as unknown as ServerBuild, "production");
// Use the context exported by the compiled entry: a second source import would create another ALS.
const { runWithApiFetch } = build.entry.module as unknown as {
  runWithApiFetch: <T>(fetcher: typeof api, callback: () => T) => T;
};

function finish(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Preview-Snapshot", snapshot.generatedAt);
  headers.delete("X-Accel-Expires");
  if (response.status !== 200 || headers.has("Set-Cookie") || request.method !== "GET") {
    headers.set("Cache-Control", "no-store");
  } else if (headers.get("Content-Type")?.includes("text/html") || new URL(request.url).pathname.endsWith(".data")) {
    headers.set("Cache-Control", "public, max-age=60, must-revalidate");
  }
  return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
}

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const pathname = decodeURIComponent(url.pathname);
      const page = pathname.replace(/\.data$/, "");
      if (/^\/(?:admin|sources)(?:\/|$)/i.test(page)
        || /^\/api\/(?:admin|auth|ingest)(?:\/|$)/i.test(page)
        || /(?:^|\/)\./.test(pathname)) {
        // Public discovery documents under .well-known are handled by the public API below.
        if (!pathname.startsWith("/.well-known/")) return finish(new Response("Not found", { status: 404 }), request);
      }
      if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS"
        && !(pathname === "/api/mcp" && request.method === "POST")) {
        return finish(new Response("This preview is read-only", { status: 405, headers: { Allow: "GET, HEAD, OPTIONS" } }), request);
      }
      const redirect = resolveRedirect(pathname, url.search);
      if (redirect) {
        const headers = new Headers(redirect.headers);
        if (redirect.location) headers.set("Location", redirect.location);
        return finish(new Response(null, { status: redirect.status, headers }), request);
      }
      if (isApiOwned(pathname)) return finish(await api(request), request);
      if (request.method === "OPTIONS") return finish(new Response(null, { status: 204, headers: { Allow: "GET, HEAD, OPTIONS" } }), request);
      // Like the Node server, public single-fetch responses contain all matched loaders.
      url.searchParams.delete("_routes");
      const navigation = new Request(url, request);
      return finish(await runWithApiFetch(api, () => ssr(navigation)), request);
    } catch (error) {
      const malformed = error instanceof URIError;
      if (!malformed) console.error("Preview request failed", error);
      return finish(new Response(malformed ? "Bad request" : "Internal error", { status: malformed ? 400 : 500 }), request);
    }
  },
};
