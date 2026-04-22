/**
 * Softrafing Velocidades — Playback Panel (compact)
 * Stat cards (Tiempo / Distancia / Velocidad / Elevación / Pendiente),
 * a small dual-axis chart and Play / Pause / Stop transport controls.
 */

import { haversineDistance } from '../lib/geo.js';

const ACCENT = '#F05A1A';
const BLUE   = '#3B82F6';
const GREEN  = '#22C55E';
const RED    = '#DC2626';

const $ = (id) => document.getElementById(id);

const el = {
  panel:       $('playbackPanel'),
  speedSelect: $('pbSpeed'),
  btnPlay:     $('pbPlay'),
  btnPause:    $('pbPause'),
  btnStop:     $('pbStop'),
  idxLabel:    $('pbIndex'),
  totalLabel:  $('pbTotal'),
  tsLabel:     $('pbTimestamp'),
  chartCanvas: $('playbackChart'),
};

function stat(metric) {
  const card = el.panel.querySelector(`.pb-stat[data-metric="${metric}"]`);
  return {
    card,
    value: card.querySelector('[data-value]'),
    min:   card.querySelector('[data-min]'),
    max:   card.querySelector('[data-max]'),
    fill:  card.querySelector('[data-fill]'),
  };
}

let s = null;          // stat handles, set after panel exists
let state = {
  points: [], meta: null,
  idx: 0, timer: null, playing: false,
  map: null, marker: null, startMarker: null, endMarker: null,
  chart: null,
};

// ─────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────
export function initPlayback(map) {
  state.map = map;
  s = {
    time:     stat('time'),
    distance: stat('distance'),
    speed:    stat('speed'),
  };

  el.btnPlay.addEventListener('click',  play);
  el.btnPause.addEventListener('click', pause);
  el.btnStop.addEventListener('click',  stop);
  el.speedSelect.addEventListener('change', () => {
    if (state.playing) { pause(); play(); }
  });

  // Resize chart / map when the panel visibility flips
  const ro = new ResizeObserver(() => {
    if (state.map) state.map.invalidateSize();
    if (state.chart) state.chart.resize();
  });
  ro.observe(el.panel);
}

export function loadPlaybackTrack(points) {
  stop();
  state.points = points || [];
  el.panel.classList.toggle('active', state.points.length > 0);
  if (state.points.length === 0) return;

  state.meta = computeMeta(state.points);

  s.time.max.textContent     = formatDuration(state.meta.totalMs / 1000);
  s.distance.max.textContent = state.meta.totalKm.toFixed(3);
  s.speed.max.textContent    = state.meta.maxSpeed.toFixed(1);

  el.totalLabel.textContent = state.points.length;

  setupMapMarkers();
  // Defer chart to next frame so layout is settled and the canvas has its final size
  requestAnimationFrame(() => {
    rebuildChart();
    seek(0);
  });

  el.btnPlay.disabled  = false;
  el.btnPause.disabled = true;
  el.btnStop.disabled  = true;

  // Let Leaflet recalc now that the layout might have changed
  setTimeout(() => state.map && state.map.invalidateSize(), 50);
}

// ─────────────────────────────────────────────────────────
//  Meta
// ─────────────────────────────────────────────────────────
function computeMeta(points) {
  let totalDist = 0;
  let minEle = Infinity, maxEle = -Infinity;
  let minGrade = Infinity, maxGrade = -Infinity;
  let maxSpeed = 0;

  const cumDist = [0];
  const gradesPct = [0];
  const speedsKmh = [];

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const eleVal = Number.isFinite(p.altitude) ? p.altitude : null;
    if (eleVal != null) {
      if (eleVal < minEle) minEle = eleVal;
      if (eleVal > maxEle) maxEle = eleVal;
    }

    const kmh = (p.speed != null) ? Math.max(0, p.speed * 3.6) : null;
    speedsKmh.push(kmh);
    if (kmh != null && kmh > maxSpeed) maxSpeed = kmh;

    if (i > 0) {
      const d = haversineDistance(points[i-1], p);
      totalDist += d;
      cumDist.push(totalDist);

      const prevEle = Number.isFinite(points[i-1].altitude) ? points[i-1].altitude : null;
      if (eleVal != null && prevEle != null && d > 0.5) {
        const grade = ((eleVal - prevEle) / d) * 100;
        gradesPct.push(grade);
        if (grade < minGrade) minGrade = grade;
        if (grade > maxGrade) maxGrade = grade;
      } else {
        gradesPct.push(0);
      }
    }
  }

  const totalMs = Math.max(0, points[points.length - 1].timestamp - points[0].timestamp);

  if (!Number.isFinite(minEle)) minEle = 0;
  if (!Number.isFinite(maxEle)) maxEle = 0;
  if (!Number.isFinite(minGrade)) minGrade = -1;
  if (!Number.isFinite(maxGrade)) maxGrade =  1;
  if (maxSpeed === 0) maxSpeed = 1;

  return { totalKm: totalDist / 1000, totalMs, minEle, maxEle, minGrade, maxGrade, maxSpeed, cumDist, gradesPct, speedsKmh };
}

