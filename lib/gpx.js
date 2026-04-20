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
 * Clean a raw string so it has a chance at passing through DOMParser:
 * strip BOM, JSP directives, HTML comments, trailing junk.
 */
function sanitizeForXml(raw) {
  let s = String(raw);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);        // BOM
  s = s.replace(/<%[\s\S]*?%>/g, '');                     // JSP <% … %>
  s = s.replace(/<\?php[\s\S]*?\?>/g, '');                // PHP
  s = s.replace(/<!--[\s\S]*?-->/g, '');                  // HTML comments
  s = s.replace(/&nbsp;/g, ' ');                          // entidades HTML comunes
  s = s.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;'); // & sueltos
  return s.trim();
}

/**
 * Decode HTML entities that may be double-encoding XML (e.g. a GPX
 * returned inside an HTML/JSP page as &lt;trkpt…&gt;).
 */
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/**
 * Last-resort regex extractor — pulls track points from any text,
 * trying many formats: GPX (trkpt / rtept / wpt), KML (coordinates),
 * JSON-in-JS, and lat/lng attribute pairs.
 */
function regexExtractGPX(text) {
  const points = [];

  // Pattern A: GPX <trkpt>, <rtept>, <wpt> with any attribute order
  const tagRe = /<(trkpt|rtept|wpt)\b([^>]*)(?:\/>|>([\s\S]*?)<\/\1\s*>)/gi;
  let m;
  while ((m = tagRe.exec(text)) !== null) {
    const attrs = m[2];
    const latM = attrs.match(/\blat\s*=\s*["']?([-\d.]+)/i);
    const lngM = attrs.match(/\b(?:lon|lng|long|longitude)\s*=\s*["']?([-\d.]+)/i);
    if (!latM || !lngM) continue;
    const lat = parseFloat(latM[1]), lng = parseFloat(lngM[1]);
    if (isNaN(lat) || isNaN(lng)) continue;

    const inner = m[3] || '';
    const ele  = inner.match(/<ele>\s*([-\d.]+)\s*<\/ele>/i);
    const time = inner.match(/<time>\s*([^<]+?)\s*<\/time>/i);
    const spd  = inner.match(/<(?:[a-z]+:)?speed>\s*([-\d.]+)\s*<\/(?:[a-z]+:)?speed>/i);

    points.push({
      lat, lng,
      altitude: ele ? parseFloat(ele[1]) : null,
      speed:    spd ? parseFloat(spd[1]) : null,
      timestamp: time ? (new Date(time[1]).getTime() || Date.now()) : Date.now(),
    });
  }

  // Pattern B: KML <coordinates>lng,lat[,alt] lng,lat[,alt] …</coordinates>
  if (points.length === 0) {
    const coordBlock = /<coordinates>\s*([\s\S]*?)\s*<\/coordinates>/gi;
    let cb;
    while ((cb = coordBlock.exec(text)) !== null) {
      const pairs = cb[1].trim().split(/\s+/).filter(Boolean);
      let t = Date.now();
      for (const p of pairs) {
        const [lng, lat, alt] = p.split(',').map(parseFloat);
        if (isNaN(lat) || isNaN(lng)) continue;
        points.push({
          lat, lng,
          altitude: isNaN(alt) ? null : alt,
          speed: null,
          timestamp: t++,
        });
      }
    }
  }

  // Pattern C: scan each flat {…} object literal for lat/lon in ANY order,
  // with or without quotes — catches gpxscan-style gpx_data = { "00:00:00":
  // {index:0,current_time:"…",ele:X,speed:Y,distance:Z,time:T,lat:A,lon:B}, … }
  if (points.length === 0) {
    const objRe = /\{([^{}]{20,2000})\}/g;
    const rawPts = [];
    let m;
    while ((m = objRe.exec(text)) !== null) {
      const body = m[1];
      const latM = body.match(/["']?lat["']?\s*:\s*([-\d.]+)/i);
      const lonM = body.match(/["']?(?:lon|lng|long|longitude)["']?\s*:\s*([-\d.]+)/i);
      if (!latM || !lonM) continue;

      const lat = parseFloat(latM[1]), lng = parseFloat(lonM[1]);
      if (isNaN(lat) || isNaN(lng)) continue;
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;

      const eleM   = body.match(/["']?(?:ele|alt|altitude|elevation)["']?\s*:\s*([-\d.]+)/i);
      const spdM   = body.match(/["']?speed["']?\s*:\s*([-\d.]+)/i);
      const idxM   = body.match(/["']?index["']?\s*:\s*(\d+)/i);
      const curtM  = body.match(/["']?current_time["']?\s*:\s*["']([^"']+)["']/i);
      const tsM    = body.match(/["']?(?:timestamp|time)["']?\s*:\s*["']?([-\dT:+Z. ]+)["']?/i);

      let ts = Date.now();
      if (curtM) {
        // gpxscan uses "YYYY-MM-DD HH:MM:SS" (no 'T') — Date handles it
        const t = new Date(curtM[1].replace(' ', 'T')).getTime();
        if (!isNaN(t)) ts = t;
      } else if (tsM) {
        const raw = tsM[1].trim();
        const t = isNaN(+raw) ? new Date(raw).getTime() : +raw;
        if (!isNaN(t)) ts = t;
      }

      rawPts.push({
        idx: idxM ? +idxM[1] : rawPts.length,
        lat, lng,
        altitude: eleM ? parseFloat(eleM[1]) : null,
        // gpxscan stores speed in km/h (see speed_unit="km/h" in its HTML);
        // normalise to m/s so metrics math stays consistent.
        speed: spdM ? parseFloat(spdM[1]) / 3.6 : null,
        timestamp: ts,
      });
    }
    // Preserve the index-ordered sequence rather than document order
    rawPts.sort((a, b) => a.idx - b.idx);
    for (const p of rawPts) {
      points.push({ lat: p.lat, lng: p.lng, altitude: p.altitude, speed: p.speed, timestamp: p.timestamp });
    }
  }

  // Pattern D: Google Maps-style LatLng(lat, lng) constructor calls
  if (points.length === 0) {
    const latlng = /(?:LatLng|latLng|L\.latLng)\s*\(\s*([-\d.]+)\s*,\s*([-\d.]+)/g;
    let k, t = Date.now();
    while ((k = latlng.exec(text)) !== null) {
      const lat = parseFloat(k[1]), lng = parseFloat(k[2]);
      if (isNaN(lat) || isNaN(lng)) continue;
      points.push({ lat, lng, altitude: null, speed: null, timestamp: t++ });
    }
  }

  const nameMatch = text.match(/<trk>[\s\S]*?<name>\s*([^<]+?)\s*<\/name>/i)
                 || text.match(/<metadata>[\s\S]*?<name>\s*([^<]+?)\s*<\/name>/i)
                 || text.match(/<Placemark>[\s\S]*?<name>\s*([^<]+?)\s*<\/name>/i);
  const name = nameMatch ? nameMatch[1].trim() : 'Imported Track';
  return { name, points };
}

/**
 * Parse a GPX XML string into an array of track points.
 * Tries DOMParser first, falls back to regex if the document is malformed
 * (common when the file is a .jsp dump, HTML-wrapped, or has stray entities).
 */
export function parseGPX(xmlString) {
  const cleaned = sanitizeForXml(xmlString);

  // Attempt 1: DOMParser with application/xml (strict)
  const parser = new DOMParser();
  let doc = parser.parseFromString(cleaned, 'application/xml');

  let parseError = doc.querySelector('parsererror');

  // Attempt 2: if strict fails, try text/html (very forgiving)
  if (parseError) {
    doc = parser.parseFromString(cleaned, 'text/html');
    parseError = doc.querySelector('parsererror');
  }

  // If we still have a document, try DOM extraction
  if (!parseError && doc) {
    const nameEl = doc.querySelector('trk > name') || doc.querySelector('metadata > name');
    const name = nameEl ? nameEl.textContent.trim() : 'Imported Track';

    const trkpts = doc.querySelectorAll('trkpt');
    const points = [];

    for (const trkpt of trkpts) {
      const lat = parseFloat(trkpt.getAttribute('lat'));
      const lng = parseFloat(trkpt.getAttribute('lon'));
      if (isNaN(lat) || isNaN(lng)) continue;

      const point = { lat, lng };
      const eleEl = trkpt.querySelector('ele');
      point.altitude = eleEl ? parseFloat(eleEl.textContent) : null;

      const timeEl = trkpt.querySelector('time');
      point.timestamp = timeEl ? (new Date(timeEl.textContent).getTime() || Date.now()) : Date.now();

      const speedEl = trkpt.querySelector('speed') || trkpt.querySelector('extensions > *');
      if (speedEl && speedEl.localName && speedEl.localName.includes('speed') && !speedEl.localName.includes('kmh')) {
        point.speed = parseFloat(speedEl.textContent);
      } else {
        point.speed = null;
      }
      points.push(point);
    }

    if (points.length > 0) return { name, points };
  }

  // Attempt 3: regex fallback on cleaned text
  let fallback = regexExtractGPX(cleaned);

  // Attempt 4: some pages double-encode the XML (e.g. GPX inside an HTML
  // page rendered as text: &lt;trkpt&gt;…). Decode entities and retry.
  if (fallback.points.length === 0) {
    const decoded = decodeEntities(cleaned);
    if (decoded !== cleaned) fallback = regexExtractGPX(decoded);
  }

  if (fallback.points.length === 0) {
    const preview = cleaned.slice(0, 240).replace(/\s+/g, ' ').trim();
    throw new Error(`Sin puntos reconocibles. El archivo empieza con: "${preview}…". Comparte esos primeros caracteres para ajustar el parser al formato exacto.`);
  }
  return fallback;
}

/**
 * Parse a KML (Google Earth / Maps) document into track points.
 * Supports LineString, gx:Track (w/ timestamps) and Placemark Points as fallback.
 */
export function parseKML(xmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('KML inválido: error de XML');

  const nameEl = doc.querySelector('Document > name') || doc.querySelector('Placemark > name');
  const name = nameEl ? nameEl.textContent.trim() : 'KML importado';

  const points = [];

  // gx:Track — tiene <when> y <gx:coord>
  const tracks = doc.getElementsByTagNameNS('*', 'Track');
  for (const trk of tracks) {
    const whens  = Array.from(trk.getElementsByTagNameNS('*', 'when')).map(w => w.textContent.trim());
    const coords = Array.from(trk.getElementsByTagNameNS('*', 'coord')).map(c => c.textContent.trim());
    const n = Math.min(whens.length, coords.length);
    for (let i = 0; i < n; i++) {
      const [lng, lat, alt] = coords[i].split(/\s+/).map(parseFloat);
      if (isNaN(lat) || isNaN(lng)) continue;
      points.push({
        lat, lng,
        altitude: isNaN(alt) ? null : alt,
        speed: null,
        timestamp: new Date(whens[i]).getTime() || Date.now(),
      });
    }
  }

  // LineString coordinates — sin tiempo
  if (points.length === 0) {
    const lineStrings = doc.querySelectorAll('LineString coordinates');
    for (const cs of lineStrings) {
      const text = cs.textContent.trim();
      const pairs = text.split(/\s+/).filter(Boolean);
      let t0 = Date.now();
      for (const pair of pairs) {
        const [lng, lat, alt] = pair.split(',').map(parseFloat);
        if (isNaN(lat) || isNaN(lng)) continue;
        points.push({
          lat, lng,
          altitude: isNaN(alt) ? null : alt,
          speed: null,
          timestamp: t0++,
        });
      }
    }
  }

  if (points.length === 0) throw new Error('KML sin puntos de track');
  return { name, points };
}

/**
 * Parse GeoJSON FeatureCollection / Feature / geometry into track points.
 * Acepta LineString, MultiLineString y arreglos de Points.
 */
export function parseGeoJSON(text) {
  const data = typeof text === 'string' ? JSON.parse(text) : text;
  const features = data.type === 'FeatureCollection' ? data.features
                 : data.type === 'Feature' ? [data]
                 : data.geometry ? [data] : [];

  const points = [];
  let name = 'GeoJSON importado';

  const pushCoord = (c, t) => {
    const [lng, lat, alt] = c;
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    points.push({
      lat, lng,
      altitude: typeof alt === 'number' ? alt : null,
      speed: null,
      timestamp: t,
    });
  };

  for (const f of features) {
    if (f.properties && f.properties.name && !name.includes('importado')) continue;
    if (f.properties && f.properties.name) name = f.properties.name;

    const g = f.geometry || f;
    if (!g) continue;
    let t0 = Date.now();
    if (g.type === 'LineString') {
      for (const c of g.coordinates) pushCoord(c, t0++);
    } else if (g.type === 'MultiLineString') {
      for (const line of g.coordinates) for (const c of line) pushCoord(c, t0++);
    } else if (g.type === 'Point') {
      pushCoord(g.coordinates, t0++);
    }
  }

  if (points.length === 0) throw new Error('GeoJSON sin coordenadas válidas');
  return { name, points };
}

/**
 * Extract the first embedded GPX/KML block from a larger document (JSP,
 * HTML page, copy-pasted view-source, etc.). Returns the inner XML or null.
 */
function extractEmbeddedXml(text) {
  const tags = ['gpx', 'kml'];
  for (const tag of tags) {
    const open  = new RegExp(`<\\s*${tag}[\\s>]`, 'i');
    const close = new RegExp(`<\\s*/\\s*${tag}\\s*>`, 'i');
    const a = text.search(open);
    if (a === -1) continue;
    const rest = text.slice(a);
    const b = rest.search(close);
    if (b === -1) continue;
    const endTagMatch = rest.slice(b).match(close);
    const endIdx = b + (endTagMatch ? endTagMatch[0].length : 0);
    return rest.slice(0, endIdx);
  }
  return null;
}

/**
 * Auto-detect format and parse. Fallback de último recurso para content pegado.
 */
export function parseTrackContent(text, hint) {
  const trimmed = text.trim();
  const lower = (hint || '').toLowerCase();

  // JSON / GeoJSON — solo si empieza con { o [ (un HTML también contiene { pero no al inicio)
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const data = JSON.parse(trimmed);
    if (data.type === 'FeatureCollection' || data.type === 'Feature' || data.geometry) {
      return parseGeoJSON(data);
    }
    const pts = data.points || data;
    if (Array.isArray(pts) && pts.length && pts[0].lat != null) {
      return { name: data.track?.name || 'Track JSON', points: pts };
    }
    throw new Error('JSON no reconocido');
  }

  // Intento 1: XML puro
  if (trimmed.includes('<gpx')) return parseGPX(trimmed);
  if (trimmed.includes('<kml')) return parseKML(trimmed);

  // Intento 2: GPX/KML empaquetado dentro de otro documento (JSP, HTML…)
  const embedded = extractEmbeddedXml(trimmed);
  if (embedded) {
    if (/<\s*gpx/i.test(embedded)) return parseGPX(embedded);
    if (/<\s*kml/i.test(embedded)) return parseKML(embedded);
  }

  // Intento 3: solo <?xml … ?> sin raíz clara
  if (trimmed.startsWith('<?xml') || lower.endsWith('.xml')) return parseGPX(trimmed);

  // Por extensión (último recurso)
  if (lower.endsWith('.gpx') || lower.endsWith('.jsp')) return parseGPX(trimmed);
  if (lower.endsWith('.kml')) return parseKML(trimmed);
  if (lower.endsWith('.json') || lower.endsWith('.geojson')) return parseGeoJSON(trimmed);

  throw new Error('Formato no reconocido. Sube GPX, KML, GeoJSON, JSON o pega el XML del track.');
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
