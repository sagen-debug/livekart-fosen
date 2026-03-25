require("dotenv").config();

const express = require("express");
const path = require("path");
const wellknown = require("wellknown");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

// =====================
// Konfig (env)
// =====================
const PORT = Number(process.env.PORT) || 3000;

const ET_CLIENT_NAME = (process.env.ET_CLIENT_NAME || "").trim();
const ENTUR_CODESPACE_ID = (process.env.ENTUR_CODESPACE_ID || "ATB").trim();

// Entur vehicles() støtter maxDataAge: filtrer bort gamle updates tidlig (f.eks. PT30M)
const ENTUR_MAX_DATA_AGE = (process.env.ENTUR_MAX_DATA_AGE || "PT30M").trim();

const POLL_INTERVAL_MS = clampInt(process.env.POLL_INTERVAL_MS, 10_000, 3_000, 120_000);
const WARM_THRESHOLD_MS =
  clampInt(process.env.WARM_THRESHOLD_MS, null, 10_000, 10 * 60_000) ??
  Math.max(30_000, 2 * POLL_INTERVAL_MS);

const ENSURE_FRESH_TIMEOUT_MS = clampInt(process.env.ENSURE_FRESH_TIMEOUT_MS, 8_000, 2_000, 20_000);

// Rate limit /api/vehicles
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

// Whitelist: inkluder utvalgte ruter selv utenfor polygon
const INCLUDE_LINE_PUBLIC_CODES = (process.env.INCLUDE_LINE_PUBLIC_CODES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const includeLineSet = new Set(INCLUDE_LINE_PUBLIC_CODES.map(String));

// Ghost-fix: hvilke ruter vi skal klynge-dedupe (default: 870)
const GHOST_DEDUPE_PUBLIC_CODES = (process.env.GHOST_DEDUPE_PUBLIC_CODES || "870")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ghostDedupeSet = new Set(GHOST_DEDUPE_PUBLIC_CODES.map(String));

// Hvor grovt vi klynger posisjon (3 ≈ ~100m, 2 ≈ ~1km)
const GHOST_CLUSTER_DECIMALS = clampInt(process.env.GHOST_CLUSTER_DECIMALS, 3, 1, 6);

// Fallback bbox (sikkerhetsnett)
const FALLBACK_BBOX = {
  minLon: 9.2,
  minLat: 63.4,
  maxLon: 11.3,
  maxLat: 64.6
};

const ENTUR_URL = "https://api.entur.io/realtime/v2/vehicles/graphql";

// Henter litt ekstra felt for dedupe (strippes før vi sender til frontend)
const ENTUR_QUERY = `
  query ($codespaceId: String, $maxDataAge: Duration) {
    vehicles(codespaceId: $codespaceId, maxDataAge: $maxDataAge) {
      vehicleId
      vehicleRef
      mode
      originRef
      originName
      destinationRef
      destinationName
      lastUpdated
      delay
      location { latitude longitude }
      line { publicCode }
    }
  }
`;

// =====================
// WKT (AREA_WKT) -> GeoJSON + PIP filter
// =====================
function parseAreaFilterFromEnv() {
  const raw = (process.env.AREA_WKT || "").trim();
  if (!raw) {
    return {
      wktPresent: false,
      wktOk: false,
      wktReason: "AREA_WKT mangler",
      polygonUsed: false,
      polygonType: null,
      ringCount: 0,
      coordinateCount: 0,
      fallbackActive: true,
      geom: null
    };
  }

  try {
    const geom = wellknown.parse(raw);
    if (!geom || !geom.type || !geom.coordinates) throw new Error("WKT parse ga tom geometri");
    if (geom.type !== "Polygon" && geom.type !== "MultiPolygon") throw new Error(`Ustøttet type: ${geom.type}`);

    validateGeometry(geom);

    const meta = geometryMeta(geom);
    return {
      wktPresent: true,
      wktOk: true,
      wktReason: null,
      polygonUsed: true,
      polygonType: geom.type,
      ringCount: meta.ringCount,
      coordinateCount: meta.coordinateCount,
      fallbackActive: false,
      geom
    };
  } catch (err) {
    return {
      wktPresent: true,
      wktOk: false,
      wktReason: `Ugyldig AREA_WKT: ${String(err && err.message ? err.message : err)}`,
      polygonUsed: false,
      polygonType: null,
      ringCount: 0,
      coordinateCount: 0,
      fallbackActive: true,
      geom: null
    };
  }
}

function geometryMeta(geom) {
  let ringCount = 0;
  let coordinateCount = 0;

  if (geom.type === "Polygon") {
    ringCount = geom.coordinates.length;
    coordinateCount = geom.coordinates.reduce((sum, r) => sum + (Array.isArray(r) ? r.length : 0), 0);
  } else {
    for (const poly of geom.coordinates) {
      ringCount += poly.length;
      coordinateCount += poly.reduce((sum, r) => sum + (Array.isArray(r) ? r.length : 0), 0);
    }
  }
  return { ringCount, coordinateCount };
}

function validateGeometry(geom) {
  const rings = [];
  if (geom.type === "Polygon") rings.push(...geom.coordinates);
  else for (const poly of geom.coordinates) rings.push(...poly);

  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 4) throw new Error("Ring må ha minst 4 punkter (inkl. lukking).");
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (!sameCoord(first, last)) throw new Error("Polygon må være lukket (første= siste).");

    for (const p of ring) {
      if (!Array.isArray(p) || p.length < 2) throw new Error("Koordinat må være [lon, lat].");
      const lon = Number(p[0]);
      const lat = Number(p[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error("Koordinat har ikke-numeriske verdier.");
    }
  }
}

function sameCoord(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length >= 2 && b.length >= 2 && a[0] === b[0] && a[1] === b[1];
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = (yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonGeom(lon, lat, polygonGeom) {
  const rings = polygonGeom.coordinates;
  if (!rings || rings.length === 0) return false;

  const outer = rings[0];
  if (!pointInRing(lon, lat, outer)) return false;

  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lon, lat, rings[i])) return false;
  }
  return true;
}