// ─────────────────────────────────────────────────────────
//  Stat helpers
// ─────────────────────────────────────────────────────────
function setStat(handle, value, percent01) {
  handle.value.textContent = value;
  const p = Math.max(0, Math.min(1, percent01 || 0));
  handle.fill.style.width = (p * 100).toFixed(1) + '%';
}

// ─────────────────────────────────────────────────────────
//  Map markers
// ─────────────────────────────────────────────────────────
function makeDotIcon(color, size = 14, ring = 3) {
  return L.divIcon({
    className: '',
    html: `<div style="
      width:${size}px;height:${size}px;background:${color};
      border:${ring}px solid #fff;border-radius:50%;
      box-shadow:0 0 0 1px rgba(15,23,42,0.25), 0 2px 6px rgba(15,23,42,0.25);
    "></div>`,
    iconSize: [size + ring * 2, size + ring * 2],
    iconAnchor: [(size + ring * 2) / 2, (size + ring * 2) / 2],
  });
}

function makeVehicleIcon() {
  // Pulsing red dot with a subtle ring — 'vehículo' marker
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:22px;height:22px;">
      <div style="
        position:absolute;inset:3px;background:${RED};
        border:3px solid #fff;border-radius:50%;
        box-shadow:0 0 0 1px rgba(15,23,42,0.25), 0 2px 8px rgba(220,38,38,0.55);
      "></div>
      <div style="
        position:absolute;inset:0;border-radius:50%;
        background:${RED};opacity:0.3;
        animation:pulse-ring 1.6s ease-out infinite;
      "></div>
    </div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function makeFinishFlagIcon() {
  // SVG checkered flag — F1 finish line style
  const svg = `
    <svg width="28" height="32" viewBox="0 0 28 32" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="2" height="28" fill="#0F172A"/>
      <g transform="translate(4,2)">
        <rect x="0" y="0" width="22" height="14" fill="#FFFFFF" stroke="#0F172A" stroke-width="0.8"/>
        <rect x="0"  y="0"  width="5.5" height="3.5" fill="#0F172A"/>
        <rect x="11" y="0"  width="5.5" height="3.5" fill="#0F172A"/>
        <rect x="5.5" y="3.5" width="5.5" height="3.5" fill="#0F172A"/>
        <rect x="16.5" y="3.5" width="5.5" height="3.5" fill="#0F172A"/>
        <rect x="0"  y="7"  width="5.5" height="3.5" fill="#0F172A"/>
        <rect x="11" y="7"  width="5.5" height="3.5" fill="#0F172A"/>
        <rect x="5.5" y="10.5" width="5.5" height="3.5" fill="#0F172A"/>
        <rect x="16.5" y="10.5" width="5.5" height="3.5" fill="#0F172A"/>
      </g>
    </svg>`;
  return L.divIcon({
    className: '',
    html: svg,
    iconSize: [28, 32],
    iconAnchor: [3, 30],  // pole base touches the point
  });
}

function setupMapMarkers() {
  const first = state.points[0];
  const last  = state.points[state.points.length - 1];

  if (state.startMarker) state.startMarker.remove();
  if (state.endMarker)   state.endMarker.remove();
  if (state.marker)      state.marker.remove();

  state.startMarker = L.marker([first.lat, first.lng], { icon: makeDotIcon(GREEN), zIndexOffset: 500 })
    .addTo(state.map).bindTooltip('Inicio');
  state.endMarker = L.marker([last.lat, last.lng], { icon: makeFinishFlagIcon(), zIndexOffset: 500 })
    .addTo(state.map).bindTooltip('Meta');
  state.marker = L.marker([first.lat, first.lng], { icon: makeVehicleIcon(), zIndexOffset: 1000 })
    .addTo(state.map);
}

// ─────────────────────────────────────────────────────────
//  Chart (compact)
// ─────────────────────────────────────────────────────────
function rebuildChart() {
  if (!window.Chart) return;

  if (state.chart) { state.chart.destroy(); state.chart = null; }

  const t0 = state.points[0].timestamp;
  const labels = state.points.map(p => (p.timestamp - t0) / 1000);
  const speeds = state.meta.speedsKmh;

  state.chart = new window.Chart(el.chartCanvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Velocidad (km/h)', data: speeds, borderColor: BLUE,
          backgroundColor: 'rgba(59,130,246,0.12)',
          fill: true, yAxisID: 'y', pointRadius: 0, borderWidth: 1.5,
          tension: 0.25, spanGaps: true },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      onHover: (event, activeElements) => {
        if (activeElements && activeElements.length) {
          const idx = activeElements[0].index;
          if (state.playing) pause();
          if (idx !== state.idx) seek(idx);
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.9)', titleFont: { size: 10 }, bodyFont: { size: 10 },
          callbacks: {
            title: (items) => `t+${formatDuration(items[0].parsed.x)}`,
            label: (i) => `${i.parsed.y?.toFixed?.(1) ?? '—'} km/h`,
          },
        },
      },
      scales: {
        x: { type: 'linear', ticks: { font: { size: 10 }, maxTicksLimit: 6, callback: (v) => formatDurationShort(v) },
          grid: { color: 'rgba(148,163,184,0.12)' } },
        y: { position: 'left', ticks: { color: BLUE, font: { size: 10 } },
             grid: { color: 'rgba(148,163,184,0.12)' }, beginAtZero: true },
      },
    },
    plugins: [verticalLinePlugin()],
  });

  // Touch scrubbing on mobile — Chart.js' onHover sometimes misses touchmove
  el.chartCanvas.style.touchAction = 'none';
  el.chartCanvas.addEventListener('touchmove',  handleTouchScrub, { passive: false });
  el.chartCanvas.addEventListener('touchstart', handleTouchScrub, { passive: false });
}

