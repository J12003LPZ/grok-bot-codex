import test from "node:test";
import assert from "node:assert/strict";
import { createCatalog } from "../shim/catalog.mjs";

const ROUTE = "/aiserver.v1.DashboardService/ListMarketplacePlugins";

function upstream(reply = () => new Response(Buffer.from([1, 2, 3]))) {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => (calls.push({ url, init }), reply()) };
}

test("forwards only the body and content headers, never credentials", async () => {
  const up = upstream();
  const catalog = createCatalog({ fetchImpl: up.fetchImpl });
  assert.deepEqual([...(await catalog.read(ROUTE, Buffer.from("q")))], [1, 2, 3]);
  const { url, init } = up.calls[0];
  assert.equal(url, `https://api2.cursor.sh${ROUTE}`);
  assert.deepEqual(Object.keys(init.headers).sort(), ["connect-protocol-version", "content-type"]);
});

test("caches per route and body until the TTL runs out", async () => {
  let t = 0;
  const up = upstream();
  const catalog = createCatalog({ fetchImpl: up.fetchImpl, now: () => t, ttlMs: 1000 });
  await catalog.read(ROUTE, Buffer.from("a"));
  await catalog.read(ROUTE, Buffer.from("a"));
  await catalog.read(ROUTE, Buffer.from("b"));
  assert.equal(up.calls.length, 2);
  t = 2000;
  await catalog.read(ROUTE, Buffer.from("a"));
  assert.equal(up.calls.length, 3);
});

test("upstream failure returns stale bytes, or null when there are none", async () => {
  let t = 0;
  let fail = false;
  const catalog = createCatalog({
    now: () => t,
    ttlMs: 10,
    fetchImpl: async () => {
      if (fail) throw new Error("offline");
      return new Response(Buffer.from([9]));
    },
  });
  assert.equal(await createCatalog({ fetchImpl: async () => new Response("no", { status: 401 }) }).read(ROUTE, Buffer.alloc(0)), null);
  await catalog.read(ROUTE, Buffer.alloc(0));
  fail = true;
  t = 100;
  assert.deepEqual([...(await catalog.read(ROUTE, Buffer.alloc(0)))], [9]);
});

test("only public catalog routes are handled", async () => {
  const catalog = createCatalog({ fetchImpl: upstream().fetchImpl });
  assert.equal(catalog.handles(ROUTE), true);
  assert.equal(catalog.handles("/aiserver.v1.DashboardService/GetEffectiveUserPlugins"), false);
  assert.equal(createCatalog({ enabled: false }).handles(ROUTE), false);
  await assert.rejects(catalog.read("/aiserver.v1.DashboardService/GetMe", Buffer.alloc(0)), /not a public catalog route/);
});
