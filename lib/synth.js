/**
 * TrafingVelocidad — Síntesis del 4º recorrido
 *
 * Metodología: el operario debe hacer 4 recorridos por sentido / calzada /
 * tipo vehicular dentro de las 3 horas de la HMD. Cuando el tráfico impide
 * cerrar el cuarto, este módulo lo deriva de los 3 anteriores:
 *
 *   • Geometría (X, Y, Z): promedio de los recorridos previos remuestreados
 *     por fracción de longitud de arco, más una perturbación suave de pocos
 *     metros para que no sea una copia exacta del promedio.
 *   • Tiempo de viaje / velocidad: promedio del perfil temporal de los
 *     previos (elapsed en cada fracción del recorrido) escalado por una
 *     variación suave de ±`timeVariation`. Al promediar el perfil completo
 *     —y no solo el total— cada subtramo hereda el promedio de sus propios
 *     tiempos, que es lo que termina en el reporte.
 *   • Secuencia: arranca después de que termina el último recorrido previo,
 *     separado por el intervalo medio observado entre recorridos. Nunca se
 *     solapa con ellos.
 *
 * Todo es determinista: la misma entrada produce el mismo cuarto recorrido,
 * de modo que reexportar el reporte no cambia las cifras entregadas.
 */

import { haversineDistance } from './geo.js';

const METERS_PER_DEG_LAT = 111320;

// PRNG determinista (mulberry32) — semilla derivada de los recorridos fuente.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Onda suave acotada en [-1, 1]: un sesgo constante más dos armónicos.
// El término constante desplaza todo el recorrido; los armónicos hacen que
// distintos subtramos reciban variaciones ligeramente distintas.
function makeWave(rnd) {
  const bias = rnd() * 2 - 1;
  const ph1 = rnd() * Math.PI * 2;
  const ph2 = rnd() * Math.PI * 2;
  return (f) => 0.5 * bias
    + 0.35 * Math.sin(2 * Math.PI * f + ph1)
    + 0.15 * Math.sin(6 * Math.PI * f + ph2);
}

// Precalcula distancia acumulada y tiempo transcurrido de un recorrido.
function prepare(rec) {
  const ref = rec;
  const pts = rec.points;
  const cum = new Array(pts.length);
  cum[0] = 0;
  for (let i = 1; i < pts.length; i++) {
    cum[i] = cum[i - 1] + haversineDistance(pts[i - 1], pts[i]);
  }
  const t0 = pts[0].timestamp;
  const elapsed = pts.map((p) => (p.timestamp - t0) / 1000);
  return {
    ref,
    pts,
    cum,
    elapsed,
    total: cum[cum.length - 1],
    duration: elapsed[elapsed.length - 1],
    startTs: pts[0].timestamp,
    endTs: pts[pts.length - 1].timestamp,
  };
}

// Muestrea posición y tiempo a la fracción `f` de la longitud recorrida.
function sampleAt(prep, f) {
  const target = f * prep.total;
  let lo = 0;
  let hi = prep.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (prep.cum[mid] <= target) lo = mid; else hi = mid - 1;
  }
  const i = Math.min(lo, prep.cum.length - 2);
  const span = prep.cum[i + 1] - prep.cum[i];
  const r = span > 0 ? (target - prep.cum[i]) / span : 0;
  const a = prep.pts[i];
  const b = prep.pts[i + 1];

  let alt = null;
  if (a.altitude != null && b.altitude != null) alt = a.altitude + (b.altitude - a.altitude) * r;
  else if (a.altitude != null) alt = a.altitude;
  else if (b.altitude != null) alt = b.altitude;

  return {
    lat: a.lat + (b.lat - a.lat) * r,
    lng: a.lng + (b.lng - a.lng) * r,
    alt,
    elapsed: prep.elapsed[i] + (prep.elapsed[i + 1] - prep.elapsed[i]) * r,
  };
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Deriva un recorrido sintético a partir de los recorridos previos.
 *
 * @param {Array<{ id?: string, points: Array<{lat,lng,altitude?,timestamp}> }>} sources
 *        Recorridos previos, del mismo grupo (día · período · calzada · tipo).
 * @param {Object} [opts]
 * @param {number} [opts.timeVariation=0.03] Variación relativa máxima del tiempo (±).
 * @param {number} [opts.posJitter=2]        Amplitud de la perturbación de posición, en metros.
 * @param {number} [opts.gapSeconds]         Separación con el recorrido anterior; por
 *                                           defecto, el intervalo medio observado.
 * @param {number} [opts.sampleCount]        Nº de puntos del recorrido generado.
 * @returns {{ points: Array, startTs: number, endTs: number, meta: Object } | null}
 */
