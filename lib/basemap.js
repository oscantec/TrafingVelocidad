// CARTO browser key restricted to trafingvelocidad.vercel.app.
const CARTO_BASEMAP_KEY = 'cb1_4kzp_1_9f65a0d7a20f027e4eda5c9b';
const TILE_URL = 'https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}{r}.png';

/** Add the same light Positron basemap to capture, processing and shared tracks. */
export function addBasemap(map, { maxZoom = 20 } = {}) {
  return L.tileLayer(`${TILE_URL}?key=${encodeURIComponent(CARTO_BASEMAP_KEY)}`, {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
      '&copy; <a href="https://carto.com/attribution/">CARTO</a>',
    maxNativeZoom: 20,
    maxZoom,
  }).addTo(map);
}
