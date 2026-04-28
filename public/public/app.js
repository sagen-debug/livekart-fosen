(() => {
  const POLL_MS = 10_000;

  // Stale-regler
  const HIDE_OLD_BUS_MS = 30 * 60 * 1000;
  const HIDE_OLD_BOAT_MS = 15 * 60 * 1000;

  // Ghost-fix: maks 2 aktive båter/ferger per rute (8xx)
  const MAX_ACTIVE_BOATS_PER_ROUTE = 2;
  const FERRY_CODES = new Set(["850", "855", "860", "870", "950"]);
  const SCHOOL_BUS_CODE_PATTERN = /^(55|59)\d\d$/;

  // Versjons-stempel så du ser at riktig JS faktisk er lastet
  const BUILD = "vehicle-filters-3";
  const root = document.getElementById("livekart-fosen-widget");
  if (!root) return;

  const qs = new URLSearchParams(location.search);
  if (qs.get("embed") === "1") root.classList.add("embed");

  const statusTextEl = root.querySelector('[data-livekart-role="statusText"]');
  const metaTextEl = root.querySelector('[data-livekart-role="metaText"]');
  const dotEl = root.querySelector('[data-livekart-role="dot"]');
  const toggleBusEl = root.querySelector('[data-livekart-role="toggleBus"]');
  const toggleSchoolBusEl = root.querySelector('[data-livekart-role="toggleSchoolBus"]');
  const toggleBoatEl = root.querySelector('[data-livekart-role="toggleBoat"]');
  const mapEl = root.querySelector('[data-livekart-role="map"]');

  function loadBool(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value == null ? fallback : value === "1";
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
    showSchoolBus: loadBool("livekart_showSchoolBus", true),
    showBoat: loadBool("livekart_showBoat", true)
  };

  if (toggleBusEl) toggleBusEl.checked = filterState.showBus;
  if (toggleSchoolBusEl) toggleSchoolBusEl.checked = filterState.showSchoolBus;
  if (toggleBoatEl) toggleBoatEl.checked = filterState.showBoat;

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

  function isBoatCode(code) {
    // I AtB-logikken vår er 8xx båt/ferge
    return /^8\d\d$/.test(String(code || ""));
  }

  function isSchoolBusCode(code) {
    return SCHOOL_BUS_CODE_PATTERN.test(String(code || ""));
  }

  function vehicleTypeFromCode(code) {
    const normalized = String(code || "");
    if (isSchoolBusCode(normalized)) return "schoolBus";
    if (FERRY_CODES.has(normalized)) return "ferry";
    if (isBoatCode(normalized)) return "expressBoat";
    return "bus";
  }

  function vehicleTypeLabel(type) {
    if (type === "schoolBus") return "Skolebuss";
    if (type === "ferry") return "Ferge";
    if (type === "expressBoat") return "Hurtigbåt";
    return "Buss";
  }

  function vehicleTypeAllowed(type) {
    if (type === "schoolBus") return filterState.showSchoolBus;
    if (type === "ferry" || type === "expressBoat") return filterState.showBoat;
    return filterState.showBus;
  }

  function lastUpdatedMs(iso) {
    if (!iso) return 0;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : 0;
  }

  function isOld(lastUpdated, boat) {
    const t = lastUpdatedMs(lastUpdated);
    if (!t) return true;
    const maxAge = boat ? HIDE_OLD_BOAT_MS : HIDE_OLD_BUS_MS;
    return (Date.now() - t) > maxAge;
  }

  function delayToMinutes(delay) {
    if (typeof delay !== "number" || !Number.isFinite(delay)) return null; // ukjent
    return Math.round(delay / 60);
  }

  function isCancelledDeparture(status) {
    return Boolean(status && status.cancellation);
  }

  function badgeClass(min, departureStatus) {
    if (isCancelledDeparture(departureStatus)) return "delay-badge--cancelled";
    if (min == null) return "delay-badge--warn";
    if (min === 0) return "delay-badge--ok";
    if (Math.abs(min) <= 2) return "delay-badge--warn";
    return "delay-badge--bad";
  }

  function delayText(min, departureStatus) {
    if (isCancelledDeparture(departureStatus)) return "!";
    if (min == null) return "?";
    if (min === 0) return "0";
    if (min > 0) return `+${min}`;
    return `${min}`;
  }

  function statusLineFromDelay(min, departureStatus) {
    if (isCancelledDeparture(departureStatus)) return "Avgang kansellert";
    if (min == null) return "Status ukjent";
    if (min === 0) return "I rute";
    if (min > 0) return `Forsinket ${min} min`;
    return `Foran rute ${Math.abs(min)} min`;
  }

  function formatTime(iso) {
    if (!iso) return "Ukjent";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "Ukjent";
    return d.toLocaleString("no-NO", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
  }

  function vehicleIconSvg(type) {
    if (type === "ferry") {
      return `
        <svg class="vehicle-marker__icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 15h18l-2 4H6l-3-4z"></path>
          <path d="M6 15V9h11v6"></path>
          <path d="M8 9V6h5v3"></path>
          <path d="M8 12h1.5"></path>
          <path d="M12 12h1.5"></path>
          <path d="M16 12h1"></path>
          <path d="M4 21c1.5.8 3 .8 4.5 0s3-.8 4.5 0 3 .8 4.5 0 3-.8 4.5 0"></path>
        </svg>
      `;
    }

    if (type === "expressBoat") {
      return `
        <svg class="vehicle-marker__icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 16h11l7-4-3 4"></path>
          <path d="M5 16l2-5h8l3 5"></path>
          <path d="M8 11V7h5l3 4"></path>
          <path d="M3 19h5"></path>
          <path d="M11 19h10"></path>
          <path d="M2 21h3"></path>
          <path d="M8 21h8"></path>
        </svg>
      `;
    }

    if (type === "schoolBus") {
      return `
        <svg class="vehicle-marker__icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 15V8.5C3 7.1 4.1 6 5.5 6h13C19.9 6 21 7.1 21 8.5V15H3z"></path>
          <path d="M8 6V4h8v2"></path>
          <path d="M5 10h2.5"></path>
          <path d="M9 10h2.5"></path>
          <path d="M13 10h2.5"></path>
          <path d="M17 9v6"></path>
          <path d="M3 13h18"></path>
          <path d="M5 15v1.5"></path>
          <path d="M19 15v1.5"></path>
          <path d="M7 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"></path>
          <path d="M17 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"></path>
        </svg>
      `;
    }

    return `
      <svg class="vehicle-marker__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 15V8.5C3 7.1 4.1 6 5.5 6h13C19.9 6 21 7.1 21 8.5V15H3z"></path>
        <path d="M5 10h2.5"></path>
        <path d="M9 10h2.5"></path>
        <path d="M13 10h2.5"></path>
        <path d="M17 9v6"></path>
        <path d="M3 13h18"></path>
        <path d="M5 15v1.5"></path>
        <path d="M19 15v1.5"></path>
        <path d="M7 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"></path>
        <path d="M17 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"></path>
      </svg>
    `;
  }

  function makeIcon(publicCode, delayMin, departureStatus) {
    const code = publicCode || "?";
    const type = vehicleTypeFromCode(code);

    const html = `
      <div class="vehicle-marker vehicle-marker--${type}">
        ${vehicleIconSvg(type)}
        <div class="vehicle-marker__code">${escapeHtml(code)}</div>
        <div class="delay-badge ${badgeClass(delayMin, departureStatus)}">${escapeHtml(delayText(delayMin, departureStatus))}</div>
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

  // Leaflet
  if (!mapEl) return;
  const map = L.map(mapEl, { zoomControl: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap-bidragsytere"
  }).addTo(map);
  map.setView([63.85, 10.15], 9);
  const layer = L.layerGroup().addTo(map);
  let latestJson = null;

  function renderVehicles(json) {
    const vehicles = Array.isArray(json.vehicles) ? json.vehicles : [];
    const ageMs = typeof json.ageMs === "number" ? json.ageMs : null;
    const stale = Boolean(json.stale);
    const warming = Boolean(json.warming);
    const lastError = json.lastError || null;
    const departureStatusMeta = json.departureStatus || {};

    // 1) Gruppér aktive (ikke-gamle) båter per rute
    const activeBoatIdxByCode = new Map(); // code -> [idx...]
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      const code = v?.line?.publicCode || "";
      if (!isBoatCode(code)) continue;
      if (isOld(v.lastUpdated, true)) continue;

      const key = String(code);
      if (!activeBoatIdxByCode.has(key)) activeBoatIdxByCode.set(key, []);
      activeBoatIdxByCode.get(key).push(i);
    }

    // 2) For ruter med >2 aktive båter: velg maks 2 “beste” (nyeste, helst ulike destinasjoner)
    const keepBoatIdx = new Set();
    let cappedRoutes = 0;

    for (const [code, idxs] of activeBoatIdxByCode.entries()) {
      if (idxs.length <= MAX_ACTIVE_BOATS_PER_ROUTE) {
        idxs.forEach((i) => keepBoatIdx.add(i));
        continue;
      }

      cappedRoutes++;

      // sorter nyeste først
      const sorted = idxs
        .map((i) => ({ i, t: lastUpdatedMs(vehicles[i]?.lastUpdated) }))
        .sort((a, b) => b.t - a.t);

      const picks = [];
      const seenDest = new Set();

      // først: prøv ulike destinasjoner
      for (const item of sorted) {
        const v = vehicles[item.i];
        const dest = String(v?.destinationName || "Ukjent").trim() || "Ukjent";
        if (seenDest.has(dest)) continue;
        seenDest.add(dest);
        picks.push(item.i);
        if (picks.length >= MAX_ACTIVE_BOATS_PER_ROUTE) break;
      }

      // hvis vi fortsatt mangler (i tilfelle begge “ekte” har samme dest): fyll med nyeste uansett
      if (picks.length < MAX_ACTIVE_BOATS_PER_ROUTE) {
        for (const item of sorted) {
          if (picks.includes(item.i)) continue;
          picks.push(item.i);
          if (picks.length >= MAX_ACTIVE_BOATS_PER_ROUTE) break;
        }
      }

      picks.forEach((i) => keepBoatIdx.add(i));
    }

    // 3) Bygg synlig liste
    const visible = [];
    let hiddenOld = 0;
    let hiddenGhost = 0;

    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      const code = v?.line?.publicCode || "?";
      const boat = isBoatCode(code);

      // alltid: skjul gammel først
      if (isOld(v.lastUpdated, boat)) {
        hiddenOld++;
        continue;
      }

      // ghost-cap for båter: hvis ruten har >2 aktive og vi ikke er “valgt”
      if (boat) {
        const key = String(code);
        const activeIdxs = activeBoatIdxByCode.get(key);
        if (activeIdxs && activeIdxs.length > MAX_ACTIVE_BOATS_PER_ROUTE && !keepBoatIdx.has(i)) {
          hiddenGhost++;
          continue;
        }
      }

      visible.push(v);
    }

    // 4) Render
    layer.clearLayers();

    let busCount = 0;
    let schoolBusCount = 0;
    let expressBoatCount = 0;
    let ferryCount = 0;
    let hiddenFilter = 0;

    for (const v of visible) {
      const code = v?.line?.publicCode || "?";
      const type = vehicleTypeFromCode(code);

      if (!vehicleTypeAllowed(type)) {
        hiddenFilter++;
        continue;
      }

      if (type === "schoolBus") schoolBusCount++;
      else if (type === "ferry") ferryCount++;
      else if (type === "expressBoat") expressBoatCount++;
      else busCount++;

      const delayMin = delayToMinutes(v.delay);
      const departureStatus = v.departureStatus || null;
      const origin = v?.originName || "Ukjent";
      const dest = v?.destinationName || "Ukjent";

      const marker = L.marker([v.location.latitude, v.location.longitude], {
        icon: makeIcon(code, delayMin, departureStatus),
        keyboard: false
      });

      const cancellationDetail = isCancelledDeparture(departureStatus)
        ? `<div><strong>Avgang:</strong> ${escapeHtml(formatTime(departureStatus.aimedDepartureTime))}${departureStatus.quayName ? ` fra ${escapeHtml(departureStatus.quayName)}` : ""}</div>`
        : "";

      const popupHtml = `
        <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;">
          <div style="font-weight: 800; margin-bottom: 6px;">${escapeHtml(vehicleTypeLabel(type))} ${escapeHtml(code)}</div>
          <div><strong>Fra:</strong> ${escapeHtml(origin)}</div>
          <div><strong>Til:</strong> ${escapeHtml(dest)}</div>
          <div><strong>Status:</strong> ${escapeHtml(statusLineFromDelay(delayMin, departureStatus))}</div>
          ${cancellationDetail}
          <div><strong>Sist oppdatert:</strong> ${escapeHtml(formatTime(v.lastUpdated))}</div>
        </div>
      `;
      marker.bindPopup(popupHtml, { maxWidth: 260 });
      marker.addTo(layer);
    }

    const ageStr = (ageMs == null || !Number.isFinite(ageMs)) ? "ukjent" : `${Math.round(ageMs / 1000)}s`;
    const meta = [
      `Cache-age: ${ageStr}${warming ? " • (varmer cache…)" : ""}${stale ? " • STALE" : ""}`,
      `Buss: ${busCount}`,
      `Skolebuss: ${schoolBusCount}`,
      `Hurtigbåt: ${expressBoatCount}`,
      `Ferge: ${ferryCount}`,
      `Kansellert: ${Number(departureStatusMeta.cancelledCount || 0).toLocaleString("no-NO")}`,
      `Skjult (gammel pos.): ${hiddenOld}`,
      `Skjult (spøkelse): ${hiddenGhost}`,
      `Skjult (filter): ${hiddenFilter}`,
      `capRoutes:${cappedRoutes}`,
      `v:${BUILD}`
    ].join(" • ");

    if (!filterState.showBus && !filterState.showSchoolBus && !filterState.showBoat) {
      setStatus({ level: "warn", text: "Filter: ingenting valgt", meta });
      return;
    }

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

  function renderLatest() {
    if (latestJson) renderVehicles(latestJson);
  }

  function onToggleChange() {
    filterState.showBus = toggleBusEl ? toggleBusEl.checked : true;
    filterState.showSchoolBus = toggleSchoolBusEl ? toggleSchoolBusEl.checked : true;
    filterState.showBoat = toggleBoatEl ? toggleBoatEl.checked : true;
    saveBool("livekart_showBus", filterState.showBus);
    saveBool("livekart_showSchoolBus", filterState.showSchoolBus);
    saveBool("livekart_showBoat", filterState.showBoat);
    renderLatest();
  }

  if (toggleBusEl) toggleBusEl.addEventListener("change", onToggleChange);
  if (toggleSchoolBusEl) toggleSchoolBusEl.addEventListener("change", onToggleChange);
  if (toggleBoatEl) toggleBoatEl.addEventListener("change", onToggleChange);

  async function fetchVehicles() {
    const res = await fetch("/api/vehicles", { cache: "no-store" });
    latestJson = await res.json();
    renderVehicles(latestJson);
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
