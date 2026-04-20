/**
 * TrafingVelocidad — Capture Module
 * High-precision GPS tracking with IndexedDB persistence, Wake Lock, and GPX export
 * 
 * State Machine: IDLE → RECORDING → PAUSED → STOPPED
 */

import { openDB, createTrack, updateTrack, addPoint, getTrackPoints, getAllTracks, deleteTrack } from '../lib/db.js';
import { haversineDistance, totalDistance, formatDistance, formatDuration, formatSpeed } from '../lib/geo.js';
import { generateGPX, downloadGPX, downloadJSON } from '../lib/gpx.js';
import { syncTrackToCloud } from '../lib/supabase.js';

// ── State ────────────────────────────────────────────────────
const STATE = {
  IDLE: 'idle',
  RECORDING: 'recording',
  PAUSED: 'paused',
  STOPPED: 'stopped',
};

let currentState = STATE.IDLE;
let currentTrackId = null;
let watchId = null;
let wakeLock = null;
let timerInterval = null;
let startTimestamp = null;
let pausedDuration = 0;
let pauseStart = null;

// Live data
let pointCount = 0;
let totalDist = 0;
let lastPoint = null;
let currentSpeed = 0;
let allPoints = []; // In-memory buffer for map rendering

// Leaflet
let map = null;
let positionMarker = null;
let accuracyCircle = null;
let trackPolyline = null;

// ── DOM Elements ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const el = {
  btnRecord: $('btnRecord'),
  btnPause: $('btnPause'),
  btnResume: $('btnResume'),
  btnDownloadGPX: $('btnDownloadGPX'),
  btnDownloadJSON: $('btnDownloadJSON'),
  btnHistory: $('btnHistory'),
  trackNameInput: $('trackNameInput'),
  recordingBadge: $('recordingBadge'),
  wakeLockBadge: $('wakeLockBadge'),
  statusGPS: $('statusGPS'),
  statusAccuracy: $('statusAccuracy'),
  statusPoints: $('statusPoints'),
  statusDB: $('statusDB'),
  statusSync: $('statusSync'),
  metricSpeed: $('metricSpeed'),
  metricDistance: $('metricDistance'),
  metricTime: $('metricTime'),
  metricAvgSpeed: $('metricAvgSpeed'),
  gpsErrorOverlay: $('gpsErrorOverlay'),
  gpsErrorMessage: $('gpsErrorMessage'),
  savedTracksList: $('savedTracksList'),
  toastContainer: $('toastContainer'),
};

// ── Initialize ───────────────────────────────────────────────
async function init() {
  try {
    await openDB();
    setStatus(el.statusDB, 'active', 'DB: OK');
  } catch (err) {
    setStatus(el.statusDB, 'error', 'DB: Error');
    showToast('Error abriendo base de datos', 'error');
  }

  initMap();
  bindEvents();
  checkGPSPermission();
}

