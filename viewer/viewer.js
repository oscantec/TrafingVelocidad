/**
 * TrafingVelocidad — Viewer Module
 * Track visualization, Haversine-based node matching, and automatic segmentation
 */

import { openDB, getAllTracks, getTrackPoints } from '../lib/db.js';
import {
  haversineDistance, totalDistance, elapsedTime, averageSpeed,
  matchNodesToTrack, segmentTrack, segmentMetrics,
  formatDistance, formatDuration, formatSpeed, generateSegmentColors,
  findNodeCrossings, directionLabel,
} from '../lib/geo.js';
import { parseGPX, parseKML, parseGeoJSON, parseTrackContent, parseNodesFile, readFileAsText } from '../lib/gpx.js';
import { listCloudTracks, getCloudTrackPoints, testConnection,
         listTramos, listCorridors, listControlPointsByTramo,
         listSubtramosByTramo,
         saveTramoComplete, deleteTramo } from '../lib/supabase.js';
import { initPlayback, loadPlaybackTrack } from './playback.js';

// ── State ────────────────────────────────────────────────────
let trackPoints = [];       // Current track points
let referenceNodes = [];    // Loaded reference nodes
let segmentResults = [];    // Computed segments with metrics
let matchResults = [];      // Node-to-track matching results
let recorridos = [];        // [{ id, name, points, startTs, sourceUrl }] sorted ascending by startTs
let activeRecorridoId = null;

// Global list of subtramos — shared across all recorridos. Each entry:
//   { id, active, startNodeId, endNodeId, sentido }
// startNodeId / endNodeId are reference-node IDs, or the sentinel strings
// '__start__' (first point of the recorrido) and '__end__' (last point).
let subtramos = [];

// Leaflet layers
let map = null;
let baseTrackLayer = null;
let baseTrackDecorator = null;
let segmentLayers = [];
let nodeMarkers = [];
let cutPointMarkers = [];

// ── DOM ──────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const el = {
  trackFileInput: $('trackFileInput'),
  trackUrlInput: $('trackUrlInput'),
  btnLoadUrl: $('btnLoadUrl'),
  savedTramoSelect:  $('savedTramoSelect'),
  btnRefreshTramos:  $('btnRefreshTramos'),
  btnDrawPoints:     $('btnDrawPoints'),
  btnSaveTramo:      $('btnSaveTramo'),
  btnClearNodes:     $('btnClearNodes'),
  drawingHint:       $('drawingHint'),
  cpSetupModal:      $('cpSetupModal'),
  cpSetupSql:        $('cpSetupSql'),
  cpSetupCopy:       $('cpSetupCopy'),
  cpSetupClose:      $('cpSetupClose'),
  cpSetupRetry:      $('cpSetupRetry'),
  saveTramoModal:    $('saveTramoModal'),
  stCorridor:        $('stCorridor'),
  stCorridorNew:     $('stCorridorNew'),
  stTramoName:       $('stTramoName'),
  stCount:           $('stCount'),
  stSave:            $('stSave'),
  stCancel:          $('stCancel'),
  thresholdInput: $('thresholdInput'),
  btnProcess: $('btnProcess'),
  processBadge: $('processBadge'),
  nodesInfo: $('nodesInfo'),
  nodesCount: $('nodesCount'),
  nodesList: $('nodesList'),
  // Subtramos editor (shared list)
  noSubtramos:     $('noSubtramos'),
  subtramosTable:  $('subtramosTable'),
  subtramosBody:   $('subtramosBody'),
  btnAddSubtramo:   $('btnAddSubtramo'),
  btnAutoSubtramos: $('btnAutoSubtramos'),
  btnClearSubtramos: $('btnClearSubtramos'),
  // Preview (tab 4)
  previewEmpty: $('previewEmpty'),
  previewWrap:  $('previewWrap'),
  previewHead:  $('previewHead'),
  previewBody:  $('previewBody'),
  previewMeta:  $('previewMeta'),
  btnRefreshPreview: $('btnRefreshPreview'),
  mapLegend: $('mapLegend'),
  toastContainer: $('toastContainer'),
  tabData: $('tabData'),
  tabSegments: $('tabSegments'),
  // Study metadata
  smCorredor: $('smCorredor'),
  smTipo:     $('smTipo'),
  smCalzada:  $('smCalzada'),
  smPeriodo:  $('smPeriodo'),
  btnExportExcel: $('btnExportExcel'),
  // Recorridos list
  recorridosBox:   $('recorridosBox'),
  recorridosCount: $('recorridosCount'),
  recorridosList:  $('recorridosList'),
  btnClearRecorridos: $('btnClearRecorridos'),
};

// ── Initialize ───────────────────────────────────────────────
async function init() {
  try {
    await openDB();
  } catch (err) {
    console.warn('[Viewer] DB not available, file import only');
  }

  initMap();
  bindEvents();
  initPlayback(map);
  refreshTramos();
  renderSubtramosTable();
}

// ── Map Setup ────────────────────────────────────────────────
function initMap() {
  map = L.map('viewerMap', {
    center: [4.6097, -74.0817],
    zoom: 13,
    zoomControl: true,
  });

  // Light tile layer (matches Softrafing theme)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(map);

  setTimeout(() => map.invalidateSize(), 100);
}

// ── Event Binding ────────────────────────────────────────────
function bindEvents() {
  // Track from file
  if (el.trackFileInput) el.trackFileInput.addEventListener('change', handleTrackFileImport);

  // Track from URL
  if (el.btnLoadUrl)     el.btnLoadUrl.addEventListener('click', handleTrackUrlImport);
  if (el.trackUrlInput)  el.trackUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleTrackUrlImport();
  });

  // Recorridos list — clear all
  if (el.btnClearRecorridos) el.btnClearRecorridos.addEventListener('click', clearRecorridos);

  // Nodes from file
  // Tramificación
  el.btnDrawPoints.addEventListener('click', toggleDrawingMode);
  el.btnRefreshTramos.addEventListener('click', refreshTramos);
  el.savedTramoSelect.addEventListener('change', handleTramoSelect);
  el.btnSaveTramo.addEventListener('click', openSaveTramoModal);
  el.btnClearNodes.addEventListener('click', clearReferenceNodes);
  map.on('click', handleMapClickForDrawing);

  // Setup modal (tables missing)
  el.cpSetupSql.textContent = TRAMIFICATION_SETUP_SQL;
  el.cpSetupCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(TRAMIFICATION_SETUP_SQL);
      el.cpSetupCopy.textContent = 'Copiado';
      setTimeout(() => { el.cpSetupCopy.textContent = 'Copiar SQL'; }, 1600);
    } catch {}
  });
  el.cpSetupClose.addEventListener('click', () => el.cpSetupModal.classList.remove('active'));
  el.cpSetupRetry.addEventListener('click', async () => {
    el.cpSetupModal.classList.remove('active');
    await refreshTramos();
  });

  // Save tramo modal
  el.stSave.addEventListener('click', handleSaveTramoSubmit);
  el.stCancel.addEventListener('click', () => el.saveTramoModal.classList.remove('active'));
  el.stCorridor.addEventListener('change', () => {
    const showNew = el.stCorridor.value === '__new__';
    el.stCorridorNew.style.display = showNew ? 'block' : 'none';
    if (showNew) el.stCorridorNew.focus();
  });
  el.saveTramoModal.addEventListener('click', (e) => {
    if (e.target === el.saveTramoModal) el.saveTramoModal.classList.remove('active');
  });

  // Process (segmentación visual del recorrido activo)
  el.btnProcess.addEventListener('click', processSegmentation);

  // Subtramos editor
  if (el.btnAddSubtramo)    el.btnAddSubtramo.addEventListener('click', () => { addSubtramo(); renderSubtramosTable(); });
  if (el.btnAutoSubtramos)  el.btnAutoSubtramos.addEventListener('click', autoDetectSubtramos);
  if (el.btnClearSubtramos) el.btnClearSubtramos.addEventListener('click', clearSubtramos);
  if (el.btnExportExcel)    el.btnExportExcel.addEventListener('click', exportExcel);
  if (el.btnRefreshPreview) el.btnRefreshPreview.addEventListener('click', renderPreviewTable);

  // Tabs
  document.querySelectorAll('.panel-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
}

