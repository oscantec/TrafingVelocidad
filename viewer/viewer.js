/**
 * TrafingVelocidad — Viewer Module
 * Track visualization, Haversine-based node matching, and automatic segmentation
 */

import { openDB, getAllTracks, getTrackPoints } from '../lib/db.js';
import {
  haversineDistance, totalDistance, elapsedTime, averageSpeed,
  matchNodesToTrack, segmentTrack, segmentMetrics,
  formatDistance, formatDuration, formatSpeed, generateSegmentColors,
} from '../lib/geo.js';
import { parseGPX, parseKML, parseGeoJSON, parseTrackContent, parseNodesFile, readFileAsText } from '../lib/gpx.js';
import { listCloudTracks, getCloudTrackPoints, testConnection,
         listTramos, listCorridors, listControlPointsByTramo,
         saveTramoComplete, deleteTramo } from '../lib/supabase.js';
import { initPlayback, loadPlaybackTrack } from './playback.js';

// ── State ────────────────────────────────────────────────────
let trackPoints = [];       // Current track points
let referenceNodes = [];    // Loaded reference nodes
let segmentResults = [];    // Computed segments with metrics
let matchResults = [];      // Node-to-track matching results
let recorridos = [];        // [{ id, name, points, startTs }] sorted ascending by startTs
let activeRecorridoId = null;

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
  trackSelect: $('trackSelect'),
  btnRefreshTracks: $('btnRefreshTracks'),
  trackFileInput: $('trackFileInput'),
  trackUrlInput: $('trackUrlInput'),
  btnLoadUrl: $('btnLoadUrl'),
  trackPasteInput: $('trackPasteInput'),
  btnLoadPaste: $('btnLoadPaste'),
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
  trackInfo: $('trackInfo'),
  infoPoints: $('infoPoints'),
  infoDistance: $('infoDistance'),
  infoDuration: $('infoDuration'),
  nodesInfo: $('nodesInfo'),
  nodesCount: $('nodesCount'),
  nodesList: $('nodesList'),
  segmentsSummary: $('segmentsSummary'),
  summarySegments: $('summarySegments'),
  summaryDistance: $('summaryDistance'),
  summaryAvgSpeed: $('summaryAvgSpeed'),
  noSegments: $('noSegments'),
  segmentsTable: $('segmentsTable'),
  segmentsBody: $('segmentsBody'),
  mapLegend: $('mapLegend'),
  toastContainer: $('toastContainer'),
  tabData: $('tabData'),
  tabSegments: $('tabSegments'),
  // Study metadata
  smFecha:    $('smFecha'),
  smCorredor: $('smCorredor'),
  smTipo:     $('smTipo'),
  smPeriodo:  $('smPeriodo'),
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
  initStudyMeta();
  loadTrackList();
  initPlayback(map);
  refreshTramos();
}

function initStudyMeta() {
  // Default date = today (local)
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  if (el.smFecha && !el.smFecha.value) el.smFecha.value = `${yyyy}-${mm}-${dd}`;
}

function renderCorredoresDropdown() {
  if (!el.smCorredor) return;
  const prev = el.smCorredor.value;
  el.smCorredor.innerHTML = '<option value="">— Seleccionar —</option>';
  for (const c of corridorsCache) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    el.smCorredor.appendChild(opt);
  }
  if (prev && corridorsCache.some((c) => c.id === prev)) el.smCorredor.value = prev;
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
  // Track from DB
  el.trackSelect.addEventListener('change', handleTrackSelect);
  el.btnRefreshTracks.addEventListener('click', loadTrackList);

  // Track from file
  el.trackFileInput.addEventListener('change', handleTrackFileImport);

  // Track from URL
  el.btnLoadUrl.addEventListener('click', handleTrackUrlImport);
  el.trackUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleTrackUrlImport();
  });

  // Track from pasted content
  el.btnLoadPaste.addEventListener('click', handleTrackPasteImport);

  // Recorridos list — clear all
  el.btnClearRecorridos.addEventListener('click', clearRecorridos);

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
      el.cpSetupCopy.textContent = '✓ Copiado';
      setTimeout(() => { el.cpSetupCopy.textContent = '📋 Copiar SQL'; }, 1600);
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

  // Process
  el.btnProcess.addEventListener('click', processSegmentation);

  // Tabs
  document.querySelectorAll('.panel-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
}

