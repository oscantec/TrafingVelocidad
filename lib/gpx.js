/**
 * TrafingVelocidad — GPX Utilities
 * Generate and parse GPX 1.1 files
 * 
 * GPX 1.1 Schema: http://www.topografix.com/GPX/1/1
 */

/**
 * Escape XML special characters
 * @param {string} str 
 * @returns {string}
 */
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Convert timestamp to ISO 8601 string
 * @param {number} timestamp - milliseconds
 * @returns {string}
 */
function toISOTime(timestamp) {
  return new Date(timestamp).toISOString();
}

/**
 * Generate GPX 1.1 XML string from track data
 * @param {string} trackName - name of the track
 * @param {Array<{ lat: number, lng: number, altitude?: number, speed?: number, timestamp: number }>} points 
 * @returns {string} GPX XML string
 */
export function generateGPX(trackName, points) {
  if (!points || points.length === 0) {
    throw new Error('Cannot generate GPX: no points provided');
  }

  const now = toISOTime(Date.now());
  const safeName = escapeXml(trackName);

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="NextCan Tráfico — TrafingVelocidad"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:nextcan="http://nextcan.com/gpx/extensions/1"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${safeName}</name>
    <desc>Track capturado con TrafingVelocidad — NextCan Tráfico</desc>
    <author>
      <name>NextCan Tráfico</name>
    </author>
    <time>${now}</time>
  </metadata>
  <trk>
    <name>${safeName}</name>
    <trkseg>`;

  for (const pt of points) {
    xml += `
      <trkpt lat="${pt.lat.toFixed(8)}" lon="${pt.lng.toFixed(8)}">`;

    if (pt.altitude != null && !isNaN(pt.altitude)) {
      xml += `
        <ele>${pt.altitude.toFixed(1)}</ele>`;
    }

    xml += `
        <time>${toISOTime(pt.timestamp)}</time>`;

    // Speed as extension (not standard GPX but widely supported)
    if (pt.speed != null && !isNaN(pt.speed)) {
      xml += `
        <extensions>
          <nextcan:speed>${pt.speed.toFixed(2)}</nextcan:speed>
          <nextcan:speed_kmh>${(pt.speed * 3.6).toFixed(1)}</nextcan:speed_kmh>
        </extensions>`;
    }

    xml += `
      </trkpt>`;
  }

  xml += `
    </trkseg>
  </trk>
</gpx>`;

  return xml;
}

/**
 * Parse a GPX XML string into an array of track points
 * @param {string} xmlString - GPX file content
 * @returns {{ name: string, points: Array<{ lat: number, lng: number, altitude: number|null, speed: number|null, timestamp: number }> }}
 */
export function parseGPX(xmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');

  // Check for parse errors
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error('Invalid GPX file: XML parse error');
  }

  // Get track name
  const nameEl = doc.querySelector('trk > name') || doc.querySelector('metadata > name');
  const name = nameEl ? nameEl.textContent : 'Imported Track';

  // Parse track points
  const trkpts = doc.querySelectorAll('trkpt');
  const points = [];

  for (const trkpt of trkpts) {
    const lat = parseFloat(trkpt.getAttribute('lat'));
    const lng = parseFloat(trkpt.getAttribute('lon'));

    if (isNaN(lat) || isNaN(lng)) continue;

    const point = { lat, lng };

    // Elevation
    const eleEl = trkpt.querySelector('ele');
    point.altitude = eleEl ? parseFloat(eleEl.textContent) : null;

    // Time
    const timeEl = trkpt.querySelector('time');
    point.timestamp = timeEl ? new Date(timeEl.textContent).getTime() : Date.now();

    // Speed (check extensions)
    const speedEl = trkpt.querySelector('speed') ||
                    trkpt.querySelector('extensions > *');
    if (speedEl && speedEl.localName.includes('speed') && !speedEl.localName.includes('kmh')) {
      point.speed = parseFloat(speedEl.textContent);
    } else {
      point.speed = null;
    }

    points.push(point);
  }

  if (points.length === 0) {
    throw new Error('GPX file contains no track points');
  }

  return { name, points };
}

/**
 * Download a GPX string as a file
 * @param {string} gpxString - XML content
 * @param {string} filename - e.g. "track_2026-04-20_143000.gpx"
 */
export function downloadGPX(gpxString, filename) {
  const blob = new Blob([gpxString], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `track_${formatFilenameDate()}.gpx`;
  a.style.display = 'none';

  document.body.appendChild(a);
  a.click();

  // Cleanup
  setTimeout(() => {
    URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }, 100);
}

/**
 * Download track data as JSON
 * @param {Object} data - { track, points }
 * @param {string} filename 
 */
export function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `track_${formatFilenameDate()}.json`;
  a.style.display = 'none';

  document.body.appendChild(a);
  a.click();

  setTimeout(() => {
    URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }, 100);
}

/**
 * Generate a filename-safe date string
 * @returns {string} "YYYY-MM-DD_HHmmss"
 */
function formatFilenameDate() {
  const now = new Date();
  const pad = (n) => n.toString().padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * Read a file input as text
 * @param {File} file 
 * @returns {Promise<string>}
 */
export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/**
 * Parse a CSV/JSON file containing reference nodes
 * Supports formats:
 *   CSV: id,name,lat,lng (with or without header)
 *   JSON: [{ id, name, lat, lng }]
 * 
 * @param {string} content - file content
 * @param {string} fileType - 'csv' | 'json'
 * @returns {Array<{ id: string, name: string, lat: number, lng: number }>}
 */
export function parseNodesFile(content, fileType) {
  if (fileType === 'json') {
    const data = JSON.parse(content);
    const arr = Array.isArray(data) ? data : data.nodes || data.points || [];
    return arr.map((n, i) => ({
      id: String(n.id || i + 1),
      name: n.name || n.label || `Nodo ${i + 1}`,
      lat: parseFloat(n.lat || n.latitude),
      lng: parseFloat(n.lng || n.lon || n.longitude),
    })).filter((n) => !isNaN(n.lat) && !isNaN(n.lng));
  }

  // CSV parsing
  const lines = content.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  // Check if first line is a header
  const first = lines[0].toLowerCase();
  const hasHeader = first.includes('lat') || first.includes('name') || first.includes('id');
  const startIdx = hasHeader ? 1 : 0;

  const nodes = [];
  for (let i = startIdx; i < lines.length; i++) {
    const parts = lines[i].split(/[,;\t]/).map((s) => s.trim());
    if (parts.length < 3) continue;

    let id, name, lat, lng;

    if (parts.length >= 4) {
      // id, name, lat, lng
      id = parts[0];
      name = parts[1];
      lat = parseFloat(parts[2]);
      lng = parseFloat(parts[3]);
    } else {
      // lat, lng, name (or just lat, lng)
      lat = parseFloat(parts[0]);
      lng = parseFloat(parts[1]);
      name = parts[2] || `Nodo ${i - startIdx + 1}`;
      id = String(i - startIdx + 1);
    }

    if (!isNaN(lat) && !isNaN(lng)) {
      nodes.push({ id, name, lat, lng });
    }
  }

  return nodes;
}
