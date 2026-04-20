/**
 * Softrafing Velocidades — Playback Panel
 * Gauges (time/distance/speed/elevation/grade), chart, play/pause/stop
 * controls plus a moving map marker along a loaded track.
 */

import { haversineDistance } from '../lib/geo.js';

const ACCENT = '#F05A1A';
const BLUE = '#3B82F6';
const GREEN = '#22C55E';

const ARC_LENGTH = 125.66;  // ≈ π·40 — matches stroke-dasharray on gauges

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
  gauges: {
    time:      $('gauge-time'),
    distance:  $('gauge-distance'),
    speed:     $('gauge-speed'),
    elevation: $('gauge-elevation'),
    grade:     $('gauge-grade'),
  },
};

let state = {
  points: [],
  meta: null,        // computed bounds
  idx: 0,
  timer: null,
  playing: false,
  map: null,
  marker: null,
  popup: null,
  startMarker: null,
  endMarker: null,
  chart: null,
  verticalLine: null,
};

// ─────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────
export function initPlayback(map) {
  state.map = map;

  el.btnPlay.addEventListener('click',  play);
  el.btnPause.addEventListener('click', pause);
  el.btnStop.addEventListener('click',  stop);
  el.speedSelect.addEventListener('change', () => {
    if (state.playing) { pause(); play(); }  // restart timer at new speed
  });
}

export function loadPlaybackTrack(points) {
  stop();
  state.points = points || [];
  el.panel.classList.toggle('active', state.points.length > 0);
  if (state.points.length === 0) return;

  state.meta = computeMeta(state.points);

  setGaugeRange(el.gauges.time,      '00:00:00',                   formatDuration(state.meta.totalMs / 1000));
  setGaugeRange(el.gauges.distance,  '0',                           state.meta.totalKm.toFixed(3));
  setGaugeRange(el.gauges.speed,     '0',                           state.meta.maxSpeed.toFixed(2));
  setGaugeRange(el.gauges.elevation, state.meta.minEle.toFixed(0),  state.meta.maxEle.toFixed(0));
  setGaugeRange(el.gauges.grade,     state.meta.minGrade.toFixed(1),state.meta.maxGrade.toFixed(1));

  el.totalLabel.textContent = state.points.length;

  setupMapMarkers();
  rebuildChart();
  seek(0);

  el.btnPlay.disabled  = false;
  el.btnPause.disabled = true;
  el.btnStop.disabled  = true;
}

// ─────────────────────────────────────────────────────────
//  Meta computation (done once per track)
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

    const speedKmh = (p.speed != null) ? Math.max(0, p.speed * 3.6) : null;
    if (speedKmh != null) {
      speedsKmh.push(speedKmh);
      if (speedKmh > maxSpeed) maxSpeed = speedKmh;
    } else {
      speedsKmh.push(null);
    }

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

  const t0 = points[0].timestamp;
  const tN = points[points.length - 1].timestamp;
  const totalMs = Math.max(0, tN - t0);

  if (!Number.isFinite(minEle)) minEle = 0;
  if (!Number.isFinite(maxEle)) maxEle = 0;
  if (!Number.isFinite(minGrade)) minGrade = -1;
  if (!Number.isFinite(maxGrade)) maxGrade =  1;
  if (maxSpeed === 0) maxSpeed = 1;

  return {
    totalKm: totalDist / 1000,
    totalMs,
    minEle, maxEle,
    minGrade, maxGrade,
    maxSpeed,
    cumDist,
    gradesPct,
    speedsKmh,
  };
}

// ─────────────────────────────────────────────────────────
//  Gauges
// ─────────────────────────────────────────────────────────
function setGaugeRange(gaugeEl, min, max) {
  gaugeEl.querySelector('[data-min]').textContent = min;
  gaugeEl.querySelector('[data-max]').textContent = max;
}

function setGaugeValue(gaugeEl, text, percent01) {
  gaugeEl.querySelector('[data-value]').textContent = text;
  const fg = gaugeEl.querySelector('.arc-fg');
  const p = Math.max(0, Math.min(1, percent01));
  fg.setAttribute('stroke-dashoffset', String(ARC_LENGTH * (1 - p)));
}

