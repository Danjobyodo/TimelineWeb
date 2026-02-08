/* Timeline Trace (Local)
 * - Plain JS (ES Modules) to keep file count small (GitHub Pages friendly).
 * - Designed so the parsing / map layer can be swapped later (Leaflet -> MapLibre etc).
 *
 * Privacy: This app does not upload your JSON anywhere. It parses locally.
 * (It does fetch map tiles from a public tile server for background rendering.)
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

/** @typedef {Object} ParsedData
 * @property {Item[]} items
 * @property {"timelineObjects"|"semanticSegments"|"recordsLocations"|"unknown"} detectedFormat
 */

const state = {
  /** @type {Item[]} */
  items: [],
  /** @type {Date[]} sortedDays */
  sortedDays: [],
  /** @type {Set<number>} */
  dayKeySet: new Set(),
  /** @type {Date|null} */
  selectedDay: null,
  /** @type {"timelineObjects"|"semanticSegments"|"recordsLocations"|"unknown"} */
  detectedFormat: "unknown",
  /** @type {any} */
  map: null,
  /** @type {any[]} */
  mapLayers: [],
  /** @type {Date|null} */
  monthAnchor: null,
};

function dayKey(d){
  // YYYYMMDD in local time
  const y = d.getFullYear();
  const m = d.getMonth()+1;
  const dd = d.getDate();
  return y*10000 + m*100 + dd;
}
function startOfDay(d){
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function formatDayJP(d){
  try{
    return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium" }).format(d);
  } catch {
    return d.toLocaleDateString("ja-JP");
  }
}
function formatTimeJP(d){
  try{
    return new Intl.DateTimeFormat("ja-JP", { timeStyle: "short" }).format(d);
  } catch {
    return d.toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"});
  }
}
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

/** Parse "35.1234567°, 139.1234567°" or "35.123,139.123" etc. */
function parseLatLngString(s){
  if(!s || typeof s !== "string") return null;
  // remove degree sign and spaces
  const cleaned = s.replace(/[°\s]/g, "");
  // allow comma separated
  const parts = cleaned.split(",");
  if(parts.length >= 2){
    const lat = Number(parts[0]);
    const lng = Number(parts[1]);
    if(Number.isFinite(lat) && Number.isFinite(lng)) return {lat, lng};
  }
  // fallback: find two floats via regex
  const m = cleaned.match(/(-?\d+(?:\.\d+)?).*(-?\d+(?:\.\d+)?)/);
  if(m){
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if(Number.isFinite(lat) && Number.isFinite(lng)) return {lat, lng};
  }
  return null;
}

function latE7ToNum(v){
  const n = Number(v);
  if(!Number.isFinite(n)) return null;
  return n * 1e-7;
}

/** New/old timelineObjects date parser: ISO8601 string OR epoch(ms) string */
function parseDateDual(isoString, msString){
  if(typeof isoString === "string"){
    const d = new Date(isoString);
    if(!isNaN(d.getTime())) return d;
  }
  if(typeof msString === "string" || typeof msString === "number"){
    const ms = Number(msString);
    if(Number.isFinite(ms)){
      const d = new Date(ms);
      if(!isNaN(d.getTime())) return d;
    }
  }
  return null;
}

/** @returns {ParsedData} */
function parseAnyGoogleTimeline(json){
  // 1) timelineObjects (Google Takeout "Semantic Location History" style)
  if(json && Array.isArray(json.timelineObjects)){
    const items = parseTimelineObjects(json.timelineObjects);
    return {items, detectedFormat:"timelineObjects"};
  }

  // 2) semanticSegments (new on-device export format)
  if(json && Array.isArray(json.semanticSegments)){
    const items = parseSemanticSegments(json.semanticSegments);
    return {items, detectedFormat:"semanticSegments"};
  }

  // 3) Records.json raw location history (locations[])
  if(json && Array.isArray(json.locations)){
    const items = parseRecordsLocations(json.locations);
    return {items, detectedFormat:"recordsLocations"};
  }

  return {items:[], detectedFormat:"unknown"};
}

/** @param {any[]} timelineObjects @returns {Item[]} */
function parseTimelineObjects(timelineObjects){
  /** @type {Item[]} */
  const items = [];

  for(const obj of timelineObjects){
    if(obj && obj.activitySegment){
      const seg = obj.activitySegment;

      const dur = seg.duration || {};
      const start = parseDateDual(dur.startTimestamp, dur.startTimestampMs);
      const end = parseDateDual(dur.endTimestamp, dur.endTimestampMs);

      // activityType / distance
      const activityType = (seg.activityType && String(seg.activityType)) || null;
      const distanceMeters = (seg.distance != null ? Number(seg.distance) : null);
      const title = activityType ? activityType.replaceAll("_"," ").toLowerCase().replace(/\b\w/g, c=>c.toUpperCase()) : "移動";
      const subtitle = Number.isFinite(distanceMeters)
        ? (distanceMeters >= 1000 ? `${(distanceMeters/1000).toFixed(1)} km の移動` : `${Math.round(distanceMeters)} m の移動`)
        : "移動";

      // path (waypoints)
      /** @type {LatLng[]} */
      let path = [];
      const wps = seg.waypointPath?.waypoints;
      if(Array.isArray(wps)){
        for(const p of wps){
          const lat = latE7ToNum(p?.latE7);
          const lng = latE7ToNum(p?.lngE7);
          if(lat != null && lng != null) path.push({lat,lng});
        }
      }

      // start/end points fallback
      const sLoc = seg.startLocation;
      const eLoc = seg.endLocation;
      const sLat = latE7ToNum(sLoc?.latitudeE7);
      const sLng = latE7ToNum(sLoc?.longitudeE7);
      const eLat = latE7ToNum(eLoc?.latitudeE7);
      const eLng = latE7ToNum(eLoc?.longitudeE7);
      if(path.length === 0){
        if(sLat!=null && sLng!=null) path.push({lat:sLat,lng:sLng});
        if(eLat!=null && eLng!=null) path.push({lat:eLat,lng:eLng});
      }

      const emoji = activityEmoji(activityType);

      if(start){
        items.push({
          kind: "activity",
          start,
          end: end || null,
          title,
          subtitle,
          emoji,
          point: null,
          path,
          distanceMeters: Number.isFinite(distanceMeters) ? distanceMeters : null,
          activityType,
        });
      }
    }

    if(obj && obj.placeVisit){
      const v = obj.placeVisit;
      const dur = v.duration || {};
      const start = parseDateDual(dur.startTimestamp, dur.startTimestampMs);
      const end = parseDateDual(dur.endTimestamp, dur.endTimestampMs);

      const loc = v.location || {};
      const name = (loc.name && String(loc.name)) || "不明な場所";
      const address = (loc.address && String(loc.address)) || "住所不明";

      const lat = latE7ToNum(loc.latitudeE7);
      const lng = latE7ToNum(loc.longitudeE7);

      if(start){
        items.push({
          kind: "visit",
          start,
          end: end || null,
          title: name,
          subtitle: address,
          emoji: "📍",
          point: (lat!=null && lng!=null) ? {lat,lng} : null,
          path: [],
          distanceMeters: null,
          activityType: null,
        });
      }
    }
  }

  return items;
}

/** @param {any[]} semanticSegments @returns {Item[]} */
function parseSemanticSegments(semanticSegments){
  /** @type {Item[]} */
  const items = [];
  for(const seg of semanticSegments){
    const start = (typeof seg?.startTime === "string") ? new Date(seg.startTime) : null;
    const end = (typeof seg?.endTime === "string") ? new Date(seg.endTime) : null;
    const startOK = start && !isNaN(start.getTime());

    if(!startOK) continue;

    // visit
    if(seg.visit){
      // Qiita references visit.topCandidate.placeLocation.latLng etc. citeturn1view0
      const top = seg.visit?.topCandidate || {};
      const placeLoc = top.placeLocation || top.placeLocationLatLng || top.placeLocation?.latLng;
      const latLngStr = typeof top.placeLocation?.latLng === "string" ? top.placeLocation.latLng
                      : typeof top.placeLocation === "string" ? top.placeLocation
                      : typeof placeLoc === "string" ? placeLoc
                      : null;
      const point = parseLatLngString(latLngStr);

      const name = pickFirstString(
        top.placeName,
        top.name,
        top.placeId,
        top.semanticType,
        seg.visit?.topCandidate?.semanticType,
        "Visit"
      );
      const addr = pickFirstString(
        top.placeAddress,
        top.address,
        seg.visit?.address,
        seg.visit?.hierarchyLevel != null ? `hierarchyLevel=${seg.visit.hierarchyLevel}` : null,
        ""
      );

      items.push({
        kind:"visit",
        start,
        end: (end && !isNaN(end.getTime())) ? end : null,
        title: name,
        subtitle: addr || "訪問",
        emoji:"📍",
        point,
        path: [],
        distanceMeters: null,
        activityType: null,
      });
      continue;
    }

    // activity
    if(seg.activity){
      const top = seg.activity?.topCandidate || {};
      const type = pickFirstString(top.type, seg.activity?.type, "ACTIVITY");
      const title = type ? type.replaceAll("_"," ").toLowerCase().replace(/\b\w/g, c=>c.toUpperCase()) : "移動";
      const dist = seg.activity?.distanceMeters != null ? Number(seg.activity.distanceMeters) : null;
      const subtitle = Number.isFinite(dist)
        ? (dist >= 1000 ? `${(dist/1000).toFixed(1)} km の移動` : `${Math.round(dist)} m の移動`)
        : "移動";

      const startPt = parseLatLngString(seg.activity?.start?.latLng);
      const endPt = parseLatLngString(seg.activity?.end?.latLng);

      /** @type {LatLng[]} */
      const path = [];
      if(Array.isArray(seg.timelinePath)){
        for(const p of seg.timelinePath){
          const pt = parseLatLngString(p?.point);
          if(pt) path.push(pt);
        }
      }

      // fallback points if path missing
      if(path.length === 0){
        if(startPt) path.push(startPt);
        if(endPt) path.push(endPt);
      }

      items.push({
        kind:"activity",
        start,
        end: (end && !isNaN(end.getTime())) ? end : null,
        title,
        subtitle,
        emoji: activityEmoji(type),
        point: null,
        path,
        distanceMeters: Number.isFinite(dist) ? dist : null,
        activityType: type || null,
      });
      continue;
    }

    // if neither visit nor activity, ignore (timelineMemory etc)
  }
  return items;
}

/** @param {any[]} locations @returns {Item[]} */
function parseRecordsLocations(locations){
  /** @type {Item[]} */
  const items = [];
  // Records.json can be huge; we keep one item per point and filter by day later.
  for(const loc of locations){
    const ms = loc?.timestampMs ?? loc?.timestampMS ?? loc?.timestamp ?? null;
    const t = parseDateDual(null, ms);
    if(!t) continue;

    const lat = latE7ToNum(loc?.latitudeE7);
    const lng = latE7ToNum(loc?.longitudeE7);
    if(lat==null || lng==null) continue;

    items.push({
      kind:"rawpoint",
      start:t,
      end:null,
      title:"Location point",
      subtitle:`accuracy=${loc?.accuracy ?? "?"}m`,
      emoji:"•",
      point:{lat,lng},
      path:[],
      distanceMeters:null,
      activityType:null,
    });
  }
  return items;
}

function pickFirstString(...candidates){
  for(const c of candidates){
    if(typeof c === "string" && c.trim().length) return c.trim();
  }
  return "";
}

function activityEmoji(activityType){
  const t = (activityType || "").toUpperCase();
  if(t.includes("WALK")) return "🚶";
  if(t.includes("BIC") || t.includes("CYCLE")) return "🚴";
  if(t.includes("TRAIN") || t.includes("SUBWAY") || t.includes("TRAM")) return "🚆";
  if(t.includes("BUS")) return "🚌";
  if(t.includes("FLY")) return "✈️";
  if(t.includes("PASSENGER") || t.includes("CAR") || t.includes("VEHICLE")) return "🚗";
  if(t.includes("STILL")) return "🧍";
  return "➡️";
}

/** Build availability set and sorted days */
function rebuildDays(){
  state.dayKeySet.clear();
  for(const it of state.items){
    const k = dayKey(it.start);
    state.dayKeySet.add(k);
  }
  const keys = Array.from(state.dayKeySet.values()).sort((a,b)=>a-b);
  state.sortedDays = keys.map(k=>{
    const y = Math.floor(k/10000);
    const m = Math.floor((k%10000)/100) - 1;
    const d = k%100;
    return new Date(y,m,d);
  });

  state.monthAnchor = state.sortedDays.length ? state.sortedDays[0] : null;
  state.selectedDay = state.sortedDays.length ? state.sortedDays[0] : null;

  $("countItems").textContent = String(state.items.length);
  $("countDays").textContent = String(state.sortedDays.length);
  $("selectedDayLabel").textContent = state.selectedDay ? formatDayJP(state.selectedDay) : "-";

  updateNavButtons();
}

/** Find nearest available day index for selected day */
function currentDayIndex(){
  if(!state.selectedDay) return -1;
  const k = dayKey(state.selectedDay);
  return state.sortedDays.findIndex(d=>dayKey(d)===k);
}

function updateNavButtons(){
  const idx = currentDayIndex();
  const has = state.sortedDays.length>0;
  $("prevBtn").disabled = !has || idx<=0;
  $("nextBtn").disabled = !has || idx<0 || idx>=state.sortedDays.length-1;
}

function goPrev(){
  const idx = currentDayIndex();
  if(idx>0){
    state.selectedDay = state.sortedDays[idx-1];
    renderAll();
  }
}
function goNext(){
  const idx = currentDayIndex();
  if(idx>=0 && idx<state.sortedDays.length-1){
    state.selectedDay = state.sortedDays[idx+1];
    renderAll();
  }
}

/** Filter items by selected day */
function itemsForSelectedDay(){
  if(!state.selectedDay) return [];
  const s = startOfDay(state.selectedDay);
  const e = new Date(s.getFullYear(), s.getMonth(), s.getDate()+1);
  return state.items.filter(it=>it.start>=s && it.start<e)
    .sort((a,b)=>a.start.getTime()-b.start.getTime());
}

function renderHeader(){
  if(!state.selectedDay){
    $("dayTitle").textContent = "データなし";
    $("daySub").textContent = "JSONを選んでください";
    $("dayPill").textContent = "-";
    return;
  }
  $("dayTitle").textContent = formatDayJP(state.selectedDay);
  $("daySub").textContent = `${state.sortedDays.length} days`;
  $("dayPill").textContent = `${currentDayIndex()+1}/${state.sortedDays.length}`;
  $("selectedDayLabel").textContent = formatDayJP(state.selectedDay);
}

function renderCalendar(){
  const root = $("calendar");
  root.innerHTML = "";
  if(!state.monthAnchor || !state.sortedDays.length){
    root.innerHTML = `<div style="padding:12px;color:var(--muted);font-size:12px;">JSONを読み込むとカレンダーが表示されます。</div>`;
    return;
  }

  const anchor = state.monthAnchor;
  const y = anchor.getFullYear();
  const m = anchor.getMonth();

  const monthStart = new Date(y,m,1);
  const monthEnd = new Date(y,m+1,0);
  const daysInMonth = monthEnd.getDate();

  const dows = ["日","月","火","水","木","金","土"]; // ja-JP default
  const leadEmpty = monthStart.getDay(); // 0..6, Sunday=0
  const total = leadEmpty + daysInMonth;

  const monthLabel = `${y}年${m+1}月`;

  const top = document.createElement("div");
  top.className = "cal-top";
  top.innerHTML = `<div class="month">${monthLabel}</div><div class="hint">濃い日 = データあり</div>`;
  root.appendChild(top);

  const grid = document.createElement("div");
  grid.className = "grid";

  // weekday header
  for(const s of dows){
    const el = document.createElement("div");
    el.className = "dow";
    el.textContent = s;
    grid.appendChild(el);
  }

  // date cells
  for(let i=0;i<total;i++){
    const cell = document.createElement("div");
    if(i < leadEmpty){
      cell.className = "cell empty";
      grid.appendChild(cell);
      continue;
    }
    const day = i - leadEmpty + 1;
    const date = new Date(y,m,day);
    const k = dayKey(date);
    const avail = state.dayKeySet.has(k);
    const selected = state.selectedDay && dayKey(state.selectedDay)===k;

    cell.className = "cell" + (avail ? " avail" : " disabled") + (selected ? " selected" : "");
    cell.textContent = String(day);

    if(avail){
      cell.addEventListener("click", ()=>{
        state.selectedDay = date;
        renderAll();
      });
    }
    grid.appendChild(cell);
  }

  root.appendChild(grid);
}

function renderList(){
  const list = $("list");
  const items = itemsForSelectedDay();
  list.innerHTML = "";

  if(!state.selectedDay){
    list.innerHTML = `<div style="padding:12px;color:var(--muted);font-size:12px;">JSONを選んでください。</div>`;
    return;
  }

  if(items.length===0){
    list.innerHTML = `<div style="padding:12px;color:var(--muted);font-size:12px;">この日はデータがありません。</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  for(const it of items){
    const row = document.createElement("div");
    row.className = "row";
    const t0 = formatTimeJP(it.start);
    const t1 = it.end ? formatTimeJP(it.end) : "";
    row.innerHTML = `
      <div class="time">${t0}${t1 ? `<br/><span style="opacity:.7">${t1}</span>`:""}</div>
      <div class="main">
        <div class="title">
          <div class="emoji">${escapeHtml(it.emoji)}</div>
          <b title="${escapeAttr(it.title)}">${escapeHtml(it.title)}</b>
        </div>
        <div class="subtitle" title="${escapeAttr(it.subtitle)}">${escapeHtml(it.subtitle)}</div>
      </div>
    `;
    row.addEventListener("click", ()=>{
      focusItemOnMap(it);
    });
    frag.appendChild(row);
  }
  list.appendChild(frag);
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, (c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function escapeAttr(s){ return escapeHtml(s).replaceAll("\n"," "); }

function ensureMap(){
  if(state.map) return;
  if(!window.L){
    // Leaflet is loaded via defer; wait a bit.
    setTimeout(ensureMap, 30);
    return;
  }
  state.map = window.L.map("map", { zoomControl: true });
  state.map.setView([35.681236, 139.767125], 11); // Tokyo station as a neutral initial view
  window.L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors"
    }
  ).addTo(state.map);

  state.map.on("click", () => hideToast());
}

function clearMapLayers(){
  if(!state.map) return;
  for(const layer of state.mapLayers){
    try{ state.map.removeLayer(layer); }catch{}
  }
  state.mapLayers = [];
}

function renderMap(){
  ensureMap();
  if(!state.map) return;
  clearMapLayers();

  const items = itemsForSelectedDay();

  /** @type {LatLng[]} */
  const coords = [];

  for(const it of items){
    if(it.kind==="activity"){
      if(it.path && it.path.length>=2){
        const latlngs = it.path.map(p=>[p.lat,p.lng]);
        const poly = window.L.polyline(latlngs, { weight: 5, opacity: 0.9 });
        poly.addTo(state.map);
        state.mapLayers.push(poly);
        coords.push(...it.path);
      }
    } else if(it.kind==="visit"){
      if(it.point){
        const marker = window.L.marker([it.point.lat, it.point.lng]);
        marker.bindPopup(`<b>${escapeHtml(it.title)}</b><br/>${escapeHtml(it.subtitle)}`);
        marker.addTo(state.map);
        state.mapLayers.push(marker);
        coords.push(it.point);
      }
    } else if(it.kind==="rawpoint"){
      // raw points can be massive -> show as small circle markers, capped
      if(it.point){
        const circ = window.L.circleMarker([it.point.lat,it.point.lng], { radius: 2, opacity: 0.7, fillOpacity: 0.7 });
        circ.addTo(state.map);
        state.mapLayers.push(circ);
        coords.push(it.point);
      }
    }
  }

  // Fit bounds
  if(coords.length){
    const bounds = window.L.latLngBounds(coords.map(p=>[p.lat,p.lng]));
    state.map.fitBounds(bounds.pad(0.12), { animate: true });
  }
}

function focusItemOnMap(it){
  ensureMap();
  if(!state.map) return;

  if(it.kind==="visit" && it.point){
    state.map.setView([it.point.lat,it.point.lng], Math.max(state.map.getZoom(), 16), { animate:true });
    showToast(it.title, it.subtitle);
  } else if(it.kind==="activity" && it.path && it.path.length>=2){
    const bounds = window.L.latLngBounds(it.path.map(p=>[p.lat,p.lng]));
    state.map.fitBounds(bounds.pad(0.2), { animate:true });
    showToast(it.title, it.subtitle);
  } else if(it.kind==="rawpoint" && it.point){
    state.map.setView([it.point.lat,it.point.lng], Math.max(state.map.getZoom(), 16), { animate:true });
    showToast(it.title, it.subtitle);
  }
}

/** main render */
function renderAll(){
  renderHeader();
  renderCalendar();
  renderList();
  renderMap();
  updateNavButtons();
}

function showToast(msg, small=""){
  $("toastMsg").textContent = msg || "";
  $("toastSmall").textContent = small || "";
  $("toast").classList.add("show");
  window.clearTimeout(showToast._t);
  showToast._t = window.setTimeout(()=>hideToast(), 2600);
}
function hideToast(){
  $("toast").classList.remove("show");
}

async function readFileAsText(file){
  return new Promise((resolve,reject)=>{
    const r = new FileReader();
    r.onerror = ()=>reject(r.error);
    r.onload = ()=>resolve(String(r.result||""));
    r.readAsText(file);
  });
}

async function onFileSelected(file){
  if(!file) return;
  const text = await readFileAsText(file);

  let json;
  try{
    json = JSON.parse(text);
  } catch(e){
    showToast("JSON parse error", String(e));
    return;
  }

  const parsed = parseAnyGoogleTimeline(json);
  state.items = parsed.items.filter(it=>it.start && !isNaN(it.start.getTime()));
  state.detectedFormat = parsed.detectedFormat;

  // for raw locations, reduce memory by keeping only daily-usable points when rendering
  // (renderList ignores rawpoint count; map renders rawpoints with tiny markers)
  state.items.sort((a,b)=>a.start.getTime()-b.start.getTime());

  rebuildDays();
  updateFormatPill();

  if(!state.items.length){
    showToast("No supported data found", "timelineObjects / semanticSegments / locations[] を探しました");
    renderAll();
    return;
  }

  showToast("Loaded", `${state.items.length} items, ${state.sortedDays.length} days`);
  renderAll();
}

function updateFormatPill(){
  const map = {
    timelineObjects: "Format: timelineObjects",
    semanticSegments: "Format: semanticSegments",
    recordsLocations: "Format: Records.json (locations[])",
    unknown: "Format: unknown",
  };
  $("formatPill").textContent = map[state.detectedFormat] || "Format: unknown";
}

// Keyboard shortcuts
function setupShortcuts(){
  window.addEventListener("keydown", (e)=>{
    if(e.altKey && e.key==="ArrowLeft"){
      e.preventDefault(); goPrev();
    }
    if(e.altKey && e.key==="ArrowRight"){
      e.preventDefault(); goNext();
    }
  });
}

// PWA SW registration (relative path to avoid GitHub Pages subpath issues)
async function setupPWA(){
  if(!("serviceWorker" in navigator)) return;
  try{
    await navigator.serviceWorker.register("./sw.js", { scope: "./" });
  } catch (e){
    // non-fatal
    console.warn("SW registration failed:", e);
  }
}

function setupUI(){
  const fileInput = /** @type {HTMLInputElement} */ ($("fileInput"));
  fileInput.addEventListener("change", async ()=>{
    const file = fileInput.files && fileInput.files[0];
    if(file) await onFileSelected(file);
  });

  $("prevBtn").addEventListener("click", goPrev);
  $("nextBtn").addEventListener("click", goNext);
}

// Boot
setupUI();
setupShortcuts();
setupPWA();
ensureMap();
renderAll();