// ── Track Loading (local IndexedDB + Supabase cloud) ────────
async function loadTrackList() {
  if (!el.trackSelect) return; // dropdown removed from UI
  const fmtDate = (ts) => new Date(ts).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' });

  let localTracks = [];
  try { localTracks = await getAllTracks(); } catch {}

  // Fetch cloud tracks in parallel; tolerate failure (RLS / offline)
  let cloudTracks = [];
  try { cloudTracks = await listCloudTracks(); } catch {}

  const localIds = new Set(localTracks.map((t) => t.id));

  el.trackSelect.innerHTML = '<option value="">— Seleccionar recorrido —</option>';

  if (localTracks.length) {
    const grpLocal = document.createElement('optgroup');
    grpLocal.label = 'Local';
    for (const t of localTracks) {
      const opt = document.createElement('option');
      opt.value = `local:${t.id}`;
      const cloudMark = t.synced ? ' (nube)' : '';
      opt.textContent = `${t.name}${cloudMark} · ${fmtDate(t.startTime)} · ${t.pointCount || '?'} pts`;
      grpLocal.appendChild(opt);
    }
    el.trackSelect.appendChild(grpLocal);
  }

  // Cloud-only tracks (captured on another device / browser)
  const cloudOnly = cloudTracks.filter((t) => !t.local_id || !localIds.has(t.local_id));
  if (cloudOnly.length) {
    const grpCloud = document.createElement('optgroup');
    grpCloud.label = 'Nube (otros dispositivos)';
    for (const t of cloudOnly) {
      const opt = document.createElement('option');
      opt.value = `cloud:${t.id}`;
      opt.textContent = `${t.name} · ${fmtDate(t.start_time)} · ${t.point_count || '?'} pts`;
      grpCloud.appendChild(opt);
    }
    el.trackSelect.appendChild(grpCloud);
  }

  if (!localTracks.length && !cloudOnly.length) {
    el.trackSelect.innerHTML += '<option disabled>Sin recorridos — captura uno primero</option>';
  }
}

async function handleTrackSelect() {
  if (!el.trackSelect) return;
  const raw = el.trackSelect.value;
  if (!raw) return;

  const [origin, id] = raw.split(':');
  const label = el.trackSelect.options[el.trackSelect.selectedIndex]?.textContent || id;
  try {
    let points;
    if (origin === 'cloud') {
      const cloud = await getCloudTrackPoints(id);
      points = cloud.map((p) => ({
        lat: p.lat,
        lng: p.lng,
        speed: p.speed ?? 0,
        accuracy: p.accuracy ?? null,
        altitude: p.altitude ?? null,
        timestamp: new Date(p.timestamp).getTime(),
      }));
      showToast(`Track cargado desde la nube: ${points.length} puntos`, 'success');
    } else {
      points = await getTrackPoints(id);
      showToast(`Track cargado: ${points.length} puntos`, 'success');
    }
    addRecorrido({ name: label, points });
    el.trackSelect.value = '';
  } catch (err) {
    console.error('[viewer] track select error:', err);
    showToast(`Error cargando track: ${err.message || err}`, 'error');
  }
}

async function handleTrackFileImport(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;

  let ok = 0, fail = 0;
  for (const file of files) {
    try {
      const text = await readFileAsText(file);
      const { name, points } = parseTrackContent(text, file.name);
      addRecorrido({ name: name || file.name, points });
      ok++;
    } catch (err) {
      console.error('[Viewer] Import error:', file.name, err);
      fail++;
    }
  }
  // Reset so the same files can be re-selected later
  event.target.value = '';
  if (ok) showToast(`Cargado(s) ${ok} recorrido(s)${fail ? ` · ${fail} con error` : ''}`, fail ? 'warning' : 'success');
  else    showToast('No se pudo importar ningún archivo', 'error');
}

async function handleTrackUrlImport() {
  const url = (el.trackUrlInput.value || '').trim();
  if (!url) { showToast('Ingresa una URL', 'warning'); return; }

  try {
    el.btnLoadUrl.disabled = true;
    el.btnLoadUrl.textContent = '…';
    const text = await fetchUrlWithFallback(url);
    const { name, points } = parseTrackContent(text, url);
    addRecorrido({ name: name || url, points, sourceUrl: url });
    el.trackUrlInput.value = '';
    showToast(`URL importada (${name}): ${points.length} puntos`, 'success');
  } catch (err) {
    console.error('[Viewer] URL import error:', err);
    showToast(`Error: ${String(err.message || err)}`, 'error', 6000);
  } finally {
    el.btnLoadUrl.disabled = false;
    el.btnLoadUrl.textContent = '↓';
  }
}

