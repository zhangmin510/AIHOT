// Snapshot SSR uses a Request→Response transport per request; parallel renders never share it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { apiFetch, apiGet, runWithApiFetch } from "../app/lib/api.server.ts";

function gate() {
  let open!: () => void;
  return { promise: new Promise<void>(resolve => { open = resolve; }), get open() { return open; } };
}

test("concurrent SSR renders keep their own API transport across awaits", async () => {
  const a = gate();
  const b = gate();
  const read = (name: string, wait: ReturnType<typeof gate>, ready: ReturnType<typeof gate>) => runWithApiFetch(async request => {
    assert.equal(new URL(request.url).pathname, "/api/site/meta");
    assert.equal(request.headers.get("x-aihot-ssr"), "1");
    return Response.json({ name });
  }, async () => {
    ready.open();
    await wait.promise;
    return apiGet<{ name: string }>("/api/site/meta");
  });
  const [first, second] = await Promise.all([read("first", b, a), read("second", a, b)]);
  assert.deepEqual([first.name, second.name], ["first", "second"]);
});

test("nested transports restore their parent and do not alter the global fetch", async () => {
  const original = globalThis.fetch;
  const actual = await runWithApiFetch(async () => Response.json({ name: "outer" }), async () => {
    const first = await apiGet<{ name: string }>("/api/site/meta");
    const nested = await runWithApiFetch(async () => Response.json({ name: "inner" }), () => apiGet<{ name: string }>("/api/site/meta"));
    await assert.rejects(runWithApiFetch(async () => { throw new Error("inner failure"); }, () => apiGet("/api/site/meta")), /inner failure/);
    const last = await apiGet<{ name: string }>("/api/site/meta");
    return [first.name, nested.name, last.name];
  });
  assert.deepEqual(actual, ["outer", "inner", "outer"]);
  assert.equal(globalThis.fetch, original);
});

test("snapshot HTTP transport retains redirect, status, headers and cancellation", async () => {
  const controller = new AbortController();
  await runWithApiFetch(async request => {
    assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("accept"), "application/json");
    controller.abort(new Error("reader left"));
    assert.equal(request.signal.aborted, true);
    assert.equal(request.signal.reason, controller.signal.reason);
    return new Response(null, { status: 308, headers: { location: "/api/site/stories/survivor" } });
  }, async () => {
    const response = await apiFetch("/api/site/stories/merged", { redirect: "manual", headers: { accept: "application/json" }, signal: controller.signal });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), "/api/site/stories/survivor");
  });
  assert.throws(() => apiFetch("https://example.invalid/private"), /site-relative/);
});
