(() => {
  const POLL_MS = 10_000;
  const HIDE_OLD_MS = 30 * 60 * 1000;

  const qs = new URLSearchParams(location.search);
  const embed = qs.get("embed") === "1";
  if (embed) document.body.classList.add("embed");

  const statusTextEl = document.getElementById("statusText");
  const metaTextEl = document.getElementById("metaText");
  const dotEl = document.getElementById("dot");

  function setStatus({ level, text, meta }) {
    statusTextEl.textContent = text;
    metaTextEl.textContent = meta || "—";
    dotEl.style.background =
      level === "good" ? "var(--good)" :
      level === "warn" ? "var(--warn)" :
      "var(--bad)";
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c]));
  }

  function delayToMinutes(delay) {
    // Delay er varighet; vi viser minutter (avrundet).
    if (typeof delay !== "number" || !Number.isFinite(delay)) return 0;
    return Math.round(delay / 60);
  }

  function badgeClass(min) {
    if (min === 0) return "delay-badge--ok";
    if (Math.abs(min) <= 2) return "delay-badge--warn";
    return "delay-badge--bad";
  }

  function delayText(min) {
    if (min === 0) return "0";
    if (min > 0) return `+${min}`;
    return `${min}`;
  }

  function statusLineFromDelay(min) {
    if (min === 0) return "I rute";
    if (min > 0) return `Forsinket ${min} min`;
    return `Foran rute ${Math.abs(min)} min`;
  }

  function formatTime(iso) {
    if (!iso) return "Ukjent";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "Ukjent";
    return d.toLocaleString("no-NO", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit"
    });
  }

  function isOld(lastUpdated) {
    if (!lastUpdated) return true;
    const t = Date.parse(lastUpdated);
    if (!Number.isFinite(t)) return true;
    return (Date.now() - t) > HIDE_OLD_MS;
  }

  function makeIcon(publicCode, delayMin) {
    const code = publicCode || "?";
    const isBoat = ["800", "805", "810"].includes(String(code));

    const html = `
      <div class="vehicle-marker ${isBoat ? "vehicle-marker--boat" : ""}">
        <div>${escapeHtml(code)}</div>
        <div class="delay-badge ${badgeClass(delayMin)}">${escapeHtml(delayText(delayMin))}</div>
      </div>
    `;

    return L.divIcon({
      className: "",
      html,
      iconSize: [44, 44],
      iconAnchor: [22, 22],
      popupAnchor: [0, -18]
    });
  }

  // Map
  const map = L.map("map", { zoomControl: true });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap-bidragsytere'
  }).addTo(map);

  // Ca. midt i Fosen
  map.setView([63.85, 10.15], 9);

  const layer = L.layerGroup().addTo(map);

  async function fetchVehicles() {
    const res = await fetch("/api/vehicles", { cache: "no-store" });
    const json = await res.json();

    const vehicles = Array.isArray(json.vehicles) ? json.vehicles : [];
    const ageMs = typeof json.ageMs === "number" ? json.ageMs : null;
    const stale = Boolean(json.stale);
    const warming = Boolean(json.warming);
    const lastError = json.lastError || null;

    // Frontend-filter: skjul gamle posisjoner (>30 min)
    const visible = [];
    let hiddenOld = 0;

    for (const v of vehicles) {
      if (isOld(v.lastUpdated)) {
        hiddenOld++;
        continue;
      }
      visible.push(v);
    }

    // Redraw enkelt og robust
    layer.clearLayers();

    for (const v of visible) {
      const code = v?.line?.publicCode || "?";
      const delayMin = delayToMinutes(v?.delay ?? 0);
      const dest = v?.destinationName || "Ukjent";

      const marker = L.marker([v.location.latitude, v.location.longitude], {
        icon: makeIcon(code, delayMin),
        keyboard: false
      });

      const popupHtml = `
        <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;">
          <div style="font-weight: 900; margin-bottom: 6px;">Rute ${escapeHtml(code)}</div>
          <div><strong>Til:</strong> ${escapeHtml(dest)}</div>
          <div><strong>Status:</strong> ${escapeHtml(statusLineFromDelay(delayMin))}</div>
          <div><strong>Sist oppdatert:</strong> ${escapeHtml(formatTime(v.lastUpdated))}</div>
        </div>
      `;

      marker.bindPopup(popupHtml, { maxWidth: 260 });
      marker.addTo(layer);
    }

    const ageStr = (ageMs == null || !Number.isFinite(ageMs)) ? "ukjent" : `${Math.round(ageMs / 1000)}s`;
    const countStr = `${visible.length} synlige`;
    const hiddenStr = ` • Skjult (gammel pos.): ${hiddenOld}`;
    const warmStr = warming ? " • (varmer cache…)" : "";
    const staleStr = stale ? " • STALE" : "";
    const meta = `Cache-age: ${ageStr}${warmStr}${staleStr} • ${countStr}${hiddenStr}`;

    if (lastError) {
      setStatus({
        level: stale ? "bad" : "warn",
        text: "Feil mot Entur – viser sist kjente data",
        meta: `${meta} • ${String(lastError).slice(0, 120)}`
      });
    } else if (stale) {
      setStatus({ level: "warn", text: "Data kan være utdatert", meta });
    } else {
      setStatus({ level: "good", text: "OK – oppdatert", meta });
    }

    if (vehicles.length === 0) {
      setStatus({
        level: warming ? "warn" : "bad",
        text: warming ? "Henter data (cold start)..." : "Ingen data i cache",
        meta
      });
    }
  }

  async function tick() {
    try {
      await fetchVehicles();
    } catch (err) {
      setStatus({
        level: "bad",
        text: "Kunne ikke hente /api/vehicles",
        meta: String(err && err.message ? err.message : err).slice(0, 160)
      });
    }
  }

  tick();
  setInterval(tick, POLL_MS);
})();
