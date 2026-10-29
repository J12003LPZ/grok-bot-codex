import crypto from "node:crypto";

// The plugin marketplace and the Bot marketplace listings are public: the
// hosted backend serves them without a login. Forward just those reads so the
// app's Marketplace shows the real catalog. Nothing identifying goes upstream:
// no auth, cookies or app headers, only the request body (catalog filters and
// any Marketplace search text).
export const PUBLIC_CATALOG_ROUTES = new Set([
  "/aiserver.v1.DashboardService/ListMarketplaces",
  "/aiserver.v1.DashboardService/ListMarketplacePlugins",
  "/aiserver.v1.GrokBotService/ListPublicGrokBotMarketplaceListings",
  "/aiserver.v1.GrokBotService/GetPublicGrokBotMarketplaceListing",
]);

// Plugin and marketplace records from the public catalog, decoded with the
// schema generated from the installed app. Used to answer install calls with
// the full plugin record the box host needs (gitUrl, gitRef, gitPath, ...).
export function createCatalogIndex(catalog, root) {
  const decode = async (route, reqType, resType) => {
    const In = root.lookupType(`aiserver.v1.${reqType}`);
    const Out = root.lookupType(`aiserver.v1.${resType}`);
    const bytes = await catalog.read(route, Buffer.from(In.encode(In.create({})).finish()));
    if (bytes === null) return null;
    return Out.toObject(Out.decode(bytes), { longs: Number, enums: String, defaults: false });
  };
  return {
    async plugin(id) {
      const res = await decode("/aiserver.v1.DashboardService/ListMarketplacePlugins", "ListMarketplacePluginsRequest", "ListMarketplacePluginsResponse");
      return res?.plugins?.find((p) => Number(p.id) === Number(id));
    },
    async marketplaces() {
      const res = await decode("/aiserver.v1.DashboardService/ListMarketplaces", "ListMarketplacesRequest", "ListMarketplacesResponse");
      return res?.marketplaces ?? [];
    },
  };
}

export function createCatalog({
  upstream = "https://api2.cursor.sh",
  fetchImpl = fetch,
  ttlMs = 10 * 60 * 1000,
  timeoutMs = 15_000,
  now = Date.now,
  enabled = true,
} = {}) {
  const cache = new Map();

  return {
    handles: (route) => enabled && PUBLIC_CATALOG_ROUTES.has(route),

    // Returns the upstream reply bytes, or null when upstream fails (the caller
    // then answers with its empty fallback, and the Marketplace shows nothing).
    async read(route, body) {
      if (!PUBLIC_CATALOG_ROUTES.has(route)) throw new Error(`not a public catalog route: ${route}`);
      const key = `${route}:${crypto.createHash("sha256").update(body).digest("hex")}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.bytes;
      try {
        const res = await fetchImpl(upstream + route, {
          method: "POST",
          headers: { "content-type": "application/proto", "connect-protocol-version": "1" },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return hit?.bytes ?? null;
        const bytes = Buffer.from(await res.arrayBuffer());
        cache.set(key, { at: now(), bytes });
        return bytes;
      } catch {
        return hit?.bytes ?? null; // stale beats empty while offline
      }
    },
  };
}