// Fetch a URL directly; if the browser blocks it (CORS / network),
// retry through the /api/fetch serverless proxy which runs server-side.
async function fetchUrlWithFallback(url) {
  try {
    const resp = await fetch(url, { mode: 'cors' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } catch (err) {
    const msg = String(err.message || err);
    const likelyCors = msg.includes('Failed to fetch')
      || msg.includes('CORS')
      || msg.includes('NetworkError');
    if (!likelyCors) throw err;
    const proxied = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`);
    if (!proxied.ok) {
      let detail = '';
      try { detail = (await proxied.json())?.error || ''; } catch {}
      throw new Error(`Proxy HTTP ${proxied.status}${detail ? ` — ${detail}` : ''}`);
    }
    return await proxied.text();
  }
}

function handleTrackPasteImport() {
  if (!el.trackPasteInput) return;
  const text = (el.trackPasteInput.value || '').trim();
  if (!text) { showToast('Pega el contenido antes de cargar', 'warning'); return; }

  try {
    const { name, points } = parseTrackContent(text);
    addRecorrido({ name: name || 'Contenido pegado', points });
    el.trackPasteInput.value = '';
    showToast(`Contenido cargado (${name}): ${points.length} puntos`, 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error', 6000);
  }
}

// ── Recorridos list ──────────────────────────────────────────
function addRecorrido({ name, points, sourceUrl = '' }) {
  if (!points || !points.length) return;
  const startTs = points[0]?.timestamp || Date.now();

  // Deduplicate: same source URL, OR same start timestamp and point count
  // (a re-dragged file gets the same values).
  const dup = recorridos.find((r) =>
    (sourceUrl && r.sourceUrl && r.sourceUrl === sourceUrl) ||
    (r.startTs === startTs && r.points.length === points.length)
  );
  if (dup) {
    activeRecorridoId = dup.id;
    renderRecorridosList();
    loadTrackData(dup.points);
    showToast('Ese recorrido ya estaba cargado; no se duplicó.', 'warning');
    return;
  }

  const rec = {
    id: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    points,
    startTs,
    sourceUrl,
  };
  recorridos.push(rec);
  recorridos.sort((a, b) => a.startTs - b.startTs);
  activeRecorridoId = rec.id;
  renderRecorridosList();
  loadTrackData(points);
  autoDetectIfEmpty();
}

function renderRecorridosList() {
  if (!recorridos.length) {
    el.recorridosBox.classList.add('hidden');
    el.recorridosCount.textContent = '0';
    el.recorridosList.innerHTML = '';
    return;
  }
  el.recorridosBox.classList.remove('hidden');
  el.recorridosCount.textContent = String(recorridos.length);

  const fmt = (ts) => new Date(ts).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' });

  el.recorridosList.innerHTML = recorridos.map((r, i) => {
    const isActive = r.id === activeRecorridoId;
    const activeCls = isActive ? ' active' : '';
    const viewLabel = isActive ? 'Activo' : 'Visualizar';
    const viewDisabled = isActive ? ' disabled' : '';
    return `
      <div class="rec-item${activeCls}" data-id="${r.id}">
        <div class="rec-main">
          <span class="rec-title">Recorrido ${i + 1} · ${escapeHtml(r.name)}</span>
          <span class="rec-meta">${fmt(r.startTs)} · ${r.points.length} pts</span>
        </div>
        <div class="rec-actions">
          <button class="btn btn-sm btn-primary" data-view${viewDisabled}>${viewLabel}</button>
          <button class="btn btn-sm btn-secondary" data-remove>Quitar</button>
        </div>
      </div>`;
  }).join('');

  el.recorridosList.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const row = ev.currentTarget.closest('[data-id]');
      if (row) activateRecorrido(row.dataset.id);
    });
  });
  el.recorridosList.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const row = ev.currentTarget.closest('[data-id]');
      if (row) removeRecorrido(row.dataset.id);
    });
  });
}

function activateRecorrido(id) {
  const rec = recorridos.find((r) => r.id === id);
  if (!rec) return;
  activeRecorridoId = id;
  renderRecorridosList();
  loadTrackData(rec.points);
  autoDetectIfEmpty();
}

function removeRecorrido(id) {
  const idx = recorridos.findIndex((r) => r.id === id);
  if (idx === -1) return;
  recorridos.splice(idx, 1);
  if (activeRecorridoId === id) {
    activeRecorridoId = recorridos[0]?.id || null;
    if (recorridos[0]) loadTrackData(recorridos[0].points);
    else {
      trackPoints = [];
      clearSegments();
      if (baseTrackLayer) { map.removeLayer(baseTrackLayer); baseTrackLayer = null; }
      if (baseTrackDecorator) { map.removeLayer(baseTrackDecorator); baseTrackDecorator = null; }
      updateProcessButton();
    }
  }
  renderRecorridosList();
}

function clearRecorridos() {
  if (!recorridos.length) return;
  if (!confirm(`¿Vaciar los ${recorridos.length} recorrido(s)?`)) return;
  recorridos = [];
  activeRecorridoId = null;
  renderRecorridosList();
  trackPoints = [];
  clearSegments();
  if (baseTrackLayer) { map.removeLayer(baseTrackLayer); baseTrackLayer = null; }
  if (baseTrackDecorator) { map.removeLayer(baseTrackDecorator); baseTrackDecorator = null; }
  updateProcessButton();
}

function loadTrackData(points) {
  trackPoints = points;
  clearSegments();

  // Draw track on map
  drawBaseTrack(points);

  // Wire up the playback panel (gauges, chart, transport controls)
  loadPlaybackTrack(points);

  // Enable process button if nodes also loaded
  updateProcessButton();
}

// ── Tramificación: Corredor → Tramo → Puntos ─────────────────
let drawingMode = false;
let tramosCache = [];      // [{id, name, corridor_id, corridors:{id, name}}]
let corridorsCache = [];   // [{id, name}]

const TRAMIFICATION_SETUP_SQL = `create table if not exists public.corridors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz default now()
);

create table if not exists public.tramos (
  id          uuid primary key default gen_random_uuid(),
  corridor_id uuid not null references public.corridors(id) on delete cascade,
  name        text not null,
  created_at  timestamptz default now(),
  unique (corridor_id, name)
);

create table if not exists public.control_points (
  id         uuid primary key default gen_random_uuid(),
  tramo_id   uuid not null references public.tramos(id) on delete cascade,
  name       text not null,
  lat        double precision not null,
  lng        double precision not null,
  seq        integer default 0,
  created_at timestamptz default now()
);

create table if not exists public.subtramos (
  id         uuid primary key default gen_random_uuid(),
  tramo_id   uuid not null references public.tramos(id) on delete cascade,
  seq        integer not null default 0,
  active     boolean not null default true,
  -- start_ref / end_ref are either the string '__start__', '__end__'
  -- or the uuid of a row in control_points. Kept as text for simplicity.
  start_ref  text not null,
  end_ref    text not null,
  sentido    text,
  created_at timestamptz default now()
);

alter table public.corridors      enable row level security;
alter table public.tramos         enable row level security;
alter table public.control_points enable row level security;
alter table public.subtramos      enable row level security;

drop policy if exists "anon all corridors"      on public.corridors;
drop policy if exists "anon all tramos"         on public.tramos;
drop policy if exists "anon all control_points" on public.control_points;
drop policy if exists "anon all subtramos"      on public.subtramos;

create policy "anon all corridors"      on public.corridors      for all using (true) with check (true);
create policy "anon all tramos"         on public.tramos         for all using (true) with check (true);
create policy "anon all control_points" on public.control_points for all using (true) with check (true);
create policy "anon all subtramos"      on public.subtramos      for all using (true) with check (true);`;

async function refreshTramos() {
  const [tRes, cRes] = await Promise.all([listTramos(), listCorridors()]);
  if (!tRes.ok) {
    if (tRes.missing) { el.cpSetupModal.classList.add('active'); return; }
    showToast(`Error leyendo tramos: ${tRes.error}`, 'error');
    return;
  }
  tramosCache = tRes.tramos;
  corridorsCache = cRes.ok ? cRes.corridors : [];
  renderTramoDropdown();
}

function renderTramoDropdown() {
  const sel = el.savedTramoSelect;
  sel.innerHTML = '<option value="">— Seleccionar —</option>';
  if (tramosCache.length === 0) {
    sel.innerHTML += '<option disabled>(sin tramos guardados)</option>';
    return;
  }
  // Group tramos by corridor name
  const byCorridor = new Map();
  for (const t of tramosCache) {
    const cname = t.corridors?.name || 'Sin corredor';
    if (!byCorridor.has(cname)) byCorridor.set(cname, []);
    byCorridor.get(cname).push(t);
  }
  for (const [cname, list] of [...byCorridor.entries()].sort()) {
    const group = document.createElement('optgroup');
    group.label = cname;
    for (const t of list) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      group.appendChild(opt);
    }
    sel.appendChild(group);
  }
}

async function handleTramoSelect() {
  const tramoId = el.savedTramoSelect.value;
  if (!tramoId) return;
  const res = await listControlPointsByTramo(tramoId);
  if (!res.ok) {
    showToast(`Error: ${res.error}`, 'error');
    return;
  }
  const nodes = (res.points || []).map((p) => ({
    id: p.id, name: p.name, lat: +p.lat, lng: +p.lng, cloud: true, tramoId,
  }));
  referenceNodes = nodes;
  displayNodes(nodes);
  drawNodeMarkers(nodes);
  updateProcessButton();

  // Also try to restore the subtramos previously saved for this tramo.
  const stRes = await listSubtramosByTramo(tramoId);
  if (stRes.ok && stRes.subtramos.length) {
    subtramos = stRes.subtramos.map((row) => ({
      id:          row.id,
      active:      row.active !== false,
      startNodeId: row.start_ref,
      endNodeId:   row.end_ref,
      sentido:     row.sentido || '',
    }));
    renderSubtramosTable();
  }

  const tramo = tramosCache.find((t) => t.id === tramoId);
  const label = tramo ? `${tramo.corridors?.name || ''} / ${tramo.name}` : 'tramo';
  const extra = stRes.ok && stRes.subtramos.length ? ` y ${stRes.subtramos.length} subtramo(s)` : '';
  showToast(`Cargados ${nodes.length} punto(s)${extra} de "${label}"`, 'success');
  el.savedTramoSelect.value = '';
}

function toggleDrawingMode() {
  drawingMode = !drawingMode;
  el.btnDrawPoints.classList.toggle('btn-success', drawingMode);
  el.btnDrawPoints.classList.toggle('btn-primary', !drawingMode);
  el.btnDrawPoints.textContent = drawingMode ? 'Dibujo activo — clic para terminar' : 'Dibujar en mapa';
  el.drawingHint.classList.toggle('hidden', !drawingMode);
  const container = map.getContainer();
  container.style.cursor = drawingMode ? 'crosshair' : '';
}

function handleMapClickForDrawing(e) {
  if (!drawingMode) return;
  const defaultName = `Punto ${referenceNodes.length + 1}`;
  openNodeNamePopup(e.latlng, defaultName);
}

function openNodeNamePopup(latlng, defaultName) {
  const html = `
    <div style="min-width:200px;">
      <div style="font-size:11px;color:#475569;margin-bottom:4px;font-weight:600;">
        ${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}
      </div>
      <input id="np-name" type="text" value="${defaultName}" autocomplete="off"
             style="width:100%;padding:6px 8px;border:1px solid #E4E8EE;border-radius:6px;font-size:13px;margin-bottom:6px;box-sizing:border-box;">
      <div style="display:flex;gap:6px;">
        <button id="np-save" style="flex:1;padding:6px 10px;background:#F05A1A;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;">Añadir</button>
        <button id="np-cancel" style="padding:6px 10px;background:#F8FAFC;color:#475569;border:1px solid #E4E8EE;border-radius:6px;cursor:pointer;">Cancelar</button>
      </div>
    </div>`;

  const popup = L.popup({ closeButton: false, autoClose: true, closeOnClick: false })
    .setLatLng(latlng).setContent(html).openOn(map);

  setTimeout(() => {
    const input = document.getElementById('np-name');
    const save  = document.getElementById('np-save');
    const cancel = document.getElementById('np-cancel');
    if (input) { input.focus(); input.select(); }

    const commit = () => {
      const name = (input.value || '').trim() || defaultName;
      map.closePopup(popup);
      referenceNodes.push({
        id: 'local-' + Date.now(),
        name, lat: latlng.lat, lng: latlng.lng, cloud: false,
      });
      displayNodes(referenceNodes);
      drawNodeMarkers(referenceNodes);
      updateProcessButton();
    };
    if (save)   save.onclick = commit;
    if (cancel) cancel.onclick = () => map.closePopup(popup);
    if (input)  input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter')  commit();
      if (ev.key === 'Escape') map.closePopup(popup);
    });
  }, 30);
}

function displayNodes(nodes) {
  // Reference nodes changed — subtramos dropdowns need to refresh too,
  // and the list is auto-populated when both recorrido and nodes exist.
  renderSubtramosTable();
  autoDetectIfEmpty();
  if (nodes.length === 0) { el.nodesInfo.classList.add('hidden'); return; }
  el.nodesInfo.classList.remove('hidden');
  el.nodesCount.textContent = nodes.length;

  el.nodesList.innerHTML = nodes.map((n, i) => {
    const mark = n.cloud
      ? '<span class="badge badge-success" style="padding:1px 6px;font-size:9px;text-transform:none;letter-spacing:0;">nube</span>'
      : '<span class="badge" style="background:var(--surface-alt);color:var(--text-muted);padding:1px 6px;font-size:9px;text-transform:none;letter-spacing:0;">local</span>';
    return `
      <div class="node-item" data-id="${n.id}">
        <div style="flex:1;min-width:0;">
          <span class="node-name">${i + 1}. ${escapeHtml(n.name)} ${mark}</span>
          <span class="node-coords">${Number(n.lat).toFixed(6)}, ${Number(n.lng).toFixed(6)}</span>
        </div>
        <button class="btn btn-sm btn-danger" data-remove title="Quitar">Quitar</button>
      </div>`;
  }).join('');

  el.nodesList.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const row = ev.currentTarget.closest('[data-id]');
      if (row) removeNodeLocal(row.dataset.id);
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function removeNodeLocal(id) {
  const idx = referenceNodes.findIndex((n) => n.id === id);
  if (idx === -1) return;
  referenceNodes.splice(idx, 1);
  displayNodes(referenceNodes);
  drawNodeMarkers(referenceNodes);
  updateProcessButton();
}

function clearReferenceNodes() {
  if (referenceNodes.length === 0) return;
  if (!confirm(`¿Vaciar los ${referenceNodes.length} puntos actuales? Esto no borra lo guardado en nube.`)) return;
  referenceNodes = [];
  displayNodes(referenceNodes);
  drawNodeMarkers(referenceNodes);
  updateProcessButton();
}

// ── Save Tramo modal ─────────────────────────────────────────
function openSaveTramoModal() {
  if (referenceNodes.length === 0) {
    showToast('Agrega al menos un punto antes de guardar', 'warning');
    return;
  }
  // Populate corridors dropdown
  el.stCorridor.innerHTML = '';
  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = '✚ Nuevo corredor…';
  el.stCorridor.appendChild(newOpt);

  if (corridorsCache.length) {
    const sep = document.createElement('option');
    sep.disabled = true; sep.textContent = '──────────';
    el.stCorridor.appendChild(sep);
    for (const c of corridorsCache) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      el.stCorridor.appendChild(opt);
    }
    el.stCorridor.value = corridorsCache[0].id;
    el.stCorridorNew.style.display = 'none';
  } else {
    el.stCorridor.value = '__new__';
    el.stCorridorNew.style.display = 'block';
  }

  el.stCorridorNew.value = '';
  el.stTramoName.value = '';
  el.stCount.textContent = referenceNodes.length;
  el.saveTramoModal.classList.add('active');
  setTimeout(() => {
    if (el.stCorridor.value === '__new__') el.stCorridorNew.focus();
    else el.stTramoName.focus();
  }, 50);
}

async function handleSaveTramoSubmit() {
  const isNewCorridor = el.stCorridor.value === '__new__';
  const corridorId = isNewCorridor ? null : el.stCorridor.value;
  const corridorName = isNewCorridor ? el.stCorridorNew.value.trim() : null;
  const tramoName = el.stTramoName.value.trim();

  if (isNewCorridor && !corridorName) {
    showToast('Ingresa el nombre del corredor', 'warning');
    el.stCorridorNew.focus();
    return;
  }
  if (!tramoName) {
    showToast('Ingresa el nombre del tramo', 'warning');
    el.stTramoName.focus();
    return;
  }

  el.stSave.disabled = true;
  el.stSave.textContent = 'Guardando…';

  const res = await saveTramoComplete({
    corridorId,
    corridorName,
    tramoName,
    // Include local id so the backend can map subtramos' startNodeId/endNodeId
    // (which point to these local ids) to the freshly-inserted cloud uuids.
    points: referenceNodes.map((n) => ({ id: n.id, name: n.name, lat: +n.lat, lng: +n.lng })),
    subtramos,
  });

  el.stSave.disabled = false;
  el.stSave.textContent = 'Guardar';

  if (res.success) {
    el.saveTramoModal.classList.remove('active');
    showToast(`Tramo "${tramoName}" guardado (${referenceNodes.length} puntos)`, 'success');
    // Mark local nodes as cloud-backed now
    referenceNodes = referenceNodes.map((n) => ({ ...n, cloud: true, tramoId: res.tramoId }));
    displayNodes(referenceNodes);
    await refreshTramos();
  } else if (res.missing) {
    el.saveTramoModal.classList.remove('active');
    el.cpSetupModal.classList.add('active');
  } else {
    showToast(`Error: ${res.error}`, 'error', 6000);
  }
}

// ── Map Drawing ──────────────────────────────────────────────
function drawBaseTrack(points) {
  // Clear previous
  if (baseTrackLayer)     map.removeLayer(baseTrackLayer);
  if (baseTrackDecorator) map.removeLayer(baseTrackDecorator);

  const latlngs = points.map((p) => [p.lat, p.lng]);
  baseTrackLayer = L.polyline(latlngs, {
    color: '#64748B',
    weight: 3.5,
    opacity: 0.75,
  }).addTo(map);

  // Flow-direction arrows every ~8% of the path
  if (window.L && L.polylineDecorator) {
    baseTrackDecorator = L.polylineDecorator(baseTrackLayer, {
      patterns: [{
        offset: '4%',
        repeat: '8%',
        symbol: L.Symbol.arrowHead({
          pixelSize: 11,
          polygon: false,
          pathOptions: { stroke: true, color: '#F05A1A', weight: 2.2, opacity: 0.95 },
        }),
      }],
    }).addTo(map);
  }

  // Fit bounds
  if (latlngs.length > 0) {
    map.fitBounds(baseTrackLayer.getBounds(), { padding: [40, 40] });
  }

  // Start/End markers
  if (latlngs.length >= 2) {
    const startIcon = L.divIcon({
      className: '',
      html: `<div style="width:12px;height:12px;background:#00C853;border:2px solid #fff;border-radius:50%;box-shadow:0 0 8px rgba(0,200,83,0.5);"></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });

    const endIcon = L.divIcon({
      className: '',
      html: `<div style="width:12px;height:12px;background:#FF3D00;border:2px solid #fff;border-radius:50%;box-shadow:0 0 8px rgba(255,61,0,0.5);"></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });

    L.marker(latlngs[0], { icon: startIcon })
      .bindPopup('<strong>Inicio</strong>')
      .addTo(map);

    L.marker(latlngs[latlngs.length - 1], { icon: endIcon })
      .bindPopup('<strong>Fin</strong>')
      .addTo(map);
  }
}

function drawNodeMarkers(nodes) {
  // Clear previous node markers
  nodeMarkers.forEach((m) => map.removeLayer(m));
  nodeMarkers = [];

  nodes.forEach((node) => {
    const icon = L.divIcon({
      className: '',
      html: `<div style="
        width:20px;height:20px;
        background:var(--accent, #FF6B00);
        border:2px solid #fff;
        border-radius:4px;
        display:flex;align-items:center;justify-content:center;
        font-size:10px;font-weight:700;color:#000;
        box-shadow:0 2px 8px rgba(255,107,0,0.4);
      ">${node.id}</div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });

    const marker = L.marker([node.lat, node.lng], { icon })
      .bindPopup(`
        <strong>${node.name}</strong><br>
        ID: ${node.id}<br>
        ${node.lat.toFixed(6)}, ${node.lng.toFixed(6)}
      `)
      .addTo(map);

    nodeMarkers.push(marker);
  });
}

// ── Segmentation Processing ──────────────────────────────────
// Pure helper: given a track's points, apply current reference nodes and
// return the computed segment-result array. Used by both the UI ("Segmentar
// track" button) and the Excel exporter (which processes every recorrido).
function runSegmentationOn(points, threshold) {
  const mr = matchNodesToTrack(referenceNodes, points, threshold);
  const validMatches = mr.filter((m) => m.withinThreshold);
  if (validMatches.length === 0) return { results: [], matches: mr };

  const cutIndices = validMatches.map((m) => m.trackIndex);
  const segments = segmentTrack(points, cutIndices);

  const results = segments.map((seg, i) => {
    const metrics = segmentMetrics(seg.points);
    const startNode = findNodeAtIndex(validMatches, seg.startIndex);
    const endNode = findNodeAtIndex(validMatches, seg.endIndex);
    const first = seg.points[0];
    const last  = seg.points[seg.points.length - 1];
    return {
      index: i + 1,
      startIndex: seg.startIndex,
      endIndex: seg.endIndex,
      startNode: startNode ? startNode.node.name : 'Inicio',
      endNode: endNode ? endNode.node.name : (i === segments.length - 1 ? 'Fin' : '→'),
      points: seg.points,
      firstPointTime: first ? first.timestamp : null,
      lastPointTime:  last  ? last.timestamp  : null,
      ...metrics,
    };
  });
  return { results, matches: mr };
}

function processSegmentation() {
  if (trackPoints.length === 0 || referenceNodes.length === 0) {
    showToast('Carga un track y nodos primero', 'warning');
    return;
  }

  const threshold = parseFloat(el.thresholdInput.value) || 50;

  showBadge('Procesando...', 'warning');

  // Use requestAnimationFrame to let the UI update before heavy computation
  requestAnimationFrame(() => {
    try {
      const { results, matches } = runSegmentationOn(trackPoints, threshold);
      matchResults = matches;
      updateNodesWithDistances(matches);

      if (results.length === 0) {
        showToast(`Ningún nodo dentro del umbral de ${threshold}m. Aumenta el umbral.`, 'warning');
        showBadge(`0 nodos válidos`, 'danger');
        return;
      }
      segmentResults = results;

      // Step 5: Render
      renderSegmentsOnMap(segmentResults);
      renderSegmentsTable(segmentResults);
      renderLegend(segmentResults);

      // Show summary
      showSegmentsSummary(segmentResults);

      // Switch to segments tab
      switchTab('tab-segments');

      showBadge(`${segmentResults.length} tramos`, 'success');
      showToast(`Segmentación completa: ${segmentResults.length} tramos generados`, 'success');
    } catch (err) {
      console.error('[Viewer] Segmentation error:', err);
      showToast(`Error en segmentación: ${err.message}`, 'error');
      showBadge('Error', 'danger');
    }
  });
}

function findNodeAtIndex(matches, trackIndex) {
  return matches.find((m) => m.trackIndex === trackIndex) || null;
}

function updateNodesWithDistances(matches) {
  const threshold = parseFloat(el.thresholdInput.value) || 50;

  el.nodesList.innerHTML = matches.map((m) => {
    const distClass = m.distance <= threshold ? 'near' : 'far';
    const distLabel = m.distance < 1000 ? 
      `${Math.round(m.distance)}m` : 
      `${(m.distance / 1000).toFixed(1)}km`;

    return `
      <div class="node-item">
        <div>
          <span class="node-name">${m.node.name}</span>
          <span class="node-coords">${m.node.lat.toFixed(6)}, ${m.node.lng.toFixed(6)}</span>
        </div>
        <span class="node-dist ${distClass}">${distLabel}</span>
      </div>
    `;
  }).join('');
}

// ── Map Segment Rendering ────────────────────────────────────
function renderSegmentsOnMap(segments) {
  // Clear previous segment layers
  clearSegmentLayers();

  const colors = generateSegmentColors(segments.length);

  segments.forEach((seg, i) => {
    const color = colors[i];
    const latlngs = seg.points.map((p) => [p.lat, p.lng]);

    const polyline = L.polyline(latlngs, {
      color,
      weight: 5,
      opacity: 0.85,
    }).addTo(map);

    // Popup with metrics
    polyline.bindPopup(`
      <div style="font-family:var(--font-mono,'monospace');font-size:11px;line-height:1.6;">
        <strong>Tramo ${seg.index}</strong><br>
        ${seg.startNode} → ${seg.endNode}<br>
        ───────────<br>
        Distancia: ${formatDistance(seg.distance)}<br>
        Tiempo: ${formatDuration(seg.time)}<br>
        Vel. Media: ${formatSpeed(seg.avgSpeed)} km/h<br>
        Vel. Máx: ${formatSpeed(seg.maxSpeed)} km/h<br>
        Puntos: ${seg.pointCount}
      </div>
    `);

    segmentLayers.push(polyline);

    // Add cut point marker at start of each segment (except first)
    if (i > 0) {
      const cutPoint = seg.points[0];
      const cutIcon = L.divIcon({
        className: '',
        html: `<div style="
          width:14px;height:14px;
          background:${color};
          border:2px solid #fff;
          border-radius:50%;
          box-shadow:0 0 6px rgba(0,0,0,0.5);
        "></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });

      const marker = L.marker([cutPoint.lat, cutPoint.lng], { icon: cutIcon })
        .bindPopup(`<strong>Punto de Corte ${i}</strong><br>${seg.startNode}`)
        .addTo(map);

      cutPointMarkers.push(marker);
    }
  });
}

function clearSegmentLayers() {
  segmentLayers.forEach((l) => map.removeLayer(l));
  segmentLayers = [];
  cutPointMarkers.forEach((m) => map.removeLayer(m));
  cutPointMarkers = [];
}

// ── Segments Table ───────────────────────────────────────────
function formatClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// Visual-only: the tab's interactive table now lives in renderSubtramosTable().
// Kept as a stub so processSegmentation() (map preview) can still call it
// without a separate code path.
function renderSegmentsTable(/* segments */) { /* no-op */ }

function highlightSegment(index) {
  segmentLayers.forEach((layer, i) => {
    if (i === index) {
      layer.setStyle({ weight: 8, opacity: 1 });
      layer.bringToFront();
    } else {
      layer.setStyle({ weight: 3, opacity: 0.3 });
    }
  });
}

function unhighlightSegment() {
  segmentLayers.forEach((layer) => {
    layer.setStyle({ weight: 5, opacity: 0.85 });
  });
}

// Summary was removed from the HTML (the segments tab now hosts the
// global subtramos editor) — keep the call site harmless.
function showSegmentsSummary(/* segments */) { /* no-op */ }

// ── Legend ────────────────────────────────────────────────────
function renderLegend(segments) {
  const colors = generateSegmentColors(segments.length);

  el.mapLegend.innerHTML = `
    <div class="legend">
      <div class="legend-title">Tramos</div>
      ${segments.map((seg, i) => `
        <div class="legend-item" data-segment="${i}">
          <span class="legend-line" style="background:${colors[i]}"></span>
          <span>${seg.index}. ${seg.startNode} → ${seg.endNode}</span>
        </div>
      `).join('')}
      <div class="legend-item" style="margin-top:6px;opacity:0.5;">
        <span class="legend-line" style="background:#555;border-style:dashed;"></span>
        <span>Track base</span>
      </div>
    </div>
  `;

  // Legend item hover
  el.mapLegend.querySelectorAll('.legend-item[data-segment]').forEach((item) => {
    const idx = parseInt(item.dataset.segment);
    item.addEventListener('mouseenter', () => highlightSegment(idx));
    item.addEventListener('mouseleave', () => unhighlightSegment());
    item.addEventListener('click', () => {
      if (segmentLayers[idx]) {
        map.fitBounds(segmentLayers[idx].getBounds(), { padding: [60, 60] });
      }
    });
  });
}

// ── Tab Switching ────────────────────────────────────────────
function switchTab(tabId) {
  document.querySelectorAll('.panel-tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));

  const tab = document.querySelector(`[data-tab="${tabId}"]`);
  const content = document.getElementById(tabId);

  if (tabId === 'tab-tabla') renderPreviewTable();

  if (tab) tab.classList.add('active');
  if (content) content.classList.add('active');
}

// ── Utilities ────────────────────────────────────────────────
function clearSegments() {
  segmentResults = [];
  matchResults = [];
  clearSegmentLayers();
  el.mapLegend.innerHTML = '';
}

function updateProcessButton() {
  el.btnProcess.disabled = !(trackPoints.length > 0 && referenceNodes.length > 0);
}

function showBadge(text, type) {
  el.processBadge.classList.remove('hidden');
  el.processBadge.className = `badge badge-${type === 'success' ? 'success' : type === 'danger' ? 'danger' : 'warning'}`;
  el.processBadge.querySelector('span:last-child').textContent = text;
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  el.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'fade-in 0.3s var(--ease-out) reverse';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ── Subtramos editor (global list, shared across recorridos) ──
const START_NODE_ID = '__start__';
const END_NODE_ID   = '__end__';

function newSubtramoId() {
  return `st-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function addSubtramo(initial = {}) {
  subtramos.push({
    id:          newSubtramoId(),
    active:      true,
    startNodeId: START_NODE_ID,
    endNodeId:   END_NODE_ID,
    sentido:     '',
    ...initial,
  });
}

function clearSubtramos() {
  if (!subtramos.length) return;
  if (!confirm(`¿Vaciar los ${subtramos.length} subtramos definidos?`)) return;
  subtramos = [];
  renderSubtramosTable();
}

// Populate `subtramos` from the nodes the active recorrido actually crosses,
// in the order they appear. Useful to kick-start the list.
// Derive "S - N" / "N - S" / … from the node positions. Returns '' if
// either endpoint is the Inicio/Fin sentinel (no fixed coordinates).
function sentidoForPair(startNodeId, endNodeId) {
  if (startNodeId === START_NODE_ID || startNodeId === END_NODE_ID) return '';
  if (endNodeId === START_NODE_ID   || endNodeId === END_NODE_ID)   return '';
  const a = referenceNodes.find((n) => n.id === startNodeId);
  const b = referenceNodes.find((n) => n.id === endNodeId);
  return (a && b) ? directionLabel(a, b) : '';
}

function autoDetectSubtramos(opts = { silent: false }) {
  if (!activeRecorridoId) {
    if (!opts.silent) showToast('Selecciona un recorrido activo primero.', 'warning');
    return;
  }
  if (!referenceNodes.length) {
    if (!opts.silent) showToast('Carga los puntos de control primero.', 'warning');
    return;
  }
  const rec = recorridos.find((r) => r.id === activeRecorridoId);
  if (!rec) return;

  const threshold = parseFloat(el.thresholdInput.value) || 50;
  const events = [];
  for (const n of referenceNodes) {
    for (const c of findNodeCrossings(n, rec.points, threshold)) {
      events.push({ trackIndex: c.trackIndex, nodeId: n.id });
    }
  }
  events.sort((a, b) => a.trackIndex - b.trackIndex);

  if (!events.length) {
    if (!opts.silent) showToast('Ningún nodo dentro del umbral. Aumenta el umbral y reintenta.', 'warning');
    return;
  }

  const fresh = [];
  fresh.push({ id: newSubtramoId(), active: true, startNodeId: START_NODE_ID, endNodeId: events[0].nodeId, sentido: '' });
  for (let i = 1; i < events.length; i++) {
    const s = events[i - 1].nodeId;
    const e = events[i].nodeId;
    fresh.push({ id: newSubtramoId(), active: true, startNodeId: s, endNodeId: e, sentido: sentidoForPair(s, e) });
  }
  fresh.push({ id: newSubtramoId(), active: true, startNodeId: events[events.length - 1].nodeId, endNodeId: END_NODE_ID, sentido: '' });

  subtramos = fresh;
  renderSubtramosTable();
  if (!opts.silent) showToast(`Detectados ${fresh.length} subtramos. Ajusta/desactiva los que no necesites.`, 'success');
}

// Fill the list once the prerequisites are there and the user hasn't
// already started editing. Also called after changes so new nodes
// get picked up automatically.
function autoDetectIfEmpty() {
  if (subtramos.length) return;
  if (!activeRecorridoId || !referenceNodes.length) return;
  autoDetectSubtramos({ silent: true });
}

function nodeOptionsHtml(selectedId) {
  const opts = [
    `<option value="${START_NODE_ID}"${selectedId === START_NODE_ID ? ' selected' : ''}>Inicio</option>`,
    `<option value="${END_NODE_ID}"${selectedId === END_NODE_ID ? ' selected' : ''}>Fin</option>`,
  ];
  for (const n of referenceNodes) {
    const sel = n.id === selectedId ? ' selected' : '';
    opts.push(`<option value="${n.id}"${sel}>${escapeHtml(n.name)}</option>`);
  }
  return opts.join('');
}

function renderSubtramosTable() {
  if (!subtramos.length) {
    el.subtramosTable.classList.add('hidden');
    el.noSubtramos.classList.remove('hidden');
    el.subtramosBody.innerHTML = '';
    return;
  }
  el.noSubtramos.classList.add('hidden');
  el.subtramosTable.classList.remove('hidden');

  el.subtramosBody.innerHTML = subtramos.map((st, i) => {
    const rowStyle = st.active ? '' : 'opacity:0.45;';
    return `
    <tr data-id="${st.id}" style="${rowStyle}">
      <td style="text-align:center;"><input type="checkbox" data-active ${st.active ? 'checked' : ''}></td>
      <td>${i + 1}</td>
      <td><select data-start>${nodeOptionsHtml(st.startNodeId)}</select></td>
      <td><select data-end>${nodeOptionsHtml(st.endNodeId)}</select></td>
      <td><input type="text" data-sentido value="${escapeHtml(st.sentido || '')}" placeholder="S - N"></td>
      <td><button class="row-remove" data-remove title="Quitar">Quitar</button></td>
    </tr>`;
  }).join('');

  el.subtramosBody.querySelectorAll('tr').forEach((row) => {
    const st = subtramos.find((s) => s.id === row.dataset.id);
    if (!st) return;

    row.querySelector('[data-active]').addEventListener('change', (ev) => {
      st.active = ev.target.checked;
      row.style.opacity = st.active ? '' : '0.45';
    });
    row.querySelector('[data-start]').addEventListener('change', (ev) => { st.startNodeId = ev.target.value; });
    row.querySelector('[data-end]').addEventListener('change',   (ev) => { st.endNodeId   = ev.target.value; });
    row.querySelector('[data-sentido]').addEventListener('input', (ev) => { st.sentido    = ev.target.value; });
    row.querySelector('[data-remove]').addEventListener('click', () => {
      subtramos = subtramos.filter((s) => s.id !== st.id);
      renderSubtramosTable();
    });
  });
}

// ── Excel export ─────────────────────────────────────────────
function fechaLargaEs(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('es-CO', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function diaClasificacion(ts) {
  if (!ts) return '';
  const dow = new Date(ts).getDay(); // 0 domingo, 6 sábado
  return (dow === 0 || dow === 6) ? 'ATIPICO' : 'TIPICO';
}

function resolveNodeName(nodeId) {
  if (nodeId === START_NODE_ID) return 'Inicio';
  if (nodeId === END_NODE_ID)   return 'Fin';
  const n = referenceNodes.find((x) => x.id === nodeId);
  return n ? n.name : '(nodo)';
}

// For one recorrido, walk its track advancing a cursor through the list
// of active subtramos. That way "CL53 → CL24" and "CL24 → CL53" in the
// same recorrido pick up different crossings of the same nodes.
function subtramoRowsForRecorrido(rec, threshold) {
  const crossingsByNode = new Map();
  for (const n of referenceNodes) {
    crossingsByNode.set(n.id, findNodeCrossings(n, rec.points, threshold));
  }

  const firstIdxAfter = (nodeId, afterIdx) => {
    if (nodeId === START_NODE_ID) return 0;
    if (nodeId === END_NODE_ID)   return rec.points.length - 1;
    const list = crossingsByNode.get(nodeId) || [];
    const hit = list.find((c) => c.trackIndex > afterIdx);
    return hit ? hit.trackIndex : -1;
  };

  // For the subtramo's START we want the LAST near-pass to the start
  // node before the vehicle commits to the end node. A recorrido that
  // grazes the threshold disc, drifts out, and then passes much closer
  // moments later should report the closer (later) approach — that is
  // the real "paso por el nodo" the operator measures by eye.
  const lastIdxBefore = (nodeId, afterIdx, beforeIdx) => {
    if (nodeId === START_NODE_ID) return 0;
    if (nodeId === END_NODE_ID)   return rec.points.length - 1;
    const list = crossingsByNode.get(nodeId) || [];
    let pick = -1;
    for (const c of list) {
      if (c.trackIndex <= afterIdx) continue;
      if (c.trackIndex >= beforeIdx) break;
      pick = c.trackIndex;
    }
    return pick;
  };

  const out = [];
  let cursor = -1;
  for (const st of subtramos) {
    if (!st.active) continue;
    const tentativeEndIdx = firstIdxAfter(st.endNodeId, cursor);
    if (tentativeEndIdx < 0) continue;
    const startIdx = lastIdxBefore(st.startNodeId, cursor, tentativeEndIdx);
    if (startIdx < 0) continue;
    const endIdx = firstIdxAfter(st.endNodeId, startIdx);
    if (endIdx < 0 || endIdx <= startIdx) continue;

    const segPoints = rec.points.slice(startIdx, endIdx + 1);
    if (segPoints.length < 2) continue;
    const metrics = segmentMetrics(segPoints);

    out.push({
      subtramo: st,
      startIdx,
      endIdx,
      firstPointTime: segPoints[0].timestamp,
      lastPointTime:  segPoints[segPoints.length - 1].timestamp,
      distance: metrics.distance,
      time:     metrics.time,
      avgSpeed: metrics.avgSpeed,
    });
    cursor = endIdx;
  }
  return out;
}

const EXCEL_HEADERS = [
  'DÍA', 'FECHA', 'PERIODO', 'LINK', 'CORREDOR', 'TRAMO',
  'CALZADA', 'TIPO DE VEHICULO', 'RECORRIDO', 'SENTIDO',
  'HORA DE INICIO', 'HORA LLEGADA', 'DISTANCIA (KM)', 'TIEMPO RECORRIDO', 'VELOCIDAD (KM/H)',
];
const EXCEL_COL_WIDTHS = [10, 30, 10, 52, 18, 24, 12, 16, 11, 11, 14, 14, 14, 16, 14];

function hhmmssFromSeconds(secs) {
  const s = Math.max(0, Math.round(Number(secs) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

// Sanitize a corridor name into a filename-safe slug (upper case, underscores).
function corredorSlug(name) {
  const base = (name || '').normalize('NFD').replace(/\p{Diacritic}/gu, '');
  const up = base.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return up || 'CORREDOR';
}

function upperOrBlank(v) {
  if (v == null || v === '') return '';
  return String(v).toUpperCase();
}

function currentStudy() {
  return {
    corredor: (el.smCorredor?.value || '').trim(),
    tipo:     el.smTipo?.value     || '',
    calzada:  el.smCalzada?.value  || '',
    periodo:  el.smPeriodo?.value  || '',
  };
}

function computeExportRows() {
  if (!recorridos.length || !subtramos.length) return [];
  const threshold = parseFloat(el.thresholdInput.value) || 50;
  const study = currentStudy();

  const rows = [];
  recorridos.forEach((rec, ri) => {
    const consecutivo = ri + 1;
    const hits = subtramoRowsForRecorrido(rec, threshold);
    for (const h of hits) {
      rows.push([
        upperOrBlank(diaClasificacion(rec.startTs)),
        upperOrBlank(fechaLargaEs(rec.startTs)),
        upperOrBlank(study.periodo),
        rec.sourceUrl || '',
        upperOrBlank(study.corredor),
        upperOrBlank(`${resolveNodeName(h.subtramo.startNodeId)} - ${resolveNodeName(h.subtramo.endNodeId)}`),
        upperOrBlank(study.calzada),
        upperOrBlank(study.tipo),
        consecutivo,
        upperOrBlank(h.subtramo.sentido || ''),
        formatClock(h.firstPointTime),
        formatClock(h.lastPointTime),
        +(h.distance / 1000).toFixed(2),
        hhmmssFromSeconds(h.time),
        +Number(h.avgSpeed || 0).toFixed(2),
      ]);
    }
  });
  return rows;
}

function renderPreviewTable() {
  if (!el.previewBody) return;
  const rows = computeExportRows();

  if (!rows.length) {
    el.previewEmpty.classList.remove('hidden');
    el.previewWrap.classList.add('hidden');
    el.previewBody.innerHTML = '';
    el.previewHead.innerHTML = '';
    el.previewMeta.textContent = '—';
    return;
  }

  el.previewEmpty.classList.add('hidden');
  el.previewWrap.classList.remove('hidden');

  el.previewHead.innerHTML = EXCEL_HEADERS.map((h) => `<th>${escapeHtml(h)}</th>`).join('');

  const numericCols = new Set([8, 12, 13, 14]); // RECORRIDO, DISTANCIA, TIEMPO HORA, VELOCIDAD
  const linkCol = 3;                             // LINK
  el.previewBody.innerHTML = rows.map((row) => {
    return '<tr>' + row.map((v, ci) => {
      const cls = ci === linkCol ? 'link' : (numericCols.has(ci) ? 'num' : '');
      const title = ci === linkCol ? ` title="${escapeHtml(String(v))}"` : '';
      return `<td class="${cls}"${title}>${escapeHtml(String(v ?? ''))}</td>`;
    }).join('') + '</tr>';
  }).join('');

  const recs = recorridos.length;
  const active = subtramos.filter((s) => s.active).length;
  el.previewMeta.textContent = `${rows.length} filas · ${recs} recorrido(s) · ${active} subtramo(s) activos`;
}

function exportExcel() {
  if (typeof XLSX === 'undefined') {
    showToast('La librería de Excel aún no cargó. Reintenta en un segundo.', 'warning');
    return;
  }
  if (!recorridos.length) { showToast('Carga al menos un recorrido antes de exportar.', 'warning'); return; }
  if (!subtramos.length)  { showToast('Define al menos un subtramo.', 'warning'); return; }

  const rows = computeExportRows();
  if (!rows.length) {
    showToast('Ningún subtramo activo pudo matchearse con los recorridos cargados. Revisa nodos y umbral.', 'warning');
    return;
  }
  const study = currentStudy();

  // Sheet name = TIPICO / ATIPICO based on first recorrido's weekday
  const sheetName = diaClasificacion(recorridos[0].startTs) || 'RECORRIDOS';

  // Build sheet and apply styles
  const aoa = [EXCEL_HEADERS, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = EXCEL_COL_WIDTHS.map((w) => ({ wch: w }));

  const thinBorder = { style: 'thin', color: { rgb: 'CCCCCC' } };
  const borderAll = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

  const headerStyle = {
    font: { name: 'Calibri', bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
    fill: { patternType: 'solid', fgColor: { rgb: '1F3864' } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border: borderAll,
  };
  const zebraWhite = {
    font: { name: 'Calibri', sz: 11, color: { rgb: '1F2937' } },
    fill: { patternType: 'solid', fgColor: { rgb: 'FFFFFF' } },
    alignment: { vertical: 'center', wrapText: false },
    border: borderAll,
  };
  const zebraGray = {
    font: { name: 'Calibri', sz: 11, color: { rgb: '1F2937' } },
    fill: { patternType: 'solid', fgColor: { rgb: 'F2F2F2' } },
    alignment: { vertical: 'center', wrapText: false },
    border: borderAll,
  };

  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let R = range.s.r; R <= range.e.r; R++) {
    for (let C = range.s.c; C <= range.e.c; C++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      if (!ws[addr]) ws[addr] = { t: 's', v: '' };
      if (R === 0) ws[addr].s = headerStyle;
      else ws[addr].s = (R % 2 === 1) ? zebraWhite : zebraGray;
    }
  }

  ws['!rows'] = [{ hpt: 28 }]; // header row a bit taller
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  ws['!autofilter'] = { ref: ws['!ref'] };
  // Hide the sheet's default grid lines — each cell's solid fill already
  // carries its own border look, so the default grey gridlines are noise.
  ws['!views'] = [{ showGridLines: false }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  const stamp = new Date(recorridos[0].startTs || Date.now()).toISOString().slice(0, 10);
  const filename = `VEL_TRAFING_${corredorSlug(study.corredor)}_${stamp}.xlsx`;
  XLSX.writeFile(wb, filename);
  showToast(`${rows.length} filas exportadas`, 'success');
}

// ── Boot ─────────────────────────────────────────────────────
init();