function handleTouchScrub(ev) {
  if (!state.chart || !state.points.length) return;
  ev.preventDefault();
  const touch = ev.touches[0];
  if (!touch) return;
  const rect = el.chartCanvas.getBoundingClientRect();
  const xPx = touch.clientX - rect.left;
  const t0 = state.points[0].timestamp;
  const totalS = (state.points[state.points.length - 1].timestamp - t0) / 1000;
  const xScale = state.chart.scales.x;
  let sec = xScale.getValueForPixel(xPx);
  if (sec == null || isNaN(sec)) return;
  sec = Math.max(0, Math.min(totalS, sec));

  // Binary search for the closest point by timestamp offset
  let lo = 0, hi = state.points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const ts = (state.points[mid].timestamp - t0) / 1000;
    if (ts < sec) lo = mid + 1; else hi = mid;
  }
  if (state.playing) pause();
  if (lo !== state.idx) seek(lo);
}

function verticalLinePlugin() {
  return {
    id: 'playback-cursor',
    afterDatasetsDraw(chart) {
      if (state.idx == null || !state.points.length) return;
      const t = (state.points[state.idx].timestamp - state.points[0].timestamp) / 1000;
      const x = chart.scales.x.getPixelForValue(t);
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.restore();
    },
  };
}

// ─────────────────────────────────────────────────────────
//  Transport
// ─────────────────────────────────────────────────────────
function play() {
  if (state.points.length === 0) return;
  if (state.idx >= state.points.length - 1) state.idx = 0;
  state.playing = true;
  el.btnPlay.classList.add('active');
  el.btnPause.classList.remove('active');
  el.btnPlay.disabled  = true;
  el.btnPause.disabled = false;
  el.btnStop.disabled  = false;

  const delay = parseInt(el.speedSelect.value, 10) || 300;
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (state.idx >= state.points.length - 1) { pause(); return; }
    seek(state.idx + 1);
  }, delay);
}

function pause() {
  state.playing = false;
  clearInterval(state.timer);
  state.timer = null;
  el.btnPlay.classList.remove('active');
  el.btnPause.classList.add('active');
  el.btnPlay.disabled  = false;
  el.btnPause.disabled = true;
}

function stop() {
  pause();
  el.btnPause.classList.remove('active');
  if (state.points.length) seek(0);
  el.btnStop.disabled = true;
}

function seek(i) {
  state.idx = Math.max(0, Math.min(state.points.length - 1, i));
  const p = state.points[state.idx];
  if (!p) return;

  if (state.marker) state.marker.setLatLng([p.lat, p.lng]);

  el.idxLabel.textContent = state.idx + 1;
  el.tsLabel.textContent = fmtDateTime(p.timestamp);

  const m = state.meta;
  const t0 = state.points[0].timestamp;
  const elapsedMs = Math.max(0, p.timestamp - t0);

  setStat(s.time,
    formatDuration(elapsedMs / 1000),
    m.totalMs > 0 ? elapsedMs / m.totalMs : 0);

  const km = (m.cumDist[state.idx] || 0) / 1000;
  setStat(s.distance, km.toFixed(3),
    m.totalKm > 0 ? km / m.totalKm : 0);

  const kmh = m.speedsKmh[state.idx] ?? 0;
  setStat(s.speed, (kmh ?? 0).toFixed(1),
    m.maxSpeed > 0 ? (kmh || 0) / m.maxSpeed : 0);

  if (state.chart) state.chart.update('none');
}

// ─────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────
function formatDuration(totalSeconds) {
  const s = Math.floor(totalSeconds % 60);
  const m = Math.floor((totalSeconds / 60) % 60);
  const h = Math.floor(totalSeconds / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function formatDurationShort(sec) {
  if (sec < 60) return `${Math.floor(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
