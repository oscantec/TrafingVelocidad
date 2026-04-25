/**
 * Softrafing Velocidades — Minimal track viewer (shareable).
 * Reads ?track=<cloudId> from the URL, pulls the recorrido from Supabase
 * and renders it on a read-only map with the same playback panel as the
 * processing viewer. No editing, no import, just observation.
 */

import { listCloudTracks, getCloudTrackPoints, decodeTrackName } from '../lib/supabase.js';
import { initPlayback, loadPlaybackTrack } from './playback.js';

const $ = (id) => document.getElementById(id);

let map;
let baseLayer = null;
let baseDecorator = null;

function initMap() {
  map = L.map('trackMap', {
    center: [4.6097, -74.0817],
    zoom: 13,
    zoomControl: true,
  });
  L.tileLayer('https://cartodb-basemaps-{s}.global.ssl.fastly.net/light_all/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OSM &copy; CARTO',
  }).addTo(map);
}

function mapToken(name) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(`--ui-${name}`)
    .trim();
  return v || '#000';
}

function drawBaseTrack(points) {
  if (baseLayer)     map.removeLayer(baseLayer);
  if (baseDecorator) map.removeLayer(baseDecorator);

  const latlngs = points.map((p) => [p.lat, p.lng]);
  baseLayer = L.polyline(latlngs, {
    color: mapToken('ink-2'),
    weight: 3.5,
    opacity: 0.75,
  }).addTo(map);

  if (window.L && L.polylineDecorator) {
    baseDecorator = L.polylineDecorator(baseLayer, {
      patterns: [{
        offset: '4%',
        repeat: '8%',
        symbol: L.Symbol.arrowHead({
          pixelSize: 11,
          polygon: false,
          pathOptions: { stroke: true, color: mapToken('orange'), weight: 2.2, opacity: 0.95 },
        }),
      }],
    }).addTo(map);
  }

  if (latlngs.length >= 2) {
    map.fitBounds(baseLayer.getBounds(), { padding: [40, 40] });
    const dot = (token) => L.divIcon({
      className: '',
      html: `<div class="map-dot" style="background:var(--ui-${token});"></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });
    L.marker(latlngs[0], { icon: dot('success') }).addTo(map);
    L.marker(latlngs[latlngs.length - 1], { icon: dot('danger') }).addTo(map);
  }
}

function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function showError(title, detail) {
  const card = $('statusCard');
  if (!card) return;
  card.innerHTML = `<h3>${title}</h3><p>${detail}</p>`;
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const id = params.get('track');
  if (!id) {
    showError('Falta el parámetro ?track', 'Abre la URL compartida desde el módulo de Captura o agrega <code>?track=&lt;id&gt;</code> al final.');
    return;
  }

  initMap();
  initPlayback(map);

  // Track metadata (name, pts, fecha) — pulled from the tracks list.
  let meta = null;
  try {
    const tracks = await listCloudTracks();
    meta = (tracks || []).find((t) => t.id === id) || null;
  } catch (err) {
    console.warn('[track] list error:', err);
  }

  if (meta) {
    const decoded = decodeTrackName(meta.name);
    const cleanName = decoded.name || 'Recorrido';
    $('trackTitle').textContent = cleanName;
    const parts = [];
    if (meta.start_time) {
      const d = new Date(meta.start_time);
      if (!isNaN(d)) parts.push(d.toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }));
    }
    if (meta.point_count) parts.push(`${meta.point_count} pts`);
    if (meta.distance)    parts.push(`${(meta.distance / 1000).toFixed(2)} km`);
    const classifyBits = [decoded.tipo, decoded.calzada, decoded.periodo].filter(Boolean).join(' · ');
    if (classifyBits) parts.push(classifyBits);
    $('trackMetaHdr').textContent = parts.join(' · ') || '—';
    document.title = cleanName;
  }

  // Points
  let raw = [];
  try {
    raw = await getCloudTrackPoints(id);
  } catch (err) {
    console.error('[track] points error:', err);
  }

  if (!raw || !raw.length) {
    showError('Recorrido sin puntos',
      'El recorrido existe pero no tiene puntos GPS asociados, o el enlace está roto.');
    return;
  }

  const points = raw.map((p) => ({
    lat:       Number(p.lat),
    lng:       Number(p.lng),
    speed:     p.speed == null ? null : Number(p.speed),
    accuracy:  p.accuracy == null ? null : Number(p.accuracy),
    altitude:  p.altitude == null ? null : Number(p.altitude),
    timestamp: new Date(p.timestamp).getTime(),
  }));

  // Hide status card now that we have data
  $('statusCard')?.remove();

  drawBaseTrack(points);
  loadPlaybackTrack(points);

  // If no metadata came from listCloudTracks, fall back to derived values
  if (!meta) {
    const first = points[0];
    const last  = points[points.length - 1];
    const secs  = first && last ? (last.timestamp - first.timestamp) / 1000 : 0;
    $('trackMetaHdr').textContent = `${points.length} pts · ${formatDuration(secs)}`;
  }
}

boot();