function pointInArea(lon, lat, area) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;

  if (area.polygonUsed && area.geom) {
    if (area.geom.type === "Polygon") return pointInPolygonGeom(lon, lat, area.geom);
    if (area.geom.type === "MultiPolygon") {
      for (const poly of area.geom.coordinates) {
        if (pointInPolygonGeom(lon, lat, { type: "Polygon", coordinates: poly })) return true;
      }
      return false;
    }
  }

  return (
    lon >= FALLBACK_BBOX.minLon &&
    lon <= FALLBACK_BBOX.maxLon &&
    lat >= FALLBACK_BBOX.minLat &&
    lat <= FALLBACK_BBOX.maxLat
  );
}

let areaFilter = parseAreaFilterFromEnv();

// =====================
// Cache + polling + ensureFreshCache
// =====================
let cache = null;
let fetchedAtMs = 0;
let lastError = null;

let fetchInFlight = null;
let lastFetchStartedAtMs = 0;
let lastFetchStats = null;

function cacheAgeMs() {
  if (!fetchedAtMs) return Infinity;
  return Date.now() - fetchedAtMs;
}

function isStale() {
  if (!cache || !fetchedAtMs) return true;
  return cacheAgeMs() >= WARM_THRESHOLD_MS;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function lastUpdatedMs(iso) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function normalizeVehicle(v) {
  const loc = v && v.location;
  const line = v && v.line;

  const latitude = Number(loc && loc.latitude);
  const longitude = Number(loc && loc.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return {
    // intern dedupe-støtte
    vehicleId: v.vehicleId || null,
    vehicleRef: v.vehicleRef || null,
    mode: v.mode || null,
    originRef: v.originRef || null,
    originName: v.originName || null,
    destinationRef: v.destinationRef || null,

    // det vi sender til frontend
    lastUpdated: v.lastUpdated || null,
    destinationName: v.destinationName || null,
    delay: typeof v.delay === "number" && Number.isFinite(v.delay) ? v.delay : 0,
    location: { latitude, longitude },
    line: { publicCode: (line && line.publicCode) || null }
  };
}

function canonicalIdKey(v) {
  if (v.vehicleId) return `id:${String(v.vehicleId)}`;
  if (v.vehicleRef) return `ref:${String(v.vehicleRef)}`;
  return null;
}

function isFerryish(v) {
  const mode = String(v.mode || "");
  const code = String(v?.line?.publicCode || "");
  return mode === "FERRY" || /^8\d\d$/.test(code);
}

function ferryKey(v) {
  const code = String(v?.line?.publicCode || "");
  const o = String(v.originRef || v.originName || "");
  const d = String(v.destinationRef || v.destinationName || "");
  return `${code}|${o}|${d}`;
}

function upsertNewest(map, key, v) {
  const prev = map.get(key);
  if (!prev || lastUpdatedMs(v.lastUpdated) >= lastUpdatedMs(prev.lastUpdated)) map.set(key, v);
}

function dedupeVehicles(list) {
  // Pass 1: dedupe på vehicleId/vehicleRef hvis mulig
  const byId = new Map();
  const noId = [];

  for (const v of list) {
    const k = canonicalIdKey(v);
    if (!k) noId.push(v);
    else upsertNewest(byId, k, v);
  }

  const stage1 = noId.concat(Array.from(byId.values()));

  // Pass 2: for ferge/hurtigbåt: dedupe på rute + origin/destination
  const ferryMap = new Map();
  const others = [];

  for (const v of stage1) {
    if (!isFerryish(v)) {
      others.push(v);
      continue;
    }
    upsertNewest(ferryMap, ferryKey(v), v);
  }

  return others.concat(Array.from(ferryMap.values()));
}

// --- Ghost ferry suppression (spatial cluster) ---
function roundCoord(n, decimals) {
  const p = 10 ** decimals;
  return Math.round(n * p) / p;
}

function suppressGhostFerriesByCluster(list) {
  const keepByCluster = new Map(); // clusterKey -> vehicle
  const passthrough = [];

  for (const v of list) {
    const code = String(v?.line?.publicCode || "");

    if (!isFerryish(v) || !ghostDedupeSet.has(code)) {
      passthrough.push(v);
      continue;
    }

    const lat = Number(v?.location?.latitude);
    const lon = Number(v?.location?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      passthrough.push(v);
      continue;
    }

    const key = `${code}|${roundCoord(lat, GHOST_CLUSTER_DECIMALS)}|${roundCoord(lon, GHOST_CLUSTER_DECIMALS)}`;
    const prev = keepByCluster.get(key);

    if (!prev || lastUpdatedMs(v.lastUpdated) >= lastUpdatedMs(prev.lastUpdated)) {
      keepByCluster.set(key, v);
    }
  }

  return passthrough.concat(Array.from(keepByCluster.values()));
}

async function fetchEnturOnce(reason) {
  if (!ET_CLIENT_NAME) throw new Error("ET_CLIENT_NAME mangler (må settes i env).");

  const body = JSON.stringify({
    query: ENTUR_QUERY,
    variables: { codespaceId: ENTUR_CODESPACE_ID, maxDataAge: ENTUR_MAX_DATA_AGE }
  });

  const res = await fetchWithTimeout(
    ENTUR_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ET-Client-Name": ET_CLIENT_NAME
      },
      body
    },
    8000
  );

  if (!res.ok) {
    const txt = await safeText(res);
    throw new Error(`Entur HTTP ${res.status}: ${txt || res.statusText}`);
  }

  const json = await res.json().catch(() => null);
  if (!json) throw new Error("Entur: kunne ikke parse JSON");
  if (json.errors && json.errors.length) throw new Error(`Entur GraphQL errors: ${json.errors[0].message || "ukjent"}`);

  const vehicles = json?.data?.vehicles;
  if (!Array.isArray(vehicles)) throw new Error("Entur: data.vehicles er ikke en liste");

  const normalized = vehicles.map(normalizeVehicle).filter(Boolean);

  const filtered = normalized.filter((v) => {
    const inArea = pointInArea(v.location.longitude, v.location.latitude, areaFilter);
    const code = v?.line?.publicCode;
    const whitelisted = code != null && includeLineSet.has(String(code));
    return inArea || whitelisted;
  });

  const deduped = dedupeVehicles(filtered);

  const ghostBefore = deduped.filter((v) => ghostDedupeSet.has(String(v?.line?.publicCode || ""))).length;
  const ghostSuppressed = suppressGhostFerriesByCluster(deduped);
  const ghostAfter = ghostSuppressed.filter((v) => ghostDedupeSet.has(String(v?.line?.publicCode || ""))).length;

  // Strip intern-felt før caching/return
  const output = ghostSuppressed.map(({ vehicleId, vehicleRef, mode, originRef, originName, destinationRef, ...rest }) => rest);

  return {
    output,
    stats: {
      rawCount: vehicles.length,
      normalizedCount: normalized.length,
      filteredCount: filtered.length,
      dedupedCount: deduped.length,
      outputCount: output.length,
      ghostRouteCountBefore: ghostBefore,
      ghostRouteCountAfter: ghostAfter,
      ghostRoutes: GHOST_DEDUPE_PUBLIC_CODES,
      ghostClusterDecimals: GHOST_CLUSTER_DECIMALS,
      enturMaxDataAge: ENTUR_MAX_DATA_AGE,
      reason
    }
  };
}