// ── Track Loading (local IndexedDB + Supabase cloud) ────────
async function loadTrackList() {
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
    grpLocal.label = '💾 Local';
    for (const t of localTracks) {
      const opt = document.createElement('option');
      opt.value = `local:${t.id}`;
      const cloudMark = t.synced ? ' ☁' : '';
      opt.textContent = `${t.name}${cloudMark} · ${fmtDate(t.startTime)} · ${t.pointCount || '?'} pts`;
      grpLocal.appendChild(opt);
    }
    el.trackSelect.appendChild(grpLocal);
  }

  // Cloud-only tracks (captured on another device / browser)
  const cloudOnly = cloudTracks.filter((t) => !t.local_id || !localIds.has(t.local_id));
  if (cloudOnly.length) {
    const grpCloud = document.createElement('optgroup');
    grpCloud.label = '☁ Nube (otros dispositivos)';
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
      showToast(`Track ☁ cargado desde la nube: ${points.length} puntos`, 'success');
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
    const resp = await fetch(url, { mode: 'cors' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const { name, points } = parseTrackContent(text, url);
    addRecorrido({ name: name || url, points });
    el.trackUrlInput.value = '';
    showToast(`URL importada (${name}): ${points.length} puntos`, 'success');
  } catch (err) {
    console.error('[Viewer] URL import error:', err);
    const msg = String(err.message || err);
    if (msg.includes('Failed to fetch') || msg.includes('CORS') || msg.includes('NetworkError')) {
      showToast('El servidor bloquea acceso cruzado (CORS). Descarga el archivo y súbelo o pégalo.', 'error', 6500);
    } else {
      showToast(`Error: ${msg}`, 'error', 6000);
    }
  } finally {
    el.btnLoadUrl.disabled = false;
    el.btnLoadUrl.textContent = '↓';
  }
}

function handleTrackPasteImport() {
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
function addRecorrido({ name, points }) {
  if (!points || !points.length) return;
  const startTs = points[0]?.timestamp || Date.now();
  const rec = {
    id: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    points,
    startTs,
  };
  recorridos.push(rec);
  recorridos.sort((a, b) => a.startTs - b.startTs);
  activeRecorridoId = rec.id;
  renderRecorridosList();
  loadTrackData(points);
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
    const bg = isActive ? 'background:var(--accent-dim);' : '';
    return `
      <div class="node-item" data-id="${r.id}" style="cursor:pointer;${bg}">
        <div style="flex:1;min-width:0;">
          <span class="node-name">Recorrido ${i + 1} · ${escapeHtml(r.name)}</span>
          <span class="node-coords">${fmt(r.startTs)} · ${r.points.length} pts</span>
        </div>
        <button class="btn btn-sm btn-danger" data-remove title="Quitar">✕</button>
      </div>`;
  }).join('');

  el.recorridosList.querySelectorAll('[data-id]').forEach((row) => {
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-remove]')) return;
      activateRecorrido(row.dataset.id);
    });
  });
  el.recorridosList.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
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
      el.trackInfo.classList.add('hidden');
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
  el.trackInfo.classList.add('hidden');
  updateProcessButton();
}

