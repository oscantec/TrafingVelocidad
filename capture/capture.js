/**
 * Softrafing Velocidades — Capture Module
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
let currentTrackName = '';
let watchId = null;
let wakeLock = null;
let timerInterval = null;
let startTimestamp = null;
let pausedDuration = 0;
let pauseStart = null;
let hiddenSince = null;

// Live data
let pointCount = 0;
let totalDist = 0;
let lastPoint = null;
let currentSpeed = 0;
let allPoints = [];

// Leaflet
let map = null;
let positionMarker = null;
let accuracyCircle = null;
let trackPolyline = null;

// Theme accent
const ACCENT = '#F05A1A';

// ── DOM Elements ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const el = {
  btnRecord: $('btnRecord'),
  btnPause: $('btnPause'),
  btnResume: $('btnResume'),
  btnDownloadGPX: $('btnDownloadGPX'),
  btnDownloadJSON: $('btnDownloadJSON'),
  btnHistory: $('btnHistory'),
  btnBackHome: $('btnBackHome'),
  currentTrackName: $('currentTrackName'),
  recordingBadge: $('recordingBadge'),
  wakeLockBadge: $('wakeLockBadge'),
  bgWarningBanner: $('bgWarningBanner'),
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
  startModal: $('startModal'),
  modalTrackName: $('modalTrackName'),
  modalStart: $('modalStart'),
  modalCancel: $('modalCancel'),
  stopModal: $('stopModal'),
  stopConfirm: $('stopConfirm'),
  stopCancel: $('stopCancel'),
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
    center: [4.6097, -74.0817],
    zoom: 15,
    zoomControl: true,
    attributionControl: true,
  });

  // Light tile layer (matches theme)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(map);

  trackPolyline = L.polyline([], {
    color: ACCENT,
    weight: 4,
    opacity: 0.9,
    smoothFactor: 1,
  }).addTo(map);

  const pulseIcon = L.divIcon({
    className: '',
    html: `<div style="
      width: 18px; height: 18px;
      background: ${ACCENT};
      border: 3px solid #fff;
      border-radius: 50%;
      box-shadow: 0 0 0 4px rgba(240,90,26,0.2), 0 2px 8px rgba(15,23,42,0.25);
    "></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });

  positionMarker = L.marker([0, 0], { icon: pulseIcon }).addTo(map);
  positionMarker.setOpacity(0);

  accuracyCircle = L.circle([0, 0], {
    radius: 0,
    color: ACCENT,
    fillColor: ACCENT,
    fillOpacity: 0.08,
    weight: 1,
    opacity: 0.3,
  }).addTo(map);
  accuracyCircle.setStyle({ opacity: 0, fillOpacity: 0 });

  setTimeout(() => map.invalidateSize(), 100);
}

// ── GPS Permission / Environment Check ───────────────────────
async function checkGPSPermission() {
  // Protocol / secure context diagnostics
  if (location.protocol === 'file:') {
    setStatus(el.statusGPS, 'error', 'GPS: No disponible (file://)');
    showGPSError(
      'Esta app está abierta como archivo local (file://). Los navegadores bloquean el GPS en este modo. ' +
      'Sirve la app por HTTPS o ejecuta un servidor local (p. ej. "python3 -m http.server 8000" y abre http://localhost:8000).'
    );
    return;
  }

  if (!window.isSecureContext) {
    setStatus(el.statusGPS, 'error', 'GPS: Contexto no seguro');
    showGPSError(
      'El GPS requiere HTTPS o localhost. Carga la app a través de un dominio con certificado SSL.'
    );
    return;
  }

  if (!('geolocation' in navigator)) {
    setStatus(el.statusGPS, 'error', 'GPS: No soportado');
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
        // Trigger prompt by requesting a position immediately
        getInitialPosition();
      } else {
        setStatus(el.statusGPS, 'error', 'GPS: Denegado');
        showGPSError(
          'El permiso de ubicación fue denegado. En macOS: revisa Ajustes del Sistema → Privacidad y Seguridad → Servicios de localización, y habilítalo también para tu navegador.'
        );
      }

      result.addEventListener('change', () => {
        if (result.state === 'granted') {
          hideGPSError();
          setStatus(el.statusGPS, 'active', 'GPS: Listo');
          getInitialPosition();
        } else if (result.state === 'denied') {
          setStatus(el.statusGPS, 'error', 'GPS: Denegado');
        }
      });
    } else {
      getInitialPosition();
    }
  } catch {
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
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
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

  // Back to home with confirmation when recording
  el.btnBackHome.addEventListener('click', (e) => {
    if (currentState === STATE.RECORDING || currentState === STATE.PAUSED) {
      e.preventDefault();
      const ok = confirm('Hay una captura en curso. ¿Detener y volver al menú principal?');
      if (!ok) return;
      stopRecording().finally(() => { location.href = '../index.html'; });
    }
  });

  // Modal: Start
  el.modalStart.addEventListener('click', async () => {
    const name = el.modalTrackName.value.trim();
    if (!name) {
      el.modalTrackName.focus();
      el.modalTrackName.style.borderColor = 'var(--danger)';
      setTimeout(() => { el.modalTrackName.style.borderColor = ''; }, 1500);
      return;
    }
    closeStartModal();
    await startRecording(name);
  });
  el.modalCancel.addEventListener('click', closeStartModal);
  el.startModal.addEventListener('click', (e) => {
    if (e.target === el.startModal) closeStartModal();
  });
  el.modalTrackName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.modalStart.click();
    if (e.key === 'Escape') closeStartModal();
  });

  // Modal: Stop confirm
  el.stopConfirm.addEventListener('click', async () => {
    closeStopModal();
    await stopRecording();
  });
  el.stopCancel.addEventListener('click', closeStopModal);
  el.stopModal.addEventListener('click', (e) => {
    if (e.target === el.stopModal) closeStopModal();
  });

  // Visibility / background handling
  document.addEventListener('visibilitychange', handleVisibilityChange);

  // Warn before closing during recording
  window.addEventListener('beforeunload', (e) => {
    if (currentState === STATE.RECORDING) {
      e.preventDefault();
      e.returnValue = 'Hay un recorrido en progreso. ¿Seguro que deseas salir?';
    }
  });
}

// ── Visibility / Background ──────────────────────────────────
async function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    if (currentState === STATE.RECORDING) {
      hiddenSince = Date.now();
    }
  } else if (document.visibilityState === 'visible') {
    if (currentState === STATE.RECORDING) {
      // Re-acquire wake lock (released automatically on hide)
      await acquireWakeLock();
      el.bgWarningBanner.classList.remove('active');

      if (hiddenSince) {
        const gapMs = Date.now() - hiddenSince;
        hiddenSince = null;
        if (gapMs > 8000) {
          const sec = Math.round(gapMs / 1000);
          showToast(
            `La app estuvo en segundo plano ${sec}s — puede que falten puntos en ese intervalo.`,
            'warning', 6000
          );
        }
      }
    }
  }
}

// ── Recording Controls ───────────────────────────────────────
function handleRecord() {
  if (currentState === STATE.IDLE || currentState === STATE.STOPPED) {
    openStartModal();
  } else if (currentState === STATE.RECORDING) {
    openStopModal();
  }
}

function openStartModal() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const defaultName = `Recorrido ${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  el.modalTrackName.value = defaultName;
  el.startModal.classList.add('active');
  setTimeout(() => { el.modalTrackName.focus(); el.modalTrackName.select(); }, 80);
}

function closeStartModal() {
  el.startModal.classList.remove('active');
}

function openStopModal() {
  el.stopModal.classList.add('active');
}

function closeStopModal() {
  el.stopModal.classList.remove('active');
}

async function startRecording(name) {
  try {
    currentTrackName = name;
    currentTrackId = await createTrack({
      name,
      startTime: Date.now(),
      status: 'recording',
    });

    pointCount = 0;
    totalDist = 0;
    lastPoint = null;
    currentSpeed = 0;
    allPoints = [];
    pausedDuration = 0;
    startTimestamp = Date.now();

    trackPolyline.setLatLngs([]);

    // Reset metrics display
    el.metricSpeed.textContent = '0.0';
    el.metricDistance.textContent = '0.00';
    el.metricTime.textContent = '00:00:00';
    el.metricAvgSpeed.textContent = '0.0';
    el.currentTrackName.textContent = name;
    el.currentTrackName.title = name;

    startWatching();
    await acquireWakeLock();

    timerInterval = setInterval(updateTimer, 1000);

    setState(STATE.RECORDING);
    el.bgWarningBanner.classList.add('active');
    showToast(`Captura iniciada: ${name}`, 'success');
  } catch (err) {
    console.error('[Capture] Start error:', err);
    showToast('Error al iniciar captura', 'error');
  }
}

async function stopRecording() {
  stopWatching();
  releaseWakeLock();

  clearInterval(timerInterval);
  timerInterval = null;

  if (currentTrackId) {
    await updateTrack(currentTrackId, {
      endTime: Date.now(),
      status: 'completed',
      pointCount,
    });
  }

  setState(STATE.STOPPED);
  el.bgWarningBanner.classList.remove('active');
  showToast(`Captura finalizada · ${pointCount} puntos`, 'success');

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
      timeout: 20000,
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

  setStatus(el.statusGPS, 'active', 'GPS: Activo');
  setStatus(el.statusAccuracy, accuracy <= 20 ? 'active' : 'warning', `Precisión: ±${Math.round(accuracy)}m`);

  positionMarker.setLatLng([latitude, longitude]);
  positionMarker.setOpacity(1);
  accuracyCircle.setLatLng([latitude, longitude]);
  accuracyCircle.setRadius(accuracy);
  accuracyCircle.setStyle({ opacity: 0.3, fillOpacity: 0.08 });

  if (accuracy > 100) {
    setStatus(el.statusAccuracy, 'warning', `Precisión: ±${Math.round(accuracy)}m (baja)`);
    return;
  }

  // Only persist while actually recording
  if (currentState !== STATE.RECORDING) return;

  const point = {
    trackId: currentTrackId,
    lat: latitude,
    lng: longitude,
    speed: speed ?? 0,
    accuracy,
    altitude: altitude ?? null,
    timestamp,
  };

  if (lastPoint) {
    const dist = haversineDistance(lastPoint, point);
    if (dist < 1 || dist > 500) return;
    totalDist += dist;
  }

  try {
    await addPoint(point);
    pointCount++;
    lastPoint = point;
    allPoints.push(point);

    trackPolyline.addLatLng([latitude, longitude]);
    if (document.visibilityState === 'visible') {
      map.panTo([latitude, longitude], { animate: true, duration: 0.5 });
    }

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
      showGPSError(
        'Permiso de ubicación denegado. En macOS: Ajustes del Sistema → Privacidad y Seguridad → Servicios de localización → activa el servicio y el permiso para tu navegador. Luego recarga la página.'
      );
      break;
    case error.POSITION_UNAVAILABLE:
      setStatus(el.statusGPS, 'warning', 'GPS: Sin señal');
      break;
    case error.TIMEOUT:
      setStatus(el.statusGPS, 'warning', 'GPS: Timeout');
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
  currentSpeed = (point.speed ?? 0) * 3.6;
  el.metricSpeed.textContent = formatSpeed(currentSpeed);

  el.metricDistance.textContent = (totalDist / 1000).toFixed(2);

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

  el.btnRecord.classList.toggle('recording', isRecording);
  el.btnRecord.title = isRecording ? 'Detener Captura' : 'Iniciar Captura';
  el.btnRecord.disabled = isPaused;

  el.btnPause.disabled = !isRecording;
  el.btnResume.disabled = !isPaused;

  el.btnDownloadGPX.disabled = !(isStopped && pointCount > 0);
  el.btnDownloadJSON.disabled = !(isStopped && pointCount > 0);

  if (isRecording) {
    el.recordingBadge.classList.remove('hidden');
    el.recordingBadge.classList.add('active');
  } else if (isPaused) {
    el.recordingBadge.classList.remove('hidden', 'active');
  } else {
    el.recordingBadge.classList.add('hidden');
  }
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

    const gpxString = generateGPX(currentTrackName || 'Track', points);
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
        name: currentTrackName || 'Track',
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
        <span class="track-title">${escapeHtml(t.name)}</span>
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
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

function showToast(message, type = 'info', durationMs = 3000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  el.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s, transform 0.3s';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(60px)';
    setTimeout(() => toast.remove(), 300);
  }, durationMs);
}

// ── Service Worker Registration ──────────────────────────────
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('../sw.js').catch((err) => {
    console.warn('[SW] Registration failed:', err);
  });
}

// ── Boot ─────────────────────────────────────────────────────
init();
