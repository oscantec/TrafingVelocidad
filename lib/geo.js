/**
 * TrafingVelocidad — Geographic Utilities
 * Pure functions for distance, speed, and segmentation calculations
 * 
 * All coordinates use { lat, lng } format (WGS84 decimal degrees)
 * All distances in meters, speeds in km/h
 */

const EARTH_RADIUS_M = 6_371_000; // Earth's mean radius in meters

/**
 * Convert degrees to radians
 * @param {number} deg 
 * @returns {number}
 */
function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Haversine distance between two points
 * @param {{ lat: number, lng: number }} p1 
 * @param {{ lat: number, lng: number }} p2 
 * @returns {number} distance in meters
 */
export function haversineDistance(p1, p2) {
  const dLat = toRad(p2.lat - p1.lat);
  const dLng = toRad(p2.lng - p1.lng);
  const lat1 = toRad(p1.lat);
  const lat2 = toRad(p2.lat);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_M * c;
}

/**
 * Return every time a track passes the given control node (every local
 * minimum of distance that also stays under `threshold` metres). Used when
 * a single recorrido crosses the same node more than once (e.g. a route
 * that goes out and comes back through the same corner).
 *
 * @param {{lat:number,lng:number}} node
 * @param {Array<{lat:number,lng:number}>} points
 * @param {number} threshold  metres
 * @returns {Array<{trackIndex:number,distance:number}>}
 */
export function findNodeCrossings(node, points, threshold) {
  const crossings = [];
  let inZone = false;
  let bestIdx = -1;
  let bestDist = Infinity;

  for (let i = 0; i < points.length; i++) {
    const d = haversineDistance(node, points[i]);
    if (d <= threshold) {
      if (!inZone) { inZone = true; bestIdx = i; bestDist = d; }
      else if (d < bestDist) { bestIdx = i; bestDist = d; }
    } else if (inZone) {
      crossings.push({ trackIndex: bestIdx, distance: bestDist });
      inZone = false; bestIdx = -1; bestDist = Infinity;
    }
  }
  if (inZone) crossings.push({ trackIndex: bestIdx, distance: bestDist });
  return crossings;
}

/**
 * Total distance of a polyline (sum of consecutive Haversine distances)
 * @param {Array<{ lat: number, lng: number }>} points 
 * @returns {number} total distance in meters
 */
export function totalDistance(points) {
  if (!points || points.length < 2) return 0;

  let dist = 0;
  for (let i = 1; i < points.length; i++) {
    dist += haversineDistance(points[i - 1], points[i]);
  }
  return dist;
}

/**
 * Elapsed time between first and last point
 * @param {Array<{ timestamp: number }>} points 
 * @returns {number} time in seconds
 */
export function elapsedTime(points) {
  if (!points || points.length < 2) return 0;
  return (points[points.length - 1].timestamp - points[0].timestamp) / 1000;
}

/**
 * Average speed calculated from distance and time
 * @param {Array<{ lat: number, lng: number, timestamp: number }>} points 
 * @returns {number} speed in km/h
 */
export function averageSpeed(points) {
  const dist = totalDistance(points); // meters
  const time = elapsedTime(points);  // seconds

  if (time === 0) return 0;

  return (dist / 1000) / (time / 3600); // km/h
}

/**
 * Find the nearest track point to a given reference node
 * @param {{ lat: number, lng: number }} node - reference point
 * @param {Array<{ lat: number, lng: number }>} trackPoints 
 * @returns {{ index: number, distance: number, point: Object }} 
 */
export function findNearestTrackPoint(node, trackPoints) {
  let minDist = Infinity;
  let minIndex = -1;

  for (let i = 0; i < trackPoints.length; i++) {
    const dist = haversineDistance(node, trackPoints[i]);
    if (dist < minDist) {
      minDist = dist;
      minIndex = i;
    }
  }

  return {
    index: minIndex,
    distance: minDist,
    point: minIndex >= 0 ? trackPoints[minIndex] : null,
  };
}

/**
 * Find nearest track points for multiple nodes
 * @param {Array<{ id: string, name: string, lat: number, lng: number }>} nodes 
 * @param {Array} trackPoints 
 * @param {number} maxDistance - maximum distance threshold in meters (default: 500m)
 * @returns {Array<{ node: Object, trackIndex: number, distance: number, withinThreshold: boolean }>}
 */
