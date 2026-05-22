/* Timeline Trace — app.js
 * Plain ES-Module JS (no build step).
 * Privacy: JSON is parsed locally. Only map tiles hit the network.
 */

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @typedef {{lat:number,lng:number}} LatLng */
/** @typedef {"activity"|"visit"|"rawpoint"} ItemKind */

/**
 * @typedef {Object} Item
 * @property {ItemKind} kind
 * @property {Date} start
 * @property {Date|null} end
 * @property {string} title
 * @property {string} subtitle
 * @property {string} emoji
 * @property {LatLng|null} point
 * @property {LatLng[]} path
 * @property {number|null} distanceMeters
 * @property {string|null} activityType
 */

const state = {
  /** @type {Item[]} */ items: [],
  /** @type {Date[]} */ sortedDays: [],
  /** @type {Set<number>} */ dayKeySet: new Set(),
  /** @type {Date|null} */ selectedDay: null,
  /** @type {"timelineObjects"|"semanticSegments"|"recordsLocations"|"unknown"} */
  detectedFormat: "unknown",
  /** @type {any} */ map: null,
  /** @type {any[]} */ mapLayers: [],
  /** @type {Date|null} */ monthAnchor: null,
};

/* ─── Date helpers ─── */
function dayKey(d) {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function formatDayJP(d) {
  try { return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium" }).format(d); }
  catch { return d.toLocaleDateString("ja-JP"); }
}
function formatTimeJP(d) {
  try { return new Intl.DateTimeFormat("ja-JP", { timeStyle: "short" }).format(d); }
  catch { return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }); }
}

function parseDateDual(isoString, msString) {
  if (typeof isoString === "string") {
    const d = new Date(isoString);
    if (!isNaN(d.getTime())) return d;
  }
  if (typeof msString === "string" || typeof msString === "number") {
    const ms = Number(msString);
    if (Number.isFinite(ms)) {
      const d = new Date(ms);
      if (!isNaN(d.getTime())) return d;
    }
  }
  return null;
}

