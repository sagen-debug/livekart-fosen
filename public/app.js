(() => {
  const POLL_MS = 10_000;
  const HIDE_OLD_MS = 30 * 60 * 1000;

  // Disse regnes som båt/ferge (og farges blå)
  // (Du kan legge til flere her senere.)
  const BOAT_CODES = new Set(["800","805","810","830","835","850","880"]);

  const qs = new URLSearchParams(location.search);
  const embed = qs.get("embed") === "1";
  if (embed) document.body.classList.add("embed");

  // Valgfritt: skjul toggle-boks (f.eks. i embed)
  if (qs.get("controls") === "0") {
    const el = document.getElementById("layerControls");
    if (el) el.style.display = "none";
  }

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

  function isBoatCode(code) {
    const s = String(code || "");
    if (BOAT_CODES.has(s)) return true;
    // Robust fallback: de fleste båt/ferge-linjer i AtB ligger i 8xx-serien
    return /^8\d\d$/.test(s);
  }

  // ---- Toggle state (lagres i localStorage) ----
  const toggleBusEl = document.getElementById("toggleBus");
  const toggleBoatEl = document.getElementById("toggleBoat");

  function loadBool(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      if (v === null) return fallback;
      return v === "1";
    } catch {
      return fallback;
    }
  }
  function saveBool(key, value) {
    try {
      localStorage.setItem(key, value ? "1" : "0");
    } catch {}
  }

  const filterState = {
    showBus: loadBool("livekart_showBus", true),
    showBoat: loadBool("livekart_showBoat", true)
  };

  if (toggleBusEl) toggleBusEl.checked = filterState.showBus;
  if (toggleBoatEl) toggleBoatEl.checked = filterState.showBoat;

  function onToggleChange() {
    filterState.showBus = toggleBusEl ? toggleBusEl.checked : true;
    filterState.showBoat = toggleBoatEl ? toggleBoatEl.checked : true;
    saveBool("livekart_showBus", filterState.showBus);
    saveBool("livekart_showBoat", filterState.showBoat);
    renderLatest(); // re-render uten ny fetch
  }

  if (toggleBusEl) toggleBusEl.addEventListener("change", onToggleChange);
  if (toggleBoatEl) toggleBoatEl.addEventListener("change", onToggleChange);

  // ---- Map ----
  const map = L.map("map", { zoomControl: true });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap-bidragsytere'
  }).addTo(map);

  map.setView([63.85, 10.15], 9);
  const layer = L.layerGroup().addTo(map);

  function makeIcon(publicCode, delayMin) {
    const code = publicCode || "?";
    const boat = isBoatCode(code);

    const html = `
      <div class="vehicle-marker ${boat ? "vehicle-marker--boat" : ""}">
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

  // ---- Data + render ----
  let latest = null; // { vehicles, meta: {ageMs, stale, warming, lastError} }

  function renderLatest() {
    if (!latest) return;

    const { vehicles, meta } = latest;
    const { ageMs, stale, warming, lastError } = meta;

    const visible = [];
    let hiddenOld = 0;
    let filteredOut = 0;

    let visibleBus = 0, visibleBoat = 0;
    let hiddenOldBus = 0, hiddenOldBoat = 0;

    for (const v of vehicles) {
      const code = v?.line?.publicCode || "?";
      const boat = isBoatCode(code);
      const allowed = boat ? filterState.showBoat : filterState.showBus;

      if (!allowed) {
        filteredOut++;
        continue;
      }

      if (isOld(v.lastUpdated)) {
        hiddenOld++;
        if (boat) hiddenOldBoat++; else hiddenOldBus++;
        continue;
      }

      visible.push(v);
      if (boat) visibleBoat++; else visibleBus++;
    }

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
    const warmStr = warming ? " • (varmer cache…)" : "";
    const staleStr = stale ? " • STALE" : "";

    const parts = [
      `Cache-age: ${ageStr}${warmStr}${staleStr}`,
      `Buss: ${visibleBus}`,
     `Hurtigbåt/Ferge: ${visibleBoat}`
      `Skjult (gammel pos.): ${hiddenOld}`
    ];
    if (filteredOut) parts.push(`Skjult (filter): ${filteredOut}`);

    const metaLine = parts.join(" • ");

    if (!filterState.showBus && !filterState.showBoat) {
      setStatus({ level: "warn", text: "Filter: ingenting valgt", meta: metaLine });
      return;
    }

    if (lastError) {
      setStatus({
        level: stale ? "bad" : "warn",
        text: "Feil mot Entur – viser sist kjente data",
        meta: `${metaLine} • ${String(lastError).slice(0, 120)}`
      });
    } else if (stale) {
      setStatus({ level: "warn", text: "Data kan være utdatert", meta: metaLine });
    } else {
      setStatus({ level: "good", text: "OK – oppdatert", meta: metaLine });
    }

    if (vehicles.length === 0) {
      setStatus({
        level: warming ? "warn" : "bad",
        text: warming ? "Henter data (cold start)..." : "Ingen data i cache",
        meta: metaLine
      });
    }
  }

  async function fetchVehicles() {
    const res = await fetch("/api/vehicles", { cache: "no-store" });
    const json = await res.json();

    const vehicles = Array.isArray(json.vehicles) ? json.vehicles : [];
    latest = {
      vehicles,
      meta: {
        ageMs: typeof json.ageMs === "number" ? json.ageMs : null,
        stale: Boolean(json.stale),
        warming: Boolean(json.warming),
        lastError: json.lastError || null
      }
    };

    renderLatest();
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