// ─────────────────────────────────────────────────────────
//  Map markers
// ─────────────────────────────────────────────────────────
function makeDotIcon(color, size = 16, ring = 3) {
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

function setupMapMarkers() {
  const first = state.points[0];
  const last  = state.points[state.points.length - 1];

  if (state.startMarker) state.startMarker.remove();
  if (state.endMarker)   state.endMarker.remove();
  if (state.marker)      state.marker.remove();

  state.startMarker = L.marker([first.lat, first.lng], { icon: makeDotIcon(GREEN, 14, 3), zIndexOffset: 500 }).addTo(state.map)
    .bindTooltip('Inicio', { permanent: false });
  state.endMarker = L.marker([last.lat,  last.lng],  { icon: makeDotIcon('#DC2626', 14, 3), zIndexOffset: 500 }).addTo(state.map)
    .bindTooltip('Fin', { permanent: false });
  state.marker = L.marker([first.lat, first.lng], { icon: makeDotIcon(ACCENT, 18, 4), zIndexOffset: 1000 }).addTo(state.map);
}

// ─────────────────────────────────────────────────────────
//  Chart
// ─────────────────────────────────────────────────────────
function rebuildChart() {
  if (!window.Chart) return;

  if (state.chart) { state.chart.destroy(); state.chart = null; }

  const t0 = state.points[0].timestamp;
  const labels = state.points.map(p => (p.timestamp - t0) / 1000);  // seconds
  const speeds = state.meta.speedsKmh;
  const eles   = state.points.map(p => Number.isFinite(p.altitude) ? p.altitude : null);

  state.chart = new window.Chart(el.chartCanvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Velocidad',
          data: speeds,
          borderColor: BLUE,
          backgroundColor: 'rgba(59,130,246,0.12)',
          fill: true,
          yAxisID: 'y',
          pointRadius: 0,
          borderWidth: 1.5,
          tension: 0.25,
          spanGaps: true,
        },
        {
          label: 'Elevación',
          data: eles,
          borderColor: GREEN,
          backgroundColor: 'rgba(34,197,94,0.10)',
          fill: true,
          yAxisID: 'y1',
          pointRadius: 0,
          borderWidth: 1.5,
          tension: 0.25,
          spanGaps: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 } },
        },
        tooltip: {
          callbacks: {
            title: (items) => `t+${formatDuration(items[0].parsed.x)}`,
            label: (i) => `${i.dataset.label}: ${i.parsed.y?.toFixed?.(2) ?? '—'} ${i.datasetIndex === 0 ? 'km/h' : 'm'}`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Tiempo (s)', font: { size: 10 } },
          ticks: { font: { size: 10 }, maxTicksLimit: 8, callback: (v) => formatDurationShort(v) },
          grid: { color: 'rgba(148,163,184,0.15)' },
        },
        y: {
          position: 'left',
          title: { display: true, text: 'Velocidad km/h', color: BLUE, font: { size: 10 } },
          grid: { color: 'rgba(148,163,184,0.15)' },
          ticks: { color: BLUE, font: { size: 10 } },
          beginAtZero: true,
        },
        y1: {
          position: 'right',
          title: { display: true, text: 'Elevación m', color: GREEN, font: { size: 10 } },
          grid: { drawOnChartArea: false },
          ticks: { color: GREEN, font: { size: 10 } },
        },
      },
    },
    plugins: [verticalLinePlugin()],
  });
}

// Chart.js plugin — vertical line at the current playback index
function verticalLinePlugin() {
  return {
    id: 'playback-cursor',
    afterDatasetsDraw(chart) {
      if (state.idx == null || !state.points.length) return;
      const x = chart.scales.x.getPixelForValue((state.points[state.idx].timestamp - state.points[0].timestamp) / 1000);
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.restore();
    },
  };
}

// ─────────────────────────────────────────────────────────
//  Transport controls
// ─────────────────────────────────────────────────────────
function play() {
  if (state.points.length === 0) return;
  if (state.idx >= state.points.length - 1) state.idx = 0;
  state.playing = true;
  el.btnPlay.disabled  = true;
  el.btnPause.disabled = false;
  el.btnStop.disabled  = false;

  const delay = parseInt(el.speedSelect.value, 10) || 300;
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (state.idx >= state.points.length - 1) {
      pause();
      return;
    }
    seek(state.idx + 1);
  }, delay);
}

function pause() {
  state.playing = false;
  clearInterval(state.timer);
  state.timer = null;
  el.btnPlay.disabled  = false;
  el.btnPause.disabled = true;
}

function stop() {
  pause();
  seek(0);
  el.btnStop.disabled = true;
}

function seek(i) {
  state.idx = Math.max(0, Math.min(state.points.length - 1, i));
  const p = state.points[state.idx];
  if (!p) return;

  // Marker
  if (state.marker) state.marker.setLatLng([p.lat, p.lng]);

  // Labels
  el.idxLabel.textContent = state.idx + 1;
  el.tsLabel.textContent = fmtDateTime(p.timestamp);

  // Gauges
  const m = state.meta;
  const t0 = state.points[0].timestamp;
  const tElapsedMs = Math.max(0, p.timestamp - t0);

  setGaugeValue(el.gauges.time,
    formatDuration(tElapsedMs / 1000),
    m.totalMs > 0 ? tElapsedMs / m.totalMs : 0);

  const km = (m.cumDist[state.idx] || 0) / 1000;
  setGaugeValue(el.gauges.distance,
    km.toFixed(3),
    m.totalKm > 0 ? km / m.totalKm : 0);

  const kmh = m.speedsKmh[state.idx] ?? 0;
  setGaugeValue(el.gauges.speed,
    (kmh ?? 0).toFixed(2),
    m.maxSpeed > 0 ? (kmh || 0) / m.maxSpeed : 0);

  const ele = Number.isFinite(p.altitude) ? p.altitude : m.minEle;
  setGaugeValue(el.gauges.elevation,
    ele.toFixed(1),
    (m.maxEle - m.minEle) > 0 ? (ele - m.minEle) / (m.maxEle - m.minEle) : 0);

  const grade = m.gradesPct[state.idx] || 0;
  setGaugeValue(el.gauges.grade,
    grade.toFixed(1),
    (m.maxGrade - m.minGrade) > 0 ? (grade - m.minGrade) / (m.maxGrade - m.minGrade) : 0);

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

function formatDurationShort(seconds) {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