async function updateCache(reason) {
  if (fetchInFlight) return fetchInFlight;

  lastFetchStartedAtMs = Date.now();
  fetchInFlight = (async () => {
    try {
      const { output, stats } = await fetchEnturOnce(reason);
      cache = output;
      fetchedAtMs = Date.now();
      lastError = null;
      lastFetchStats = { ...stats, updatedAt: new Date().toISOString() };
      return true;
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
      return false;
    } finally {
      fetchInFlight = null;
    }
  })();

  return fetchInFlight;
}

function promiseCompletedWithin(promise, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) resolve(false);
    }, timeoutMs);

    promise
      .then(() => {
        done = true;
        clearTimeout(t);
        resolve(true);
      })
      .catch(() => {
        done = true;
        clearTimeout(t);
        resolve(true);
      });
  });
}

async function ensureFreshCache() {
  const needs = !cache || cacheAgeMs() >= WARM_THRESHOLD_MS;
  if (!needs) return { triggered: false, warming: Boolean(fetchInFlight) };

  const p = updateCache("ensureFreshCache");
  const finished = await promiseCompletedWithin(p, ENSURE_FRESH_TIMEOUT_MS);

  return { triggered: true, warming: !finished || Boolean(fetchInFlight) };
}

// Polling
setInterval(() => {
  updateCache("poll").catch(() => {});
}, POLL_INTERVAL_MS);