function parseLatLngString(s) {
  if (!s || typeof s !== "string") return null;
  const cleaned = s.replace(/[°\s]/g, "");
  const parts = cleaned.split(",");
  if (parts.length >= 2) {
    const lat = Number(parts[0]), lng = Number(parts[1]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  const m = cleaned.match(/(-?\d+(?:\.\d+)?).*(-?\d+(?:\.\d+)?)/);
  if (m) {
    const lat = Number(m[1]), lng = Number(m[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  return null;
}

function latE7ToNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n * 1e-7 : null;
}

function pickFirstString(...candidates) {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length) return c.trim();
  }
  return "";
}

/* ─── Activity metadata ─── */
function activityEmoji(activityType) {
  const t = (activityType || "").toUpperCase();
  if (t.includes("WALK") || t.includes("RUN")) return "🚶";
  if (t.includes("BIC") || t.includes("CYCLE")) return "🚴";
  if (t.includes("TRAIN") || t.includes("SUBWAY") || t.includes("TRAM")) return "🚆";
  if (t.includes("BUS")) return "🚌";
  if (t.includes("FLY")) return "✈️";
  if (t.includes("PASSENGER") || t.includes("CAR") || t.includes("VEHICLE")) return "🚗";
  if (t.includes("STILL")) return "🧍";
  return "➡️";
}

/**
 * Returns CSS color and label for an activity type.
 * @param {string|null} activityType
 * @param {ItemKind} kind
 * @returns {{ dot: string, badge: string, badgeBg: string }}
 */
function activityStyle(kind, activityType) {
  if (kind === "visit") return { dot: "#22d3ee", badge: "訪問", badgeBg: "rgba(34,211,238,.15)", badgeColor: "#67e8f9" };
  if (kind === "rawpoint") return { dot: "#94a3b8", badge: "GPS", badgeBg: "rgba(148,163,184,.12)", badgeColor: "#cbd5e1" };
  const t = (activityType || "").toUpperCase();
  if (t.includes("WALK") || t.includes("RUN"))
    return { dot: "#4ade80", badge: "歩行", badgeBg: "rgba(74,222,128,.15)", badgeColor: "#86efac" };
  if (t.includes("BIC") || t.includes("CYCLE"))
    return { dot: "#fb923c", badge: "自転車", badgeBg: "rgba(251,146,60,.15)", badgeColor: "#fdba74" };
  if (t.includes("TRAIN") || t.includes("SUBWAY") || t.includes("TRAM"))
    return { dot: "#a78bfa", badge: "電車", badgeBg: "rgba(167,139,250,.15)", badgeColor: "#c4b5fd" };
  if (t.includes("BUS"))
    return { dot: "#60a5fa", badge: "バス", badgeBg: "rgba(96,165,250,.15)", badgeColor: "#93c5fd" };
  if (t.includes("FLY"))
    return { dot: "#38bdf8", badge: "飛行機", badgeBg: "rgba(56,189,248,.15)", badgeColor: "#7dd3fc" };
  if (t.includes("PASSENGER") || t.includes("CAR") || t.includes("VEHICLE"))
    return { dot: "#f472b6", badge: "車", badgeBg: "rgba(244,114,182,.15)", badgeColor: "#f9a8d4" };
  return { dot: "#818cf8", badge: "移動", badgeBg: "rgba(129,140,248,.15)", badgeColor: "#a5b4fc" };
}

/* ─── Parsers ─── */
/** @returns {{ items: Item[], detectedFormat: string }} */
function parseAnyGoogleTimeline(json) {
  if (json && Array.isArray(json.timelineObjects))
    return { items: parseTimelineObjects(json.timelineObjects), detectedFormat: "timelineObjects" };
  if (json && Array.isArray(json.semanticSegments))
    return { items: parseSemanticSegments(json.semanticSegments), detectedFormat: "semanticSegments" };
  if (json && Array.isArray(json.locations))
    return { items: parseRecordsLocations(json.locations), detectedFormat: "recordsLocations" };
  return { items: [], detectedFormat: "unknown" };
}

function parseTimelineObjects(objs) {
  /** @type {Item[]} */ const items = [];
  for (const obj of objs) {
    if (obj?.activitySegment) {
      const seg = obj.activitySegment;
      const dur = seg.duration || {};
      const start = parseDateDual(dur.startTimestamp, dur.startTimestampMs);
      const end   = parseDateDual(dur.endTimestamp,   dur.endTimestampMs);
      if (!start) continue;
      const activityType = seg.activityType ? String(seg.activityType) : null;
      const distanceMeters = seg.distance != null ? Number(seg.distance) : null;
      const title = activityType
        ? activityType.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
        : "移動";
      const subtitle = Number.isFinite(distanceMeters)
        ? (distanceMeters >= 1000 ? `${(distanceMeters / 1000).toFixed(1)} km` : `${Math.round(distanceMeters)} m`)
        : "移動";
      /** @type {LatLng[]} */ let path = [];
      const wps = seg.waypointPath?.waypoints;
      if (Array.isArray(wps)) {
        for (const p of wps) {
          const lat = latE7ToNum(p?.latE7), lng = latE7ToNum(p?.lngE7);
          if (lat != null && lng != null) path.push({ lat, lng });
        }
      }
      if (path.length === 0) {
        const sLat = latE7ToNum(seg.startLocation?.latitudeE7), sLng = latE7ToNum(seg.startLocation?.longitudeE7);
        const eLat = latE7ToNum(seg.endLocation?.latitudeE7),   eLng = latE7ToNum(seg.endLocation?.longitudeE7);
        if (sLat != null && sLng != null) path.push({ lat: sLat, lng: sLng });
        if (eLat != null && eLng != null) path.push({ lat: eLat, lng: eLng });
      }
      items.push({ kind: "activity", start, end: end || null, title, subtitle,
        emoji: activityEmoji(activityType), point: null, path,
        distanceMeters: Number.isFinite(distanceMeters) ? distanceMeters : null, activityType });
    }
    if (obj?.placeVisit) {
      const v = obj.placeVisit;
      const dur = v.duration || {};
      const start = parseDateDual(dur.startTimestamp, dur.startTimestampMs);
      const end   = parseDateDual(dur.endTimestamp,   dur.endTimestampMs);
      if (!start) continue;
      const loc = v.location || {};
      const lat = latE7ToNum(loc.latitudeE7), lng = latE7ToNum(loc.longitudeE7);
      items.push({ kind: "visit", start, end: end || null,
        title: (loc.name && String(loc.name)) || "不明な場所",
        subtitle: (loc.address && String(loc.address)) || "住所不明",
        emoji: "📍", point: (lat != null && lng != null) ? { lat, lng } : null,
        path: [], distanceMeters: null, activityType: null });
    }
  }
  return items;
}

function parseSemanticSegments(segs) {
  /** @type {Item[]} */ const items = [];
  for (const seg of segs) {
    const start = typeof seg?.startTime === "string" ? new Date(seg.startTime) : null;
    const end   = typeof seg?.endTime === "string"   ? new Date(seg.endTime)   : null;
    if (!start || isNaN(start.getTime())) continue;
    if (seg.visit) {
      const top = seg.visit?.topCandidate || {};
      const latLngStr = typeof top.placeLocation?.latLng === "string" ? top.placeLocation.latLng
        : typeof top.placeLocation === "string" ? top.placeLocation : null;
      const point = parseLatLngString(latLngStr);
      const name = pickFirstString(top.placeName, top.name, top.placeId, top.semanticType, "Visit");
      const addr = pickFirstString(top.placeAddress, top.address, seg.visit?.address, "");
      items.push({ kind: "visit", start, end: (end && !isNaN(end.getTime())) ? end : null,
        title: name, subtitle: addr || "訪問", emoji: "📍", point, path: [],
        distanceMeters: null, activityType: null });
      continue;
    }
    if (seg.activity) {
      const top = seg.activity?.topCandidate || {};
      const type = pickFirstString(top.type, seg.activity?.type, "ACTIVITY");
      const title = type ? type.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : "移動";
      const dist = seg.activity?.distanceMeters != null ? Number(seg.activity.distanceMeters) : null;
      const subtitle = Number.isFinite(dist)
        ? (dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist)} m`)
        : "移動";
      /** @type {LatLng[]} */ const path = [];
      if (Array.isArray(seg.timelinePath)) {
        for (const p of seg.timelinePath) {
          const pt = parseLatLngString(p?.point);
          if (pt) path.push(pt);
        }
      }
      if (path.length === 0) {
        const sp = parseLatLngString(seg.activity?.start?.latLng);
        const ep = parseLatLngString(seg.activity?.end?.latLng);
        if (sp) path.push(sp);
        if (ep) path.push(ep);
      }
      items.push({ kind: "activity", start, end: (end && !isNaN(end.getTime())) ? end : null,
        title, subtitle, emoji: activityEmoji(type), point: null, path,
        distanceMeters: Number.isFinite(dist) ? dist : null, activityType: type || null });
    }
  }
  return items;
}

function parseRecordsLocations(locs) {
  /** @type {Item[]} */ const items = [];
  for (const loc of locs) {
    const ms = loc?.timestampMs ?? loc?.timestampMS ?? loc?.timestamp ?? null;
    const t = parseDateDual(null, ms);
    if (!t) continue;
    const lat = latE7ToNum(loc?.latitudeE7), lng = latE7ToNum(loc?.longitudeE7);
    if (lat == null || lng == null) continue;
    items.push({ kind: "rawpoint", start: t, end: null, title: "Location point",
      subtitle: `accuracy=${loc?.accuracy ?? "?"}m`, emoji: "•",
      point: { lat, lng }, path: [], distanceMeters: null, activityType: null });
  }
  return items;
}

/* ─── State helpers ─── */
function rebuildDays() {
  state.dayKeySet.clear();
  for (const it of state.items) state.dayKeySet.add(dayKey(it.start));
  const keys = Array.from(state.dayKeySet).sort((a, b) => a - b);
  state.sortedDays = keys.map(k => {
    const y = Math.floor(k / 10000), m = Math.floor((k % 10000) / 100) - 1, d = k % 100;
    return new Date(y, m, d);
  });
  state.monthAnchor = state.sortedDays[0] ?? null;
  state.selectedDay = state.sortedDays[0] ?? null;
  $("countItems").textContent = String(state.items.length);
  $("countDays").textContent  = String(state.sortedDays.length);
  updateNavButtons();
}

function currentDayIndex() {
  if (!state.selectedDay) return -1;
  const k = dayKey(state.selectedDay);
  return state.sortedDays.findIndex(d => dayKey(d) === k);
}

function updateNavButtons() {
  const idx = currentDayIndex(), has = state.sortedDays.length > 0;
  $("prevBtn").disabled = !has || idx <= 0;
  $("nextBtn").disabled = !has || idx < 0 || idx >= state.sortedDays.length - 1;
}

function goPrev() { const i = currentDayIndex(); if (i > 0) { state.selectedDay = state.sortedDays[i - 1]; renderAll(); } }
function goNext() { const i = currentDayIndex(); if (i >= 0 && i < state.sortedDays.length - 1) { state.selectedDay = state.sortedDays[i + 1]; renderAll(); } }

function itemsForSelectedDay() {
  if (!state.selectedDay) return [];
  const s = startOfDay(state.selectedDay);
  const e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1);
  return state.items.filter(it => it.start >= s && it.start < e)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/* ─── Render ─── */
function renderHeader() {
  if (!state.selectedDay) {
    $("dayTitle").textContent = "データなし";
    $("daySub").textContent   = "JSONを選んでください";
    $("dayPill").textContent  = "—";
    $("statDay").textContent  = "—";
    return;
  }
  $("dayTitle").textContent = formatDayJP(state.selectedDay);
  $("daySub").textContent   = `${state.sortedDays.length} 日間のデータ`;
  $("dayPill").textContent  = `${currentDayIndex() + 1} / ${state.sortedDays.length}`;
  $("statDay").textContent  = `${currentDayIndex() + 1}`;
}

function renderCalendar() {
  const root = $("calendar");
  root.innerHTML = "";
  if (!state.monthAnchor || !state.sortedDays.length) {
    root.innerHTML = `<div style="padding:8px 0;color:var(--muted);font-size:12px;">JSONを読み込むとカレンダーが表示されます。</div>`;
    return;
  }

  const anchor = state.monthAnchor;
  const y = anchor.getFullYear(), m = anchor.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const leadEmpty   = new Date(y, m, 1).getDay();

  // Month navigation header
  const header = document.createElement("div");
  header.className = "cal-header";
  header.innerHTML = `
    <div class="cal-month">${y}年 ${m + 1}月</div>
    <div class="cal-nav">
      <button class="cal-nav-btn" id="calPrev" title="前の月">&#8249;</button>
      <button class="cal-nav-btn" id="calNext" title="次の月">&#8250;</button>
    </div>`;
  root.appendChild(header);

  header.querySelector("#calPrev").addEventListener("click", () => {
    if (!state.monthAnchor) return;
    const a = state.monthAnchor;
    state.monthAnchor = new Date(a.getFullYear(), a.getMonth() - 1, 1);
    renderCalendar();
  });
  header.querySelector("#calNext").addEventListener("click", () => {
    if (!state.monthAnchor) return;
    const a = state.monthAnchor;
    state.monthAnchor = new Date(a.getFullYear(), a.getMonth() + 1, 1);
    renderCalendar();
  });

  const grid = document.createElement("div");
  grid.className = "cal-grid";

  const dows = ["日", "月", "火", "水", "木", "金", "土"];
  for (const s of dows) {
    const el = document.createElement("div");
    el.className = "cal-dow"; el.textContent = s;
    grid.appendChild(el);
  }

  for (let i = 0; i < leadEmpty + daysInMonth; i++) {
    const cell = document.createElement("div");
    if (i < leadEmpty) { cell.className = "cal-day empty"; grid.appendChild(cell); continue; }
    const day  = i - leadEmpty + 1;
    const date = new Date(y, m, day);
    const k    = dayKey(date);
    const avail    = state.dayKeySet.has(k);
    const selected = state.selectedDay && dayKey(state.selectedDay) === k;
    cell.className = "cal-day" + (avail ? " avail" : "") + (selected ? " selected" : "");
    cell.textContent = String(day);
    if (avail) {
      const dot = document.createElement("div");
      dot.className = "cal-dot";
      cell.appendChild(dot);
      cell.addEventListener("click", () => { state.selectedDay = date; renderAll(); });
    }
    grid.appendChild(cell);
  }
  root.appendChild(grid);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replaceAll("\n", " "); }

function renderList() {
  const list = $("list");
  const items = itemsForSelectedDay();
  list.innerHTML = "";

  if (!state.selectedDay || items.length === 0) {
    list.innerHTML = `<div class="tl-empty">${
      !state.selectedDay ? "JSONを選んでください。" : "この日はデータがありません。"
    }</div>`;
    return;
  }

  const container = document.createElement("div");
  container.className = "tl-items";

  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    const style = activityStyle(it.kind, it.activityType);
    const t0 = formatTimeJP(it.start);
    const t1 = it.end ? formatTimeJP(it.end) : "";

    const row = document.createElement("div");
    row.className = "tl-item";
    row.style.animationDelay = `${idx * 0.03}s`;
    row.title = `${it.title} — ${it.subtitle}`;
    row.innerHTML = `
      <div class="tl-left">
        <div class="tl-dot" style="background:${escapeAttr(style.dot)};box-shadow:0 0 6px ${escapeAttr(style.dot)}66"></div>
        <div class="tl-time">${escapeHtml(t0)}${t1 ? `<br/><span style="opacity:.6">${escapeHtml(t1)}</span>` : ""}</div>
      </div>
      <div class="tl-card">
        <div class="tl-title-row">
          <span class="tl-emoji">${escapeHtml(it.emoji)}</span>
          <span class="tl-name" title="${escapeAttr(it.title)}">${escapeHtml(it.title)}</span>
        </div>
        <div class="tl-sub" title="${escapeAttr(it.subtitle)}">${escapeHtml(it.subtitle)}</div>
        <div class="tl-badge" style="background:${escapeAttr(style.badgeBg)};color:${escapeAttr(style.badgeColor)}">${escapeHtml(style.badge)}</div>
      </div>`;
    row.addEventListener("click", () => focusItemOnMap(it));
    container.appendChild(row);
  }

  list.appendChild(container);
}

/* ─── Map ─── */
function ensureMap() {
  if (state.map) return;
  if (!window.L) { setTimeout(ensureMap, 30); return; }

  state.map = window.L.map("map", { zoomControl: true });
  state.map.setView([35.681236, 139.767125], 11);

  // CARTO Dark Matter — no API key needed
  window.L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    {
      maxZoom: 19,
      subdomains: "abcd",
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
        '&copy; <a href="https://carto.com/attributions">CARTO</a>',
    }
  ).addTo(state.map);

  state.map.on("click", () => hideToast());
}

function clearMapLayers() {
  if (!state.map) return;
  for (const layer of state.mapLayers) { try { state.map.removeLayer(layer); } catch { /**/ } }
  state.mapLayers = [];
}

/** Create a custom SVG circle marker */
function makeCircleIcon(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="28" viewBox="0 0 22 28">
    <filter id="s"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="${color}" flood-opacity=".5"/></filter>
    <path d="M11 1C6.03 1 2 5.03 2 10c0 6.25 9 17 9 17s9-10.75 9-17c0-4.97-4.03-9-9-9z"
      fill="${color}" filter="url(#s)"/>
    <circle cx="11" cy="10" r="3.5" fill="white" opacity=".9"/>
  </svg>`;
  return window.L.divIcon({
    html: svg,
    className: "",
    iconSize: [22, 28],
    iconAnchor: [11, 28],
    popupAnchor: [0, -28],
  });
}

function renderMap() {
  ensureMap();
  if (!state.map) return;
  clearMapLayers();

  const items = itemsForSelectedDay();
  /** @type {LatLng[]} */ const coords = [];

  for (const it of items) {
    const style = activityStyle(it.kind, it.activityType);

    if (it.kind === "activity" && it.path.length >= 2) {
      const latlngs = it.path.map(p => [p.lat, p.lng]);
      // Glow outline
      const glow = window.L.polyline(latlngs, { weight: 7, opacity: 0.25, color: style.dot });
      const line = window.L.polyline(latlngs, { weight: 3, opacity: 0.9,  color: style.dot });
      glow.addTo(state.map); line.addTo(state.map);
      state.mapLayers.push(glow, line);
      coords.push(...it.path);
      // Start/end markers
      const first = it.path[0], last = it.path[it.path.length - 1];
      const mStart = window.L.circleMarker([first.lat, first.lng],
        { radius: 5, color: style.dot, fillColor: style.dot, fillOpacity: 1, weight: 2, opacity: 1 });
      const mEnd   = window.L.circleMarker([last.lat, last.lng],
        { radius: 5, color: "#fff",     fillColor: style.dot, fillOpacity: 1, weight: 2, opacity: 1 });
      mStart.bindTooltip(it.title, { direction: "top", opacity: 0.9 });
      mEnd.bindTooltip(it.title + " (終点)", { direction: "top", opacity: 0.9 });
      mStart.addTo(state.map); mEnd.addTo(state.map);
      state.mapLayers.push(mStart, mEnd);

    } else if (it.kind === "visit" && it.point) {
      const icon   = makeCircleIcon(style.dot);
      const marker = window.L.marker([it.point.lat, it.point.lng], { icon });
      marker.bindPopup(
        `<div style="min-width:160px"><b style="font-size:13px">${escapeHtml(it.title)}</b>` +
        (it.subtitle ? `<div style="color:#94a3b8;font-size:11px;margin-top:4px">${escapeHtml(it.subtitle)}</div>` : "") +
        "</div>"
      );
      marker.addTo(state.map);
      state.mapLayers.push(marker);
      coords.push(it.point);

    } else if (it.kind === "rawpoint" && it.point) {
      const circ = window.L.circleMarker([it.point.lat, it.point.lng],
        { radius: 2, color: "#94a3b8", fillColor: "#94a3b8", fillOpacity: 0.6, weight: 0 });
      circ.addTo(state.map);
      state.mapLayers.push(circ);
      coords.push(it.point);
    }
  }

  if (coords.length) {
    const bounds = window.L.latLngBounds(coords.map(p => [p.lat, p.lng]));
    state.map.fitBounds(bounds.pad(0.14), { animate: true, maxZoom: 16 });
  }
}

function focusItemOnMap(it) {
  ensureMap();
  if (!state.map) return;
  const style = activityStyle(it.kind, it.activityType);
  if (it.kind === "visit" && it.point) {
    state.map.setView([it.point.lat, it.point.lng], Math.max(state.map.getZoom(), 16), { animate: true });
    showToast(it.title, it.subtitle);
  } else if (it.kind === "activity" && it.path.length >= 2) {
    const bounds = window.L.latLngBounds(it.path.map(p => [p.lat, p.lng]));
    state.map.fitBounds(bounds.pad(0.2), { animate: true });
    showToast(it.title, it.subtitle);
  } else if (it.kind === "rawpoint" && it.point) {
    state.map.setView([it.point.lat, it.point.lng], Math.max(state.map.getZoom(), 16), { animate: true });
    showToast(it.title, it.subtitle);
  }
}

/* ─── renderAll ─── */
function renderAll() {
  renderHeader();
  renderCalendar();
  renderList();
  renderMap();
  updateNavButtons();
}

/* ─── Toast ─── */
function showToast(msg, small = "") {
  $("toastMsg").textContent   = msg  || "";
  $("toastSmall").textContent = small || "";
  $("toast").classList.add("show");
  window.clearTimeout(showToast._t);
  showToast._t = window.setTimeout(() => hideToast(), 2800);
}
function hideToast() { $("toast").classList.remove("show"); }

/* ─── File reading ─── */
async function readFileAsText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onerror = () => rej(r.error);
    r.onload  = () => res(String(r.result || ""));
    r.readAsText(file);
  });
}

