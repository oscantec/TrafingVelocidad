// ═══════════════════════════════════════════════════════════
//  Softrafing Velocidades — Cliente Supabase
//  Sincronización de recorridos a la nube (free tier)
// ═══════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://wqewsreqemthzaecpiqu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1S2bnjMZa4BMIvVcbQA7nw_Z7Ol4Dv2';

// Lazy-init: the CDN script that defines `window.supabase` may not be
// ready at module-import time, so we build the client on first use.
let _client = null;
function getClient() {
  if (_client) return _client;
  if (typeof window === 'undefined' || !window.supabase) return null;
  _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  return _client;
}
// Back-compat alias for the rest of this file: every function begins
// with `const supabase = getClient();`.

const POINT_BATCH = 500;

/**
 * Verifica conectividad con Supabase (solo lectura).
 */
export async function testConnection() {
  const supabase = getClient();
  if (!supabase) return { ok: false, error: 'Cliente Supabase no cargado' };
  try {
    const { error } = await supabase.from('tracks').select('id', { count: 'exact', head: true });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Verifica que la anon key pueda escribir. Hace un upsert de prueba
 * y lo borra. Detecta RLS/esquema antes de gastar una captura completa.
 */
export async function testWritePermission() {
  const supabase = getClient();
  if (!supabase) return { ok: false, error: 'Cliente Supabase no cargado' };
  const probeId = '__probe_' + (crypto.randomUUID ? crypto.randomUUID() : Date.now());
  try {
    const { data, error } = await supabase
      .from('tracks')
      .upsert({
        local_id: probeId,
        name: '__probe__',
        start_time: new Date().toISOString(),
        point_count: 0,
      }, { onConflict: 'local_id' })
      .select()
      .single();

    if (error) return { ok: false, error: error.message };

    await supabase.from('tracks').delete().eq('id', data.id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Sube un recorrido completo (track + puntos) a Supabase.
 * Es idempotente: si el track ya fue sincronizado (mismo local_id),
 * lo reutiliza e inserta solo los puntos faltantes.
 *
 * @param {Object} track  - { id, name, startTime, endTime, pointCount, ... }
 * @param {Array}  points - lista de puntos del track
 * @returns {{ success, cloudId?, error? }}
 */
export async function syncTrackToCloud(track, points) {
  const supabase = getClient();
  if (!supabase) return { success: false, error: 'Cliente Supabase no cargado' };

  try {
    // 1. Upsert del track (local_id es único → evita duplicados).
    const totalDistance = computeTotalDistance(points);
    const avgKmh = computeAvgSpeedKmh(track, totalDistance);

    const { data: trackData, error: trackErr } = await supabase
      .from('tracks')
      .upsert({
        local_id:    track.id,
        name:        track.name || 'Recorrido sin nombre',
        start_time:  new Date(track.startTime).toISOString(),
        end_time:    track.endTime ? new Date(track.endTime).toISOString() : null,
        distance:    Math.round(totalDistance),
        avg_speed:   Number(avgKmh.toFixed(2)),
        point_count: points.length,
      }, { onConflict: 'local_id' })
      .select()
      .single();

    if (trackErr) throw trackErr;

    const cloudId = trackData.id;

    // 2. Limpiar puntos previos de ese cloudId (idempotencia).
    //    Es barato porque tienen FK con cascade.
    const { error: delErr } = await supabase
      .from('gps_points')
      .delete()
      .eq('track_id', cloudId);
    if (delErr) throw delErr;

    // 3. Insertar puntos en lotes.
    for (let i = 0; i < points.length; i += POINT_BATCH) {
      const chunk = points.slice(i, i + POINT_BATCH).map((p) => ({
        track_id:  cloudId,
        lat:       p.lat,
        lng:       p.lng,
        speed:     p.speed,
        accuracy:  p.accuracy,
        altitude:  p.altitude ?? null,
        timestamp: new Date(p.timestamp).toISOString(),
      }));
      const { error: pErr } = await supabase.from('gps_points').insert(chunk);
      if (pErr) throw pErr;
    }

    return { success: true, cloudId };
  } catch (err) {
    console.error('[supabase] sync error:', err);
    return { success: false, error: err.message || String(err) };
  }
}

/**
 * Lista los tracks del proyecto desde la nube (para el visor).
 */
export async function listCloudTracks() {
  const supabase = getClient();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('tracks')
    .select('*')
    .order('start_time', { ascending: false });
  if (error) {
    console.error('[supabase] list tracks error:', error);
    return [];
  }
  return data || [];
}

// ── Tramificación: Corredor → Tramo → Puntos ─────────────────

function isMissingTable(error) {
  if (!error) return false;
  const msg = String(error.message || error);
  // Tabla / columna ausente, o schema cache desactualizado
  if (/(could not find.*table|relation.*does not exist|schema cache|column .* does not exist|could not find the .* column)/i.test(msg) &&
      /(corridors|tramos|control_points|subtramos|corridor_id)/i.test(msg)) {
    return true;
  }
  // Migración pendiente: tramos.corridor_id sigue NOT NULL en deployments viejos
  if (/null value in column "?corridor_id"?/i.test(msg) &&
      /tramos/i.test(msg)) {
    return true;
  }
  return false;
}

/**
 * Lista todos los tramos con su corredor asociado y el conteo de puntos.
 */
export async function listTramos() {
  const supabase = getClient();
  if (!supabase) return { ok: false, tramos: [], error: 'Cliente Supabase no cargado' };
  const { data, error } = await supabase
    .from('tramos')
    .select('id, name, corridor_id, created_at, corridors ( id, name )')
    .order('created_at', { ascending: false });
  if (error) {
    return { ok: false, tramos: [], error: error.message, missing: isMissingTable(error) };
  }
  return { ok: true, tramos: data || [] };
}

export async function listCorridors() {
  const supabase = getClient();
  if (!supabase) return { ok: false, corridors: [] };
  const { data, error } = await supabase.from('corridors').select('*').order('name');
  if (error) return { ok: false, corridors: [], error: error.message, missing: isMissingTable(error) };
  return { ok: true, corridors: data || [] };
}

/**
 * Crea un corredor por nombre. Es idempotente: si ya existe, lo retorna.
 * Devuelve { ok, corridor: { id, name }, duplicate? }.
 */
export async function createCorridor(name) {
  const supabase = getClient();
  if (!supabase) return { ok: false, error: 'Cliente Supabase no cargado' };
  const trimmed = String(name || '').trim();
  if (!trimmed) return { ok: false, error: 'Nombre vacío' };

  const { data: existing, error: selErr } = await supabase
    .from('corridors').select('id, name').eq('name', trimmed).maybeSingle();
  if (selErr) return { ok: false, error: selErr.message, missing: isMissingTable(selErr) };
  if (existing) return { ok: true, corridor: existing, duplicate: true };

  const { data, error } = await supabase
    .from('corridors').insert({ name: trimmed }).select('id, name').single();
  if (error) return { ok: false, error: error.message, missing: isMissingTable(error) };
  return { ok: true, corridor: data };
}

/**
 * Obtiene los puntos de control de un tramo, ordenados por seq.
 */
export async function listControlPointsByTramo(tramoId) {
  const supabase = getClient();
  if (!supabase) return { ok: false, points: [] };
  const { data, error } = await supabase
    .from('control_points')
    .select('*')
    .eq('tramo_id', tramoId)
    .order('seq', { ascending: true });
  if (error) return { ok: false, points: [], error: error.message };
  return { ok: true, points: data || [] };
}

/**
 * Guarda un circuito (tramo) con sus puntos y subtramos. Cada punto puede
 * pertenecer a un corredor distinto (control_points.corridor_id). El tramo
 * en sí no lleva corredor — un mismo circuito puede atravesar varios.
 *
 * Comportamiento upsert: si ya existe un tramo con el mismo `tramoName`
 * (o se pasa explícitamente `tramoId`), se reutiliza ese registro y se
 * reemplazan sus puntos y subtramos. Útil para guardar incrementalmente
 * el mismo circuito mientras se siguen agregando nodos.
 *
 * Retorna { success, tramoId, updated } o { success:false, error, missing? }.
 */
export async function saveTramoComplete({ tramoId, tramoName, points, subtramos }) {
  const supabase = getClient();
  if (!supabase) return { success: false, error: 'Cliente Supabase no cargado' };
  if (!tramoName) return { success: false, error: 'Falta el nombre del circuito' };
  if (!points || points.length === 0) return { success: false, error: 'No hay puntos para guardar' };
  if (points.some((p) => !p.corridorId)) {
    return { success: false, error: 'Hay puntos sin corredor asignado' };
  }

  const trimmedName = tramoName.trim();

  try {
    // 1. Localizar tramo existente (por id si llega, o por nombre exacto).
    let tramo = null;
    if (tramoId) {
      const { data, error } = await supabase
        .from('tramos').select('id, name').eq('id', tramoId).maybeSingle();
      if (error) return { success: false, error: error.message, missing: isMissingTable(error) };
      tramo = data;
    }
    if (!tramo) {
      const { data, error } = await supabase
        .from('tramos').select('id, name').eq('name', trimmedName).maybeSingle();
      if (error) return { success: false, error: error.message, missing: isMissingTable(error) };
      tramo = data;
    }

    let updated = false;
    if (tramo) {
      // Sobrescribir: actualizar nombre (puede haber cambiado) y limpiar hijos.
      updated = true;
      if (tramo.name !== trimmedName) {
        const { error: uErr } = await supabase
          .from('tramos').update({ name: trimmedName }).eq('id', tramo.id);
        if (uErr) return { success: false, error: uErr.message, missing: isMissingTable(uErr) };
      }
      const { error: dpErr } = await supabase
        .from('control_points').delete().eq('tramo_id', tramo.id);
      if (dpErr) return { success: false, error: dpErr.message, missing: isMissingTable(dpErr) };
      const { error: dsErr } = await supabase
        .from('subtramos').delete().eq('tramo_id', tramo.id);
      if (dsErr) return { success: false, error: dsErr.message, missing: isMissingTable(dsErr) };
    } else {
      const { data: created, error: tErr } = await supabase
        .from('tramos').insert({ name: trimmedName }).select('id, name').single();
      if (tErr) return { success: false, error: tErr.message, missing: isMissingTable(tErr) };
      tramo = created;
    }

    // 2. Puntos en batch y nos guardamos su mapping local-id -> cloud-id para
    //    traducir luego las referencias de los subtramos.
    const pointRows = points.map((p, i) => ({
      tramo_id: tramo.id,
      corridor_id: p.corridorId,
      name: p.name || `Punto ${i + 1}`,
      lat: +p.lat,
      lng: +p.lng,
      seq: i,
    }));
    const { data: insertedPoints, error: pErr } =
      await supabase.from('control_points').insert(pointRows).select();
    if (pErr) return { success: false, error: pErr.message };

    const localIdToCloud = new Map();
    for (let i = 0; i < points.length; i++) {
      localIdToCloud.set(points[i].id, insertedPoints[i].id);
    }

    // 3. Subtramos (opcional). start_ref / end_ref guardan '__start__',
    //    '__end__' o el uuid del control_point recién creado.
    if (Array.isArray(subtramos) && subtramos.length) {
      const translate = (id) => {
        if (id === '__start__' || id === '__end__') return id;
        const cloudId = localIdToCloud.get(id);
        return cloudId || id; // si el nodo ya era cloud, su id ya sirve
      };
      const stRows = subtramos.map((st, i) => ({
        tramo_id:  tramo.id,
        seq:       i,
        active:    st.active !== false,
        start_ref: translate(st.startNodeId),
        end_ref:   translate(st.endNodeId),
        sentido:   st.sentido || null,
      }));
      const { error: sErr } = await supabase.from('subtramos').insert(stRows);
      if (sErr) return { success: false, error: `Tramo guardado, pero falló al guardar subtramos: ${sErr.message}`, missing: isMissingTable(sErr) };
    }

    return { success: true, tramoId: tramo.id, updated };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

export async function listSubtramosByTramo(tramoId) {
  const supabase = getClient();
  if (!supabase) return { ok: false, subtramos: [] };
  const { data, error } = await supabase
    .from('subtramos')
    .select('*')
    .eq('tramo_id', tramoId)
    .order('seq', { ascending: true });
  if (error) return { ok: false, subtramos: [], error: error.message, missing: isMissingTable(error) };
  return { ok: true, subtramos: data || [] };
}

export async function deleteTramo(tramoId) {
  const supabase = getClient();
  if (!supabase) return { success: false };
  const { error } = await supabase.from('tramos').delete().eq('id', tramoId);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

/**
 * Recupera los puntos de un track (por cloudId o local_id).
 *
 * IMPORTANTE: PostgREST aplica un límite por defecto de 1000 filas por
 * petición (se puede subir a 100 000 desde el dashboard de Supabase, pero
 * confiar en eso silencia el problema cuando un track lo supera). Aquí
 * paginamos con .range() en lotes de 1000 hasta que no haya más datos —
 * así el cliente nunca pierde puntos por el cap del servidor.
 */
export async function getCloudTrackPoints(cloudId) {
  const supabase = getClient();
  if (!supabase) return [];
  const PAGE = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('gps_points')
      .select('*')
      .eq('track_id', cloudId)
      .order('timestamp', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error('[supabase] get points error:', error);
      return all;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// ── Helpers ─────────────────────────────────────────────────
function computeTotalDistance(points) {
  if (!points || points.length < 2) return 0;
  const R = 6371000;
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    d += 2 * R * Math.asin(Math.sqrt(h));
  }
  return d;
}

function computeAvgSpeedKmh(track, distanceMeters) {
  if (!track.startTime || !track.endTime || distanceMeters <= 0) return 0;
  const seconds = (track.endTime - track.startTime) / 1000;
  if (seconds <= 0) return 0;
  return (distanceMeters / 1000) / (seconds / 3600);
}

function toRad(deg) { return deg * Math.PI / 180; }

// ── Shareable URL helpers ───────────────────────────────────
// A cloud track's canonical viewer URL is:
//   {origin}/viewer/track.html?track=<cloudId>
// We append a decorative hash (#Trafing_YYYYMMDDHHMM_Slug) so the URL
// reads nicely when pasted in a report, Slack, Excel, etc. The hash is
// ignored by the track viewer — it only reads ?track=<cloudId>.
function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function stampFromDate(isoOrMs) {
  const d = isoOrMs instanceof Date ? isoOrMs : new Date(isoOrMs);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

// ── Track-name metadata encoding ────────────────────────────
// We piggy-back the classification (tipo · calzada · período) on the
// `name` column instead of adding new columns to the Supabase schema.
// The format is: "<base name> [tipo|calzada|periodo]". Empty slots are
// represented by an empty string between the pipes. The brackets+pipes
// are unlikely to appear in user-typed names, so detection is reliable.

const META_RE = /^(.*?)\s*\[([^|\]]*)\|([^|\]]*)\|([^|\]]*)\]\s*$/;

/**
 * Encode tipo/calzada/periodo onto a base recorrido name.
 * @returns {string} Plain base name when the three fields are empty;
 *                   "<base> [t|c|p]" otherwise.
 */
export function encodeTrackName(baseName, tipo, calzada, periodo) {
  const base = String(baseName || '').trim();
  const t = String(tipo    || '').trim();
  const c = String(calzada || '').trim();
  const p = String(periodo || '').trim();
  if (!t && !c && !p) return base;
  return `${base} [${t}|${c}|${p}]`;
}

/**
 * Decode a track name into { name, tipo, calzada, periodo }.
 * Names that don't carry the bracket suffix decode to empty fields.
 */
export function decodeTrackName(fullName) {
  const m = META_RE.exec(String(fullName || ''));
  if (!m) return { name: String(fullName || '').trim(), tipo: '', calzada: '', periodo: '' };
  return { name: m[1].trim(), tipo: m[2].trim(), calzada: m[3].trim(), periodo: m[4].trim() };
}

/**
 * Build a shareable URL for a cloud-hosted recorrido.
 * The decorative hash fragment is plain `YYYYMMDDHHMM_<slug>`; we keep
 * it vendor-neutral on purpose, since these links are pasted into
 * evidence reports and external tools where our brand shouldn't leak.
 * @param {{ id: string, name?: string, start_time?: string }} track
 * @param {string} [origin] — base origin; defaults to current location.
 * @returns {string} full URL with decorative slug hash
 */
export function buildTrackShareUrl(track, origin) {
  if (!track || !track.id) return '';
  const base = new URL('viewer/track.html', (origin || location.origin) + '/');
  base.searchParams.set('track', track.id);
  const stamp = stampFromDate(track.start_time);
  const slug  = slugify(track.name);
  const tag   = [stamp, slug].filter(Boolean).join('_');
  if (tag) base.hash = tag;
  return base.href;
}