// Best effort ved oppstart
setTimeout(() => {
  updateCache("startup").catch(() => {});
}, 0);

// =====================
// Rate limit
// =====================
const rateMap = new Map();

function rateLimitInfo(ip) {
  const now = Date.now();
  let entry = rateMap.get(ip);

  if (!entry || now - entry.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
    entry = { windowStartMs: now, count: 0 };
    rateMap.set(ip, entry);
  }

  entry.count += 1;
  const remaining = Math.max(0, RATE_LIMIT_MAX - entry.count);
  const resetMs = entry.windowStartMs + RATE_LIMIT_WINDOW_MS - now;
  const limited = entry.count > RATE_LIMIT_MAX;

  return {
    limited,
    meta: {
      limit: RATE_LIMIT_MAX,
      remaining,
      resetMs: Math.max(0, resetMs),
      windowMs: RATE_LIMIT_WINDOW_MS
    }
  };
}

// =====================
// API
// =====================
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "livekart-fosen",
    now: new Date().toISOString(),
    env: {
      port: PORT,
      enturCodespaceId: ENTUR_CODESPACE_ID,
      enturMaxDataAge: ENTUR_MAX_DATA_AGE,
      etClientNameSet: Boolean(ET_CLIENT_NAME)
    },
    polling: {
      pollIntervalMs: POLL_INTERVAL_MS,
      warmThresholdMs: WARM_THRESHOLD_MS,
      ensureFreshTimeoutMs: ENSURE_FRESH_TIMEOUT_MS
    },
    cache: {
      hasCache: Boolean(cache),
      fetchedAt: fetchedAtMs ? new Date(fetchedAtMs).toISOString() : null,
      ageMs: cacheAgeMs(),
      stale: isStale(),
      lastError,
      inFlight: Boolean(fetchInFlight),
      lastFetchStartedAt: lastFetchStartedAtMs ? new Date(lastFetchStartedAtMs).toISOString() : null,
      lastFetchStats
    },
    area: {
      polygonUsed: areaFilter.polygonUsed,
      polygonType: areaFilter.polygonType,
      ringCount: areaFilter.ringCount,
      coordinateCount: areaFilter.coordinateCount,
      fallbackActive: areaFilter.fallbackActive,
      wktPresent: areaFilter.wktPresent,
      wktOk: areaFilter.wktOk,
      wktReason: areaFilter.wktReason,
      includeLinePublicCodes: INCLUDE_LINE_PUBLIC_CODES,
      fallbackBbox: FALLBACK_BBOX
    },
    ghostFerry: {
      enabledForPublicCodes: GHOST_DEDUPE_PUBLIC_CODES,
      clusterDecimals: GHOST_CLUSTER_DECIMALS
    }
  });
});