// ── Map Setup ────────────────────────────────────────────────
function initMap() {
  map = L.map('captureMap', {
    center: [4.6097, -74.0817], // Bogota default
    zoom: 15,
    zoomControl: true,
    attributionControl: true,
  });

  // Dark tile layer
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(map);

  // Track polyline
  trackPolyline = L.polyline([], {
    color: '#FF6B00',
    weight: 4,
    opacity: 0.9,
    smoothFactor: 1,
  }).addTo(map);

  // Position marker (orange pulsing dot)
  const pulseIcon = L.divIcon({
    className: '',
    html: `<div style="
      width: 16px; height: 16px;
      background: #FF6B00;
      border: 3px solid #fff;
      border-radius: 50%;
      box-shadow: 0 0 12px rgba(255,107,0,0.6);
    "></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });

  positionMarker = L.marker([0, 0], { icon: pulseIcon }).addTo(map);
  positionMarker.setOpacity(0);

  // Accuracy circle
  accuracyCircle = L.circle([0, 0], {
    radius: 0,
    color: '#FF6B00',
    fillColor: '#FF6B00',
    fillOpacity: 0.08,
    weight: 1,
    opacity: 0.3,
  }).addTo(map);
  accuracyCircle.setStyle({ opacity: 0, fillOpacity: 0 });

  // Fix map size after layout
  setTimeout(() => map.invalidateSize(), 100);
}

// ── GPS Permission Check ─────────────────────────────────────
async function checkGPSPermission() {
  if (!('geolocation' in navigator)) {
    showGPSError('Tu navegador no soporta geolocalización.');
    return;
  }

  try {
    if ('permissions' in navigator) {
      const result = await navigator.permissions.query({ name: 'geolocation' });
      if (result.state === 'granted') {
        setStatus(el.statusGPS, 'active', 'GPS: Listo');
        getInitialPosition();
      } else if (result.state === 'prompt') {
        setStatus(el.statusGPS, 'warning', 'GPS: Pendiente permiso');
      } else {
        setStatus(el.statusGPS, 'error', 'GPS: Denegado');
        showGPSError('El permiso de ubicación fue denegado. Habilítalo en la configuración del navegador.');
      }

      result.addEventListener('change', () => {
        if (result.state === 'granted') {
          hideGPSError();
          setStatus(el.statusGPS, 'active', 'GPS: Listo');
        }
      });
    }
  } catch {
    // Permissions API not supported, try getting position
    getInitialPosition();
  }
}

function getInitialPosition() {
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      map.setView([latitude, longitude], 16);
      positionMarker.setLatLng([latitude, longitude]);
      positionMarker.setOpacity(1);
      setStatus(el.statusGPS, 'active', 'GPS: Listo');
      hideGPSError();
    },
    (err) => handleGPSError(err),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

// ── Event Binding ────────────────────────────────────────────
function bindEvents() {
  el.btnRecord.addEventListener('click', handleRecord);
  el.btnPause.addEventListener('click', handlePause);
  el.btnResume.addEventListener('click', handleResume);
  el.btnDownloadGPX.addEventListener('click', handleDownloadGPX);
  el.btnDownloadJSON.addEventListener('click', handleDownloadJSON);
  el.btnHistory.addEventListener('click', toggleHistory);

  // Re-acquire wake lock on visibility change
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && currentState === STATE.RECORDING) {
      await acquireWakeLock();
    }
  });

  // Warn before closing during recording
  window.addEventListener('beforeunload', (e) => {
    if (currentState === STATE.RECORDING) {
      e.preventDefault();
      e.returnValue = 'Hay un recorrido en progreso. ¿Seguro que deseas salir?';
    }
  });
}

// ── Recording Controls ───────────────────────────────────────
async function handleRecord() {
  if (currentState === STATE.IDLE || currentState === STATE.STOPPED) {
    await startRecording();
  } else if (currentState === STATE.RECORDING) {
    await stopRecording();
  }
}

async function startRecording() {
  try {
    // Create track
    const name = el.trackNameInput.value.trim() || `Recorrido ${new Date().toLocaleDateString('es')}`;
    currentTrackId = await createTrack({
      name,
      startTime: Date.now(),
      status: 'recording',
    });

    // Reset state
    pointCount = 0;
    totalDist = 0;
    lastPoint = null;
    currentSpeed = 0;
    allPoints = [];
    pausedDuration = 0;
    startTimestamp = Date.now();

    // Clear map
    trackPolyline.setLatLngs([]);

    // Start GPS watch
    startWatching();

    // Wake Lock
    await acquireWakeLock();

    // Timer
    timerInterval = setInterval(updateTimer, 1000);

    // Update UI state
    setState(STATE.RECORDING);
    showToast('Captura iniciada', 'success');
  } catch (err) {
    console.error('[Capture] Start error:', err);
    showToast('Error al iniciar captura', 'error');
  }
}

async function stopRecording() {
  // Stop GPS
  stopWatching();

  // Release Wake Lock
  releaseWakeLock();

  // Stop timer
  clearInterval(timerInterval);
  timerInterval = null;

  // Update track in DB
  if (currentTrackId) {
    await updateTrack(currentTrackId, {
      endTime: Date.now(),
      status: 'completed',
      pointCount,
    });
  }

  setState(STATE.STOPPED);
  showToast(`Captura finalizada · ${pointCount} puntos`, 'success');

  // Auto-sync to Supabase
  syncCurrentTrack();
}

async function syncCurrentTrack() {
  if (pointCount === 0 || !currentTrackId) return;

  setStatus(el.statusSync, 'warning', 'Nube: Sincronizando...');
  
  try {
    const points = await getTrackPoints(currentTrackId);
    const tracks = await getAllTracks();
    const track = tracks.find(t => t.id === currentTrackId);

    if (!track) return;

    const result = await syncTrackToCloud(track, points);
    
    if (result.success) {
      setStatus(el.statusSync, 'active', 'Nube: Sincronizado');
      showToast('Recorrido sincronizado a la nube', 'success');
    } else {
      setStatus(el.statusSync, 'error', 'Nube: Error');
      showToast('Error al sincronizar con la nube', 'error');
    }
  } catch (err) {
    console.error('[Sync] Error:', err);
    setStatus(el.statusSync, 'error', 'Nube: Error');
  }
}

function handlePause() {
  if (currentState !== STATE.RECORDING) return;

  stopWatching();
  releaseWakeLock();
  pauseStart = Date.now();

  clearInterval(timerInterval);
  timerInterval = null;

  setState(STATE.PAUSED);
  showToast('Captura pausada', 'warning');
}

async function handleResume() {
  if (currentState !== STATE.PAUSED) return;

  // Track paused duration
  if (pauseStart) {
    pausedDuration += Date.now() - pauseStart;
    pauseStart = null;
  }

  startWatching();
  await acquireWakeLock();

  timerInterval = setInterval(updateTimer, 1000);

  setState(STATE.RECORDING);
  showToast('Captura reanudada', 'success');
}

// ── GPS Watching ─────────────────────────────────────────────
function startWatching() {
  if (watchId !== null) return;

  watchId = navigator.geolocation.watchPosition(
    handlePosition,
    handleGPSError,
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000,
    }
  );
}

function stopWatching() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

async function handlePosition(position) {
  const { latitude, longitude, accuracy, altitude, speed } = position.coords;
  const timestamp = position.timestamp || Date.now();

  // Update GPS status
  setStatus(el.statusGPS, 'active', 'GPS: Activo');
  setStatus(el.statusAccuracy, accuracy <= 20 ? 'active' : 'warning', `Precisión: ±${Math.round(accuracy)}m`);

  // Update position marker
  positionMarker.setLatLng([latitude, longitude]);
  positionMarker.setOpacity(1);
  accuracyCircle.setLatLng([latitude, longitude]);
  accuracyCircle.setRadius(accuracy);
  accuracyCircle.setStyle({ opacity: 0.3, fillOpacity: 0.08 });

  // Filter: discard points with very poor accuracy
  if (accuracy > 100) {
    setStatus(el.statusAccuracy, 'warning', `Precisión: ±${Math.round(accuracy)}m (baja)`);
    return;
  }

  const point = {
    trackId: currentTrackId,
    lat: latitude,
    lng: longitude,
    speed: speed ?? 0,
    accuracy,
    altitude: altitude ?? null,
    timestamp,
  };

  // Calculate distance from last point
  if (lastPoint) {
    const dist = haversineDistance(lastPoint, point);
    // Filter: skip if too close (noise) or impossibly far (GPS jump)
    if (dist < 1 || dist > 500) {
      return;
    }
    totalDist += dist;
  }

  // Save to IndexedDB immediately
  try {
    await addPoint(point);
    pointCount++;
    lastPoint = point;
    allPoints.push(point);

    // Update map
    trackPolyline.addLatLng([latitude, longitude]);
    map.panTo([latitude, longitude], { animate: true, duration: 0.5 });

    // Update metrics
    updateMetrics(point);
    setStatus(el.statusPoints, 'active', `Puntos: ${pointCount}`);
  } catch (err) {
    console.error('[Capture] DB write error:', err);
    setStatus(el.statusDB, 'error', 'DB: Error escritura');
  }
}

function handleGPSError(error) {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      setStatus(el.statusGPS, 'error', 'GPS: Denegado');
      showGPSError('Permiso de ubicación denegado. Habilítalo en la configuración del navegador.');
      break;
    case error.POSITION_UNAVAILABLE:
      setStatus(el.statusGPS, 'warning', 'GPS: Sin señal');
      // Don't stop — keep trying
      break;
    case error.TIMEOUT:
      setStatus(el.statusGPS, 'warning', 'GPS: Timeout');
      // Auto-retry is handled by watchPosition
      break;
    default:
      setStatus(el.statusGPS, 'error', `GPS: Error ${error.code}`);
  }
}

// ── Wake Lock ────────────────────────────────────────────────
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) {
    console.warn('[WakeLock] API not supported');
    return;
  }

  try {
    wakeLock = await navigator.wakeLock.request('screen');
    el.wakeLockBadge.classList.remove('hidden');
    el.wakeLockBadge.className = 'badge badge-success';

    wakeLock.addEventListener('release', () => {
      el.wakeLockBadge.classList.add('hidden');
    });
  } catch (err) {
    console.warn('[WakeLock] Request failed:', err.message);
    el.wakeLockBadge.classList.add('hidden');
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
  el.wakeLockBadge.classList.add('hidden');
}

// ── Metrics Update ───────────────────────────────────────────
function updateMetrics(point) {
  // Current speed (m/s → km/h)
  currentSpeed = (point.speed ?? 0) * 3.6;
  el.metricSpeed.textContent = formatSpeed(currentSpeed);

  // Distance
  el.metricDistance.textContent = (totalDist / 1000).toFixed(2);

  // Average speed
  const elapsed = getElapsedSeconds();
  if (elapsed > 0) {
    const avgKmh = (totalDist / 1000) / (elapsed / 3600);
    el.metricAvgSpeed.textContent = formatSpeed(avgKmh);
  }
}

function updateTimer() {
  el.metricTime.textContent = formatDuration(getElapsedSeconds());
}

function getElapsedSeconds() {
  if (!startTimestamp) return 0;
  const now = currentState === STATE.PAUSED ? pauseStart : Date.now();
  return ((now - startTimestamp - pausedDuration) / 1000);
}

// ── State Management ─────────────────────────────────────────
function setState(state) {
  currentState = state;

  const isIdle = state === STATE.IDLE;
  const isRecording = state === STATE.RECORDING;
  const isPaused = state === STATE.PAUSED;
  const isStopped = state === STATE.STOPPED;

  // Record button
  el.btnRecord.classList.toggle('recording', isRecording);
  el.btnRecord.title = isRecording ? 'Detener Captura' : 'Iniciar Captura';
  el.btnRecord.disabled = isPaused;

  // Pause / Resume
  el.btnPause.disabled = !isRecording;
  el.btnResume.disabled = !isPaused;

  // Download buttons
  el.btnDownloadGPX.disabled = !(isStopped && pointCount > 0);
  el.btnDownloadJSON.disabled = !(isStopped && pointCount > 0);

  // Recording badge
  if (isRecording) {
    el.recordingBadge.classList.remove('hidden');
    el.recordingBadge.classList.add('active');
  } else if (isPaused) {
    el.recordingBadge.classList.remove('hidden', 'active');
  } else {
    el.recordingBadge.classList.add('hidden');
  }

  // Track name input
  el.trackNameInput.disabled = isRecording || isPaused;
}

// ── Downloads ────────────────────────────────────────────────
async function handleDownloadGPX() {
  if (!currentTrackId) return;

  try {
    const points = await getTrackPoints(currentTrackId);
    if (points.length === 0) {
      showToast('No hay puntos para exportar', 'warning');
      return;
    }

    const name = el.trackNameInput.value.trim() || 'Track';
    const gpxString = generateGPX(name, points);
    downloadGPX(gpxString);
    showToast('GPX descargado', 'success');
  } catch (err) {
    console.error('[GPX] Export error:', err);
    showToast('Error generando GPX', 'error');
  }
}

async function handleDownloadJSON() {
  if (!currentTrackId) return;

  try {
    const points = await getTrackPoints(currentTrackId);
    const data = {
      track: {
        id: currentTrackId,
        name: el.trackNameInput.value.trim() || 'Track',
        startTime: startTimestamp,
        endTime: Date.now(),
        totalDistance: totalDist,
        pointCount: points.length,
      },
      points,
    };

    downloadJSON(data);
    showToast('JSON descargado', 'success');
  } catch (err) {
    console.error('[JSON] Export error:', err);
    showToast('Error exportando JSON', 'error');
  }
}

// ── Track History ────────────────────────────────────────────
let historyOpen = false;

async function toggleHistory() {
  historyOpen = !historyOpen;
  const list = el.savedTracksList;

  if (historyOpen) {
    const tracks = await getAllTracks();
    renderTracksList(tracks);
    list.classList.add('open');
  } else {
    list.classList.remove('open');
  }
}

function renderTracksList(tracks) {
  if (tracks.length === 0) {
    el.savedTracksList.innerHTML = `
      <div class="empty-state" style="padding:var(--sp-xl);">
        <p class="text-sm text-muted">No hay recorridos guardados</p>
      </div>`;
    return;
  }

  el.savedTracksList.innerHTML = tracks.map((t) => `
    <div class="saved-track-item" data-id="${t.id}">
      <div class="track-info">
        <span class="track-title">${t.name}</span>
        <span class="track-meta">
          ${new Date(t.startTime).toLocaleString('es')} · ${t.pointCount || 0} pts · ${t.status}
        </span>
      </div>
      <div class="btn-group">
        <button class="btn btn-sm btn-secondary" onclick="loadTrack('${t.id}')" title="Ver en mapa">👁</button>
        <button class="btn btn-sm btn-danger" onclick="removeTrack('${t.id}')" title="Eliminar">✕</button>
      </div>
    </div>
  `).join('');
}

// Global functions for inline handlers
window.loadTrack = async function(trackId) {
  try {
    const points = await getTrackPoints(trackId);
    if (points.length === 0) {
      showToast('Track sin puntos', 'warning');
      return;
    }

    const latlngs = points.map((p) => [p.lat, p.lng]);
    trackPolyline.setLatLngs(latlngs);
    map.fitBounds(trackPolyline.getBounds(), { padding: [40, 40] });
    showToast(`Track cargado: ${points.length} puntos`, 'success');
  } catch (err) {
    showToast('Error cargando track', 'error');
  }
};

window.removeTrack = async function(trackId) {
  if (!confirm('¿Eliminar este recorrido?')) return;

  try {
    await deleteTrack(trackId);
    const tracks = await getAllTracks();
    renderTracksList(tracks);
    showToast('Recorrido eliminado', 'success');
  } catch (err) {
    showToast('Error eliminando track', 'error');
  }
};

window.requestGPS = function() {
  hideGPSError();
  getInitialPosition();
};

// ── UI Helpers ───────────────────────────────────────────────
function setStatus(element, state, text) {
  element.className = `status-item ${state}`;
  element.querySelector('span').textContent = text;
}

function showGPSError(message) {
  el.gpsErrorMessage.textContent = message;
  el.gpsErrorOverlay.classList.remove('hidden');
}

function hideGPSError() {
  el.gpsErrorOverlay.classList.add('hidden');
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
