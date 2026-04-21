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
         listControlPoints, saveControlPoint, deleteControlPoint } from '../lib/supabase.js';
import { initPlayback, loadPlaybackTrack } from './playback.js';

// ── State ────────────────────────────────────────────────────
let trackPoints = [];       // Current track points
let referenceNodes = [];    // Loaded reference nodes
let segmentResults = [];    // Computed segments with metrics
let matchResults = [];      // Node-to-track matching results

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
  savedPointsSelect: $('savedPointsSelect'),
  btnRefreshPoints:  $('btnRefreshPoints'),
  btnDrawPoints:     $('btnDrawPoints'),
  drawingHint:       $('drawingHint'),
  cpSetupModal:      $('cpSetupModal'),
  cpSetupSql:        $('cpSetupSql'),
  cpSetupCopy:       $('cpSetupCopy'),
  cpSetupClose:      $('cpSetupClose'),
  cpSetupRetry:      $('cpSetupRetry'),
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
  loadTrackList();
  initPlayback(map);
  refreshSavedPoints();
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

  // Nodes from file
  // Control-point events
  el.btnDrawPoints.addEventListener('click', toggleDrawingMode);
  el.btnRefreshPoints.addEventListener('click', refreshSavedPoints);
  el.savedPointsSelect.addEventListener('change', handleSavedPointSelect);
  map.on('click', handleMapClickForDrawing);

  // Control-point setup modal
  el.cpSetupSql.textContent = CONTROL_POINTS_SETUP_SQL;
  el.cpSetupCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(CONTROL_POINTS_SETUP_SQL);
      el.cpSetupCopy.textContent = '✓ Copiado';
      setTimeout(() => { el.cpSetupCopy.textContent = '📋 Copiar SQL'; }, 1600);
    } catch {}
  });
  el.cpSetupClose.addEventListener('click', () => el.cpSetupModal.classList.remove('active'));
  el.cpSetupRetry.addEventListener('click', async () => {
    el.cpSetupModal.classList.remove('active');
    await refreshSavedPoints();
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
    loadTrackData(points);
  } catch (err) {
    console.error('[viewer] track select error:', err);
    showToast(`Error cargando track: ${err.message || err}`, 'error');
  }
}

async function handleTrackFileImport(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const text = await readFileAsText(file);
    const { name, points } = parseTrackContent(text, file.name);
    loadTrackData(points);
    showToast(`Archivo importado (${name}): ${points.length} puntos`, 'success');
  } catch (err) {
    console.error('[Viewer] Import error:', err);
    showToast(`Error importando: ${err.message}`, 'error');
  }
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
    loadTrackData(points);
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
    loadTrackData(points);
    showToast(`Contenido cargado (${name}): ${points.length} puntos`, 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error', 6000);
  }
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

// ── Control Points (tramificación) ───────────────────────────
let drawingMode = false;
let savedPointsCache = [];  // last fetched cloud list

const CONTROL_POINTS_SETUP_SQL = `create table if not exists public.control_points (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  lat        double precision not null,
  lng        double precision not null,
  created_at timestamptz default now()
);

alter table public.control_points enable row level security;

drop policy if exists "anon read control_points"   on public.control_points;
drop policy if exists "anon write control_points"  on public.control_points;
drop policy if exists "anon update control_points" on public.control_points;
drop policy if exists "anon delete control_points" on public.control_points;

create policy "anon read control_points"   on public.control_points for select using (true);
create policy "anon write control_points"  on public.control_points for insert with check (true);
create policy "anon update control_points" on public.control_points for update using (true) with check (true);
create policy "anon delete control_points" on public.control_points for delete using (true);`;

async function refreshSavedPoints() {
  const res = await listControlPoints();
  if (!res.ok) {
    if (res.missing) { el.cpSetupModal.classList.add('active'); return; }
    showToast(`Error leyendo nube: ${res.error}`, 'error');
    return;
  }
  savedPointsCache = res.points;
  renderSavedPointsDropdown();
}