app.get("/api/entur-test", async (req, res) => {
  const started = Date.now();
  const ok = await updateCache("entur-test");
  res.json({
    ok,
    ms: Date.now() - started,
    fetchedAt: fetchedAtMs ? new Date(fetchedAtMs).toISOString() : null,
    ageMs: cacheAgeMs(),
    stale: isStale(),
    lastError,
    count: Array.isArray(cache) ? cache.length : 0,
    lastFetchStats
  });
});

app.get("/api/vehicles", async (req, res) => {
  res.set("Cache-Control", "public, max-age=3");

  const ip = req.ip || "unknown";
  const rl = rateLimitInfo(ip);
  if (rl.limited) res.set("Retry-After", String(Math.ceil(rl.meta.resetMs / 1000)));

  const warm = await ensureFreshCache();

  res.json({
    fetchedAt: fetchedAtMs ? new Date(fetchedAtMs).toISOString() : null,
    ageMs: cacheAgeMs(),
    stale: isStale(),
    warming: warm.warming,
    lastError,
    pollIntervalMs: POLL_INTERVAL_MS,
    warmThresholdMs: WARM_THRESHOLD_MS,

    rateLimited: rl.limited,
    rateLimit: rl.meta,

    vehicles: Array.isArray(cache) ? cache : []
  });
});

// =====================
// Statisk frontend
// =====================
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((req, res) => res.status(404).send("Not found"));

app.listen(PORT, () => {
  console.log(`[livekart-fosen] listening on port ${PORT}`);
});

// =====================
// Utils
// =====================
function clampInt(value, fallback, min, max) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const x = Math.floor(n);
  if (min != null && x < min) return min;
  if (max != null && x > max) return max;
  return x;
}

function safeText(res) {
  return res.text().then((t) => (t || "").slice(0, 300)).catch(() => "");
}