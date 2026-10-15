const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const ATTRIBUTION = '<a href="https://openfreemap.org/">OpenFreeMap</a> &copy; ' +
  '<a href="https://www.openmaptiles.org/">OpenMapTiles</a> Data from ' +
  '<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

/** Public report links work on every app domain, with a raster fallback. */
export function addBasemap(map, { maxZoom = 20 } = {}) {
  map.setMinZoom(1);
  map.setMaxZoom(maxZoom);
  const fallback = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxNativeZoom: 19,
    maxZoom,
  }).addTo(map);

  if (typeof L.maplibreGL !== 'function') return fallback;

  let vector = null;
  let timeout = null;
  let fallbackActive = false;
  const useFallback = () => {
    if (fallbackActive) return;
    fallbackActive = true;
    clearTimeout(timeout);
    if (vector && map.hasLayer(vector)) map.removeLayer(vector);
    if (!map.hasLayer(fallback)) fallback.addTo(map);
  };

  try {
    vector = L.maplibreGL({
      style: STYLE_URL,
      attribution: ATTRIBUTION,
      interactive: false,
    }).addTo(map);
    const gl = vector.getMaplibreMap();
    gl.on('error', useFallback);
    gl.once('load', () => {
      clearTimeout(timeout);
      if (!fallbackActive && map.hasLayer(fallback)) map.removeLayer(fallback);
    });
    timeout = setTimeout(useFallback, 12000);
    map.once('unload', () => clearTimeout(timeout));
    return vector;
  } catch {
    useFallback();
    return fallback;
  }
}
