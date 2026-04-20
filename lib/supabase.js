// ═══════════════════════════════════════════════════════════
//  Softrafing Velocidades — Cliente Supabase
//  Sincronización de recorridos a la nube (free tier)
// ═══════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://wqewsreqemthzaecpiqu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndxZXdzcmVxZW10aHphZWNwaXF1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3MDcwMTIsImV4cCI6MjA5MjI4MzAxMn0.xF6Fci-T3yXn_fLIBLPfqvlHSJaSsSrfPZ1o-6ov7Rk';

export const supabase = (typeof window !== 'undefined' && window.supabase)
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

const POINT_BATCH = 500;

/**
 * Verifica conectividad con Supabase.
 * Retorna { ok, error } — útil para diagnóstico en UI.
 */
export async function testConnection() {
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
 * Sube un recorrido completo (track + puntos) a Supabase.
 * Es idempotente: si el track ya fue sincronizado (mismo local_id),
 * lo reutiliza e inserta solo los puntos faltantes.
 *
 * @param {Object} track  - { id, name, startTime, endTime, pointCount, ... }
 * @param {Array}  points - lista de puntos del track
 * @returns {{ success, cloudId?, error? }}
 */
export async function syncTrackToCloud(track, points) {
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

/**
 * Recupera los puntos de un track (por cloudId o local_id).
 */
export async function getCloudTrackPoints(cloudId) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('gps_points')
    .select('*')
    .eq('track_id', cloudId)
    .order('timestamp', { ascending: true });
  if (error) {
    console.error('[supabase] get points error:', error);
    return [];
  }
  return data || [];
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