function renderSavedPointsDropdown() {
  const sel = el.savedPointsSelect;
  sel.innerHTML = '<option value="">— Seleccionar —</option>';
  if (savedPointsCache.length === 0) {
    sel.innerHTML += '<option disabled>(no hay puntos guardados todavía)</option>';
    return;
  }
  const allOpt = document.createElement('option');
  allOpt.value = '__ALL__';
  allOpt.textContent = `Todos (${savedPointsCache.length})`;
  sel.appendChild(allOpt);

  const sep = document.createElement('option');
  sep.disabled = true;
  sep.textContent = '──────────';
  sel.appendChild(sep);

  for (const p of savedPointsCache) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} · ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
    sel.appendChild(opt);
  }
}

function handleSavedPointSelect() {
  const v = el.savedPointsSelect.value;
  if (!v) return;

  if (v === '__ALL__') {
    const nodes = savedPointsCache.map((p) => ({ id: p.id, name: p.name, lat: +p.lat, lng: +p.lng }));
    referenceNodes = nodes;
    displayNodes(nodes);
    drawNodeMarkers(nodes);
    updateProcessButton();
    showToast(`${nodes.length} puntos cargados de la nube`, 'success');
  } else {
    const p = savedPointsCache.find((x) => x.id === v);
    if (!p) return;
    const exists = referenceNodes.some((n) => n.id === p.id);
    if (exists) { showToast('Ese punto ya está cargado', 'warning'); return; }
    referenceNodes.push({ id: p.id, name: p.name, lat: +p.lat, lng: +p.lng });
    displayNodes(referenceNodes);
    drawNodeMarkers(referenceNodes);
    updateProcessButton();
    showToast(`"${p.name}" añadido`, 'success');
  }
  el.savedPointsSelect.value = '';
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
        <button id="np-save" style="flex:1;padding:6px 10px;background:#F05A1A;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;">Guardar</button>
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

    const commit = async () => {
      const name = (input.value || '').trim() || defaultName;
      map.closePopup(popup);

      // optimistic add to the local list with a temp id
      const tempNode = { id: 'temp-' + Date.now(), name, lat: latlng.lat, lng: latlng.lng };
      referenceNodes.push(tempNode);
      displayNodes(referenceNodes);
      drawNodeMarkers(referenceNodes);
      updateProcessButton();

      const res = await saveControlPoint({ name, lat: latlng.lat, lng: latlng.lng });
      if (res.success) {
        tempNode.id = res.data.id;       // replace temp id with cloud id
        displayNodes(referenceNodes);
        savedPointsCache.unshift(res.data);
        renderSavedPointsDropdown();
        showToast(`"${name}" guardado en nube`, 'success');
      } else if (res.missing) {
        el.cpSetupModal.classList.add('active');
      } else {
        showToast(`Guardado local; error en nube: ${res.error}`, 'warning', 5500);
      }
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

  el.nodesList.innerHTML = nodes.map((n) => `
    <div class="node-item" data-id="${n.id}">
      <div style="flex:1;min-width:0;">
        <span class="node-name">${escapeHtml(n.name)}</span>
        <span class="node-coords">${Number(n.lat).toFixed(6)}, ${Number(n.lng).toFixed(6)}</span>
      </div>
      <button class="btn btn-sm btn-danger" data-remove title="Quitar">✕</button>
    </div>
  `).join('');

  el.nodesList.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const row = ev.currentTarget.closest('[data-id]');
      if (row) removeNodeById(row.dataset.id);
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function removeNodeById(id) {
  const idx = referenceNodes.findIndex((n) => n.id === id);
  if (idx === -1) return;
  const node = referenceNodes[idx];
  referenceNodes.splice(idx, 1);
  displayNodes(referenceNodes);
  drawNodeMarkers(referenceNodes);
  updateProcessButton();

  // Only attempt cloud delete for points that were actually saved
  if (!String(id).startsWith('temp-') && !id.includes(':')) {
    const res = await deleteControlPoint(id);
    if (res.success) {
      savedPointsCache = savedPointsCache.filter((p) => p.id !== id);
      renderSavedPointsDropdown();
      showToast(`"${node.name}" borrado de la nube`, 'success');
    } else {
      showToast(`Borrado local; error en nube: ${res.error}`, 'warning');
    }
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