function loadTrackData(points) {
  trackPoints = points;
  clearSegments();

  // Show track info
  el.trackInfo.classList.remove('hidden');
  el.infoPoints.textContent = points.length;
  el.infoDistance.textContent = (totalDistance(points) / 1000).toFixed(2);
  el.infoDuration.textContent = formatDuration(elapsedTime(points));

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

alter table public.corridors      enable row level security;
alter table public.tramos         enable row level security;
alter table public.control_points enable row level security;

drop policy if exists "anon all corridors"      on public.corridors;
drop policy if exists "anon all tramos"         on public.tramos;
drop policy if exists "anon all control_points" on public.control_points;

create policy "anon all corridors"      on public.corridors      for all using (true) with check (true);
create policy "anon all tramos"         on public.tramos         for all using (true) with check (true);
create policy "anon all control_points" on public.control_points for all using (true) with check (true);`;

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
  renderCorredoresDropdown();
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
  const tramo = tramosCache.find((t) => t.id === tramoId);
  const label = tramo ? `${tramo.corridors?.name || ''} / ${tramo.name}` : 'tramo';
  showToast(`Cargados ${nodes.length} puntos de "${label}"`, 'success');
  el.savedTramoSelect.value = '';
}

function toggleDrawingMode() {
  drawingMode = !drawingMode;
  el.btnDrawPoints.classList.toggle('btn-success', drawingMode);
  el.btnDrawPoints.classList.toggle('btn-primary', !drawingMode);
  el.btnDrawPoints.textContent = drawingMode ? '✓ Dibujo activo — clic para terminar' : '✏ Dibujar en mapa';
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
  if (nodes.length === 0) { el.nodesInfo.classList.add('hidden'); return; }
  el.nodesInfo.classList.remove('hidden');
  el.nodesCount.textContent = nodes.length;

  el.nodesList.innerHTML = nodes.map((n, i) => {
    const mark = n.cloud
      ? '<span class="badge badge-success" style="padding:1px 6px;font-size:9px;text-transform:none;letter-spacing:0;">☁</span>'
      : '<span class="badge" style="background:var(--surface-alt);color:var(--text-muted);padding:1px 6px;font-size:9px;text-transform:none;letter-spacing:0;">local</span>';
    return `
      <div class="node-item" data-id="${n.id}">
        <div style="flex:1;min-width:0;">
          <span class="node-name">${i + 1}. ${escapeHtml(n.name)} ${mark}</span>
          <span class="node-coords">${Number(n.lat).toFixed(6)}, ${Number(n.lng).toFixed(6)}</span>
        </div>
        <button class="btn btn-sm btn-danger" data-remove title="Quitar">✕</button>
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
    points: referenceNodes.map((n) => ({ name: n.name, lat: +n.lat, lng: +n.lng })),
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
      // Step 1: Match nodes to track
      matchResults = matchNodesToTrack(referenceNodes, trackPoints, threshold);

      // Update nodes list with distances
      updateNodesWithDistances(matchResults);

      // Filter only nodes within threshold
      const validMatches = matchResults.filter((m) => m.withinThreshold);

      if (validMatches.length === 0) {
        showToast(`Ningún nodo dentro del umbral de ${threshold}m. Aumenta el umbral.`, 'warning');
        showBadge(`0 nodos válidos`, 'danger');
        return;
      }

      // Step 2: Get cut indices
      const cutIndices = validMatches.map((m) => m.trackIndex);

      // Step 3: Segment the track
      const segments = segmentTrack(trackPoints, cutIndices);

      // Step 4: Calculate metrics for each segment
      segmentResults = segments.map((seg, i) => {
        const metrics = segmentMetrics(seg.points);
        
        // Determine start/end node names
        const startNode = findNodeAtIndex(validMatches, seg.startIndex);
        const endNode = findNodeAtIndex(validMatches, seg.endIndex);

        return {
          index: i + 1,
          startIndex: seg.startIndex,
          endIndex: seg.endIndex,
          startNode: startNode ? startNode.node.name : 'Inicio',
          endNode: endNode ? endNode.node.name : (i === segments.length - 1 ? 'Fin' : `→`),
          points: seg.points,
          ...metrics,
        };
      });

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
function renderSegmentsTable(segments) {
  const colors = generateSegmentColors(segments.length);

  el.noSegments.classList.add('hidden');
  el.segmentsTable.classList.remove('hidden');

  el.segmentsBody.innerHTML = segments.map((seg, i) => `
    <tr data-segment="${i}">
      <td>${seg.index}</td>
      <td><span class="segment-color" style="background:${colors[i]}"></span></td>
      <td>${seg.startNode}</td>
      <td>${seg.endNode}</td>
      <td>${formatDistance(seg.distance)}</td>
      <td>${formatDuration(seg.time)}</td>
      <td>${formatSpeed(seg.avgSpeed)} km/h</td>
      <td>${formatSpeed(seg.maxSpeed)} km/h</td>
      <td>${seg.pointCount}</td>
    </tr>
  `).join('');

  // Row hover → highlight segment on map
  el.segmentsBody.querySelectorAll('tr').forEach((row) => {
    const idx = parseInt(row.dataset.segment);

    row.addEventListener('mouseenter', () => {
      highlightSegment(idx);
      row.classList.add('highlighted');
    });

    row.addEventListener('mouseleave', () => {
      unhighlightSegment(idx);
      row.classList.remove('highlighted');
    });

    row.addEventListener('click', () => {
      // Zoom to segment
      if (segmentLayers[idx]) {
        map.fitBounds(segmentLayers[idx].getBounds(), { padding: [60, 60] });
      }
    });
  });
}

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

// ── Summary ──────────────────────────────────────────────────
function showSegmentsSummary(segments) {
  el.segmentsSummary.style.display = 'block';
  el.summarySegments.textContent = segments.length;

  const totalDist = segments.reduce((sum, s) => sum + s.distance, 0);
  el.summaryDistance.textContent = (totalDist / 1000).toFixed(2);

  const totalTime = segments.reduce((sum, s) => sum + s.time, 0);
  const overallAvg = totalTime > 0 ? (totalDist / 1000) / (totalTime / 3600) : 0;
  el.summaryAvgSpeed.textContent = formatSpeed(overallAvg);
}

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

  if (tab) tab.classList.add('active');
  if (content) content.classList.add('active');
}

// ── Utilities ────────────────────────────────────────────────
function clearSegments() {
  segmentResults = [];
  matchResults = [];
  clearSegmentLayers();
  el.segmentsTable.classList.add('hidden');
  el.noSegments.classList.remove('hidden');
  el.segmentsSummary.style.display = 'none';
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

// ── Boot ─────────────────────────────────────────────────────
init();