export function matchNodesToTrack(nodes, trackPoints, maxDistance = 500) {
  return nodes.map((node) => {
    const nearest = findNearestTrackPoint(node, trackPoints);
    return {
      node,
      trackIndex: nearest.index,
      distance: nearest.distance,
      withinThreshold: nearest.distance <= maxDistance,
      trackPoint: nearest.point,
    };
  }).sort((a, b) => a.trackIndex - b.trackIndex);
}

/**
 * Segment a track at specified cut indices
 * @param {Array} trackPoints - complete array of track points
 * @param {Array<number>} cutIndices - sorted array of indices where to split
 * @returns {Array<{ startIndex: number, endIndex: number, points: Array }>}
 */
export function segmentTrack(trackPoints, cutIndices) {
  if (!trackPoints || trackPoints.length === 0) return [];
  if (!cutIndices || cutIndices.length === 0) {
    return [{
      startIndex: 0,
      endIndex: trackPoints.length - 1,
      points: trackPoints,
    }];
  }

  // Deduplicate and sort
  const sorted = [...new Set(cutIndices)].sort((a, b) => a - b);
  const segments = [];

  let prevIndex = 0;

  for (const cutIndex of sorted) {
    if (cutIndex <= prevIndex || cutIndex >= trackPoints.length) continue;

    // Include the cut point in both segments for continuity
    segments.push({
      startIndex: prevIndex,
      endIndex: cutIndex,
      points: trackPoints.slice(prevIndex, cutIndex + 1),
    });
    prevIndex = cutIndex;
  }

  // Last segment (from last cut to end)
  if (prevIndex < trackPoints.length - 1) {
    segments.push({
      startIndex: prevIndex,
      endIndex: trackPoints.length - 1,
      points: trackPoints.slice(prevIndex),
    });
  }

  return segments;
}

/**
 * Calculate metrics for a segment
 * @param {Array<{ lat: number, lng: number, speed: number, timestamp: number }>} points 
 * @returns {{ distance: number, time: number, avgSpeed: number, maxSpeed: number, pointCount: number }}
 */
export function segmentMetrics(points) {
  if (!points || points.length === 0) {
    return { distance: 0, time: 0, avgSpeed: 0, maxSpeed: 0, pointCount: 0 };
  }

  const dist = totalDistance(points);
  const time = elapsedTime(points);
  const avgSpd = averageSpeed(points);

  // Max speed from GPS readings
  let maxSpd = 0;
  for (const p of points) {
    if (p.speed != null && p.speed > maxSpd) {
      maxSpd = p.speed;
    }
  }

  // Convert max speed from m/s to km/h
  maxSpd = maxSpd * 3.6;

  return {
    distance: dist,           // meters
    time: time,               // seconds
    avgSpeed: avgSpd,         // km/h
    maxSpeed: maxSpd,         // km/h
    pointCount: points.length,
  };
}

/**
 * Format distance for display
 * @param {number} meters 
 * @returns {string}
 */
export function formatDistance(meters) {
  if (meters >= 1000) {
    return (meters / 1000).toFixed(2) + ' km';
  }
  return Math.round(meters) + ' m';
}

/**
 * Format time duration for display
 * @param {number} seconds 
 * @returns {string} "HH:MM:SS"
 */
export function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  return [
    h.toString().padStart(2, '0'),
    m.toString().padStart(2, '0'),
    s.toString().padStart(2, '0'),
  ].join(':');
}

/**
 * Format speed for display
 * @param {number} kmh 
 * @returns {string}
 */
export function formatSpeed(kmh) {
  if (kmh == null || isNaN(kmh)) return '0.0';
  return kmh.toFixed(1);
}

/**
 * Generate a palette of distinct colors for segments
 * @param {number} count 
 * @returns {Array<string>} hex colors
 */
export function generateSegmentColors(count) {
  const baseHues = [20, 200, 120, 280, 50, 330, 170, 240, 80, 310];
  const colors = [];

  for (let i = 0; i < count; i++) {
    const hue = baseHues[i % baseHues.length] + Math.floor(i / baseHues.length) * 15;
    const saturation = 70 + (i % 3) * 10;
    const lightness = 55 + (i % 2) * 10;
    colors.push(`hsl(${hue % 360}, ${saturation}%, ${lightness}%)`);
  }

  return colors;
}