async function onFileSelected(file) {
  if (!file) return;
  showToast("読み込み中…", file.name);
  const text = await readFileAsText(file).catch(e => { showToast("Read error", String(e)); return null; });
  if (!text) return;
  let json;
  try { json = JSON.parse(text); }
  catch (e) { showToast("JSON parse error", String(e)); return; }

  const parsed = parseAnyGoogleTimeline(json);
  state.items  = parsed.items.filter(it => it.start && !isNaN(it.start.getTime()))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  state.detectedFormat = parsed.detectedFormat;

  rebuildDays();
  updateFormatPill();

  if (!state.items.length) {
    showToast("データが見つかりません", "timelineObjects / semanticSegments / locations[] を確認してください");
    renderAll();
    return;
  }
  showToast(`${state.items.length} 件を読み込みました`, `${state.sortedDays.length} 日分 · ${parsed.detectedFormat}`);
  renderAll();
}

function updateFormatPill() {
  const labels = {
    timelineObjects:  "timelineObjects",
    semanticSegments: "semanticSegments",
    recordsLocations: "Records.json",
    unknown:          "不明なフォーマット",
  };
  $("formatPill").textContent = labels[state.detectedFormat] || "不明";
}

/* ─── Keyboard ─── */
function setupShortcuts() {
  window.addEventListener("keydown", e => {
    if (e.altKey && e.key === "ArrowLeft")  { e.preventDefault(); goPrev(); }
    if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); goNext(); }
  });
}

/* ─── PWA ─── */
async function setupPWA() {
  if (!("serviceWorker" in navigator)) return;
  try { await navigator.serviceWorker.register("./sw.js", { scope: "./" }); }
  catch (e) { console.warn("SW registration failed:", e); }
}

/* ─── Boot ─── */
function setupUI() {
  const fi = /** @type {HTMLInputElement} */ ($("fileInput"));
  fi.addEventListener("change", async () => {
    const f = fi.files?.[0];
    if (f) await onFileSelected(f);
  });
  $("prevBtn").addEventListener("click", goPrev);
  $("nextBtn").addEventListener("click", goNext);
}

setupUI();
setupShortcuts();
setupPWA();
ensureMap();
renderAll();
