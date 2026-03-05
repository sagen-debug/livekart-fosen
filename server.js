require("dotenv").config();

const express = require("express");
const path = require("path");
const wellknown = require("wellknown");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // Render proxy/IP

// =====================
// Konfig (env)
// =====================
const PORT = Number(process.env.PORT) || 3000;

const ET_CLIENT_NAME = (process.env.ET_CLIENT_NAME || "").trim(); // Render env var
const ENTUR_CODESPACE_ID = (process.env.ENTUR_CODESPACE_ID || "ATB").trim();

const POLL_INTERVAL_MS = clampInt(process.env.POLL_INTERVAL_MS, 10_000, 3_000, 120_000);
const WARM_THRESHOLD_MS =
  clampInt(process.env.WARM_THRESHOLD_MS, null, 10_000, 10 * 60_000) ??
  Math.max(30_000, 2 * POLL_INTERVAL_MS);

const ENSURE_FRESH_TIMEOUT_MS = clampInt(process.env.ENSURE_FRESH_TIMEOUT_MS, 8_000, 2_000, 20_000);

// Rate limit /api/vehicles: 30 requests/min per IP
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

// Whitelist: inkluder utvalgte ruter selv utenfor polygon (f.eks hurtigbåt 800/805/810)
const INCLUDE_LINE_PUBLIC_CODES = (process.env.INCLUDE_LINE_PUBLIC_CODES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const includeLineSet = new Set(INCLUDE_LINE_PUBLIC_CODES.map(String));

// Fallback bbox (sikkerhetsnett) for Fosen-ish (lon/lat)
const FALLBACK_BBOX = {
  minLon: 9.2,
  minLat: 63.4,
  maxLon: 11.3,
  maxLat: 64.6
};

// Entur vehicles-v2 GraphQL endpoint (doc)
const ENTUR_URL = "https://api.entur.io/realtime/v2/vehicles/graphql";

// Kun feltene vi skal sende til frontend
const ENTUR_QUERY = `
  query ($codespaceId: String) {
    vehicles(codespaceId: $codespaceId) {
      lastUpdated
      destinationName
      delay
      location { latitude longitude }
      line { publicCode }
    }
  }
`;

// =====================
// WKT (AREA_WKT) -> GeoJSON + PIP filter
// Støtter POLYGON og MULTIPOLYGON.
// Koordinater: lon lat (WKT-standard).
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
    const geom = wellknown.parse(raw); // GeoJSON geometry
    if (!geom || !geom.type || !geom.coordinates) throw new Error("WKT parse ga tom geometri");
    if (geom.type !== "Polygon" && geom.type !== "MultiPolygon") {
      throw new Error(`Ustøttet geometri-type: ${geom.type}`);
    }

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
    const rings = geom.coordinates;
    ringCount = rings.length;
    coordinateCount = rings.reduce((sum, r) => sum + (Array.isArray(r) ? r.length : 0), 0);
  } else {
    const polys = geom.coordinates;
    for (const poly of polys) {
      ringCount += poly.length;
      coordinateCount += poly.reduce((sum, r) => sum + (Array.isArray(r) ? r.length : 0), 0);
    }
  }
  return { ringCount, coordinateCount };
}

