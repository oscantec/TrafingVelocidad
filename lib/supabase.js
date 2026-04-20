// Cliente de Supabase para TrafingVelocidad
// Usamos la versión de CDN para mantener el proyecto sin build step

const SUPABASE_URL = 'https://wqewsreqemthzaecpiqu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndxZXdzcmVxZW10aHphZWNwaXF1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3MDcwMTIsImV4cCI6MjA5MjI4MzAxMn0.xF6Fci-T3yXn_fLIBLPfqvlHSJaSsSrfPZ1o-6ov7Rk';

// Importamos la librería desde el CDN de forma dinámica si no está en el index
export const supabase = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

/**
 * Sincroniza un recorrido completo a Supabase
 */
export async function syncTrackToCloud(track, points) {
  if (!supabase) {
    console.error('Supabase no está disponible');
    return { error: 'Supabase client not loaded' };
  }

  try {
    // 1. Insertar el track
    const { data: trackData, error: trackError } = await supabase
      .from('tracks')
      .insert([{
        name: track.name || 'Recorrido sin nombre',
        start_time: new Date(track.startTime).toISOString(),
        end_time: track.endTime ? new Date(track.endTime).toISOString() : null,
        distance: track.distance || 0,
        avg_speed: track.avgSpeed || 0
      }])
      .select()
      .single();

    if (trackError) throw trackError;

    // 2. Preparar los puntos (insertar en bloques para mayor eficiencia)
    const pointsToInsert = points.map(p => ({
      track_id: trackData.id,
      lat: p.lat,
      lng: p.lng,
      speed: p.speed,
      accuracy: p.accuracy,
      timestamp: new Date(p.timestamp).toISOString()
    }));

    const { error: pointsError } = await supabase
      .from('gps_points')
      .insert(pointsToInsert);

    if (pointsError) throw pointsError;

    return { data: trackData, success: true };
  } catch (error) {
    console.error('Error sincronizando a Supabase:', error);
    return { error: error.message, success: false };
  }
}