export function synthesizeRecorrido(sources, opts = {}) {
  const {
    timeVariation = 0.03,
    posJitter = 2,
    gapSeconds = null,
    sampleCount = null,
  } = opts;

  const preps = (sources || [])
    .filter((r) => r && r.points && r.points.length >= 2)
    .map(prepare)
    .filter((p) => p.total > 0 && p.duration > 0)
    .sort((a, b) => a.startTs - b.startTs);

  if (preps.length < 2) return null;

  // Firma de las fuentes: el cloudId cuando el recorrido viene de Supabase
  // (lo más estable que hay) y, si no, su geometría. De aquí salen tanto la
  // semilla del PRNG como el `localId` con que se publica el generado, así
  // que reexportar actualiza el mismo registro en vez de crear otro.
  const seedStr = preps
    .map((p) => p.ref.cloudId || `${p.startTs}:${p.pts.length}:${Math.round(p.total)}`)
    .join('|');
  const rnd = mulberry32(hashSeed(seedStr));
  const timeWave = makeWave(rnd);
  const northWave = makeWave(rnd);
  const eastWave = makeWave(rnd);

  const n = Math.max(2, Math.min(6000,
    sampleCount || Math.round(median(preps.map((p) => p.pts.length)))));

  // 1) Promedio de geometría y de perfil temporal por fracción de arco.
  const avg = new Array(n);
  for (let j = 0; j < n; j++) {
    const f = j / (n - 1);
    let lat = 0, lng = 0, elapsed = 0, alt = 0, altCount = 0;
    for (const p of preps) {
      const s = sampleAt(p, f);
      lat += s.lat;
      lng += s.lng;
      elapsed += s.elapsed;
      if (s.alt != null) { alt += s.alt; altCount++; }
    }
    avg[j] = {
      lat: lat / preps.length,
      lng: lng / preps.length,
      alt: altCount ? alt / altCount : null,
      elapsed: elapsed / preps.length,
    };
  }

  // 2) Variación suave del tiempo, aplicada paso a paso para que la serie
  //    siga siendo monótona creciente.
  const times = new Array(n);
  times[0] = 0;
  for (let j = 1; j < n; j++) {
    const step = Math.max(0, avg[j].elapsed - avg[j - 1].elapsed);
    const fMid = (j - 0.5) / (n - 1);
    times[j] = times[j - 1] + step * (1 + timeVariation * timeWave(fMid));
  }

  // 3) Arranque: después del último recorrido previo, con el intervalo medio
  //    observado entre recorridos (mínimo 30 s si no hay dato utilizable).
  const gaps = [];
  for (let i = 1; i < preps.length; i++) {
    const g = (preps[i].startTs - preps[i - 1].endTs) / 1000;
    if (g > 0) gaps.push(g);
  }
  const gap = gapSeconds != null
    ? gapSeconds
    : (gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 120);
  const startTs = preps[preps.length - 1].endTs + Math.max(30, Math.round(gap)) * 1000;

  // 4) Puntos finales, con la perturbación de posición en metros.
  const points = new Array(n);
  for (let j = 0; j < n; j++) {
    const f = j / (n - 1);
    const base = avg[j];
    const dNorth = posJitter * northWave(f);
    const dEast = posJitter * eastWave(f);
    const cosLat = Math.cos((base.lat * Math.PI) / 180) || 1;
    points[j] = {
      lat: base.lat + dNorth / METERS_PER_DEG_LAT,
      lng: base.lng + dEast / (METERS_PER_DEG_LAT * cosLat),
      altitude: base.alt,
      // Explícito, no `undefined`: estos puntos se insertan en Supabase y
      // todas las filas del lote deben tener las mismas claves.
      accuracy: null,
      speed: null,
      timestamp: startTs + Math.round(times[j] * 1000),
    };
  }

  // 5) Velocidad instantánea (m/s) coherente con la geometría y los tiempos.
  for (let j = 0; j < n; j++) {
    const a = points[Math.max(0, j - 1)];
    const b = points[Math.min(n - 1, j + 1)];
    const dt = (b.timestamp - a.timestamp) / 1000;
    points[j].speed = dt > 0 ? haversineDistance(a, b) / dt : 0;
  }

  const duration = times[n - 1];
  return {
    points,
    startTs,
    endTs: points[n - 1].timestamp,
    meta: {
      localId: `synth4-${hashSeed(seedStr).toString(36)}`,
      sourceCount: preps.length,
      sampleCount: n,
      gapSeconds: Math.max(30, Math.round(gap)),
      avgSourceDuration: preps.reduce((a, p) => a + p.duration, 0) / preps.length,
      duration,
      timeVariation,
      posJitter,
    },
  };
}

/**
 * Clave de agrupación de la metodología: un grupo son los recorridos que
 * comparten día, período (HMD), calzada y tipo de vehículo — el conjunto que
 * debe tener 4 repeticiones.
 */
export function recorridoGroupKey(rec) {
  const d = new Date(rec.startTs || Date.now());
  const fecha = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return [fecha, rec.periodo || '—', rec.calzada || '—', rec.tipo || '—'].join(' · ');
}