function validateGeometry(geom) {
  const ringsToCheck = [];

  if (geom.type === "Polygon") {
    ringsToCheck.push(...geom.coordinates);
  } else if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) ringsToCheck.push(...poly);
  }

  for (const ring of ringsToCheck) {
    if (!Array.isArray(ring) || ring.length < 4) throw new Error("Ring må ha minst 4 punkter (inkl. lukking).");
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (!sameCoord(first, last)) throw new Error("Polygon må være lukket: første og siste punkt må være identiske.");

    for (const p of ring) {
      if (!Array.isArray(p) || p.length < 2) throw new Error("Koordinat må være [lon, lat].");
      const lon = Number(p[0]);
      const lat = Number(p[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error("Koordinat inneholder ikke-numeriske verdier.");
    }
  }
}

function sameCoord(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length >= 2 && b.length >= 2 && a[0] === b[0] && a[1] === b[1];
}

// Ray casting i én ring (lon/lat)
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];

    const intersect =
      (yi > lat) !== (yj > lat) &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;

    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonGeom(lon, lat, polygonGeom) {
  // GeoJSON Polygon: [outerRing, hole1, hole2...]
  const rings = polygonGeom.coordinates;
  if (!rings || rings.length === 0) return false;

  const outer = rings[0];
  if (!pointInRing(lon, lat, outer)) return false;

  // Holes: inne i hull => false
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

  // fallback bbox
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
let cache = null; // filtrerte vehicles
let fetchedAtMs = 0; // tidspunkt for siste vellykkede fetch
let lastError = null;

let fetchInFlight = null; // Promise-lås
let lastFetchStartedAtMs = 0;

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

function normalizeVehicle(v) {
  const loc = v && v.location;
  const line = v && v.line;

  const latitude = Number(loc && loc.latitude);
  const longitude = Number(loc && loc.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return {
    lastUpdated: v.lastUpdated || null,
    destinationName: v.destinationName || null,
    delay: typeof v.delay === "number" && Number.isFinite(v.delay) ? v.delay : 0,
    location: { latitude, longitude },
    line: { publicCode: (line && line.publicCode) || null }
  };
}

async function fetchEnturOnce(reason) {
  if (!ET_CLIENT_NAME) throw new Error("ET_CLIENT_NAME mangler (må settes i env).");

  const body = JSON.stringify({
    query: ENTUR_QUERY,
    variables: { codespaceId: ENTUR_CODESPACE_ID }
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

  if (json.errors && json.errors.length) {
    throw new Error(`Entur GraphQL errors: ${json.errors[0].message || "ukjent"}`);
  }

  const vehicles = json?.data?.vehicles;
  if (!Array.isArray(vehicles)) throw new Error("Entur: data.vehicles er ikke en liste");

  // Filtrer til område før caching, MEN inkluder whitelisted ruter uansett polygon
  const filtered = vehicles
    .map(normalizeVehicle)
    .filter(Boolean)
    .filter((v) => {
      const inArea = pointInArea(v.location.longitude, v.location.latitude, areaFilter);
      const code = v?.line?.publicCode;
      const whitelisted = code != null && includeLineSet.has(String(code));
      return inArea || whitelisted;
    });

  return { filtered, rawCount: vehicles.length, filteredCount: filtered.length, reason };
}

async function updateCache(reason) {
  if (fetchInFlight) return fetchInFlight; // concurrency-lås

  lastFetchStartedAtMs = Date.now();
  fetchInFlight = (async () => {
    try {
      const { filtered } = await fetchEnturOnce(reason);
      cache = filtered;
      fetchedAtMs = Date.now();
      lastError = null;
      return true;
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
      // behold gammel cache
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

// WAKE / første request-boost (Render Free)
async function ensureFreshCache() {
  const needs = !cache || cacheAgeMs() >= WARM_THRESHOLD_MS;
  if (!needs) return { triggered: false, warming: Boolean(fetchInFlight) };

  const p = updateCache("ensureFreshCache");
  const finished = await promiseCompletedWithin(p, ENSURE_FRESH_TIMEOUT_MS);

  // Hvis ikke ferdig innen timeout => warming=true (men vi svarer uansett)
  return { triggered: true, warming: !finished || Boolean(fetchInFlight) };
}

// Start polling loop
setInterval(() => {
  updateCache("poll").catch(() => {});
}, POLL_INTERVAL_MS);

// Start gjerne én fetch ved oppstart (best effort)
setTimeout(() => {
  updateCache("startup").catch(() => {});
}, 0);

// =====================
// Rate limit (fixed window)
// =====================
const rateMap = new Map(); // ip -> { windowStartMs, count }

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
      lastFetchStartedAt: lastFetchStartedAtMs ? new Date(lastFetchStartedAtMs).toISOString() : null
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
    }
  });
});

// Test-endepunkt: trigger Entur fetch nå
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
    count: Array.isArray(cache) ? cache.length : 0
  });
});

app.get("/api/vehicles", async (req, res) => {
  // Cache-Control krav
  res.set("Cache-Control", "public, max-age=3");

  // Rate limit (men vi svarer med cache uansett)
  const ip = req.ip || "unknown";
  const rl = rateLimitInfo(ip);
  if (rl.limited) res.set("Retry-After", String(Math.ceil(rl.meta.resetMs / 1000)));

  // Best effort warm-cache før svar
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
// Statisk frontend fra /public
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