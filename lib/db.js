/**
 * TrafingVelocidad — IndexedDB Wrapper
 * Persistent storage for GPS tracks and points
 * 
 * Database: TrafingVelocidadDB v1
 * Stores:
 *   - tracks: { id, name, startTime, endTime, status, pointCount }
 *   - points: { id, trackId, lat, lng, speed, accuracy, altitude, timestamp }
 */

const DB_NAME = 'TrafingVelocidadDB';
const DB_VERSION = 1;

let dbInstance = null;

/**
 * Open or create the IndexedDB database
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Tracks store
      if (!db.objectStoreNames.contains('tracks')) {
        const trackStore = db.createObjectStore('tracks', { keyPath: 'id' });
        trackStore.createIndex('status', 'status', { unique: false });
        trackStore.createIndex('startTime', 'startTime', { unique: false });
      }

      // Points store
      if (!db.objectStoreNames.contains('points')) {
        const pointStore = db.createObjectStore('points', { keyPath: 'id', autoIncrement: true });
        pointStore.createIndex('trackId', 'trackId', { unique: false });
        pointStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;

      // Handle connection close
      dbInstance.onclose = () => {
        dbInstance = null;
      };

      resolve(dbInstance);
    };

    request.onerror = (event) => {
      console.error('[DB] Failed to open database:', event.target.error);
      reject(event.target.error);
    };
  });
}

/**
 * Generic transaction helper
 * @param {string} storeName 
 * @param {string} mode - 'readonly' | 'readwrite'
 * @param {Function} callback - receives the object store
 * @returns {Promise<any>}
 */
async function withStore(storeName, mode, callback) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = callback(store);

    if (result && result.onsuccess !== undefined) {
      result.onsuccess = () => resolve(result.result);
      result.onerror = () => reject(result.error);
    } else {
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
    }
  });
}

// ── Track Operations ─────────────────────────────────────────

/**
 * Create a new track record
 * @param {Object} track - { id, name, startTime, status }
 * @returns {Promise<string>} track id
 */
export async function createTrack(track) {
  const record = {
    id: track.id || crypto.randomUUID(),
    name: track.name || `Track ${new Date().toLocaleString()}`,
    startTime: track.startTime || Date.now(),
    endTime: null,
    status: track.status || 'recording',
    pointCount: 0,
    ...track,
  };

  await withStore('tracks', 'readwrite', (store) => store.put(record));
  return record.id;
}

/**
 * Update a track's metadata
 * @param {string} id 
 * @param {Object} data - partial update
 * @returns {Promise<void>}
 */
export async function updateTrack(id, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tracks', 'readwrite');
    const store = tx.objectStore('tracks');
    const getReq = store.get(id);

    getReq.onsuccess = () => {
      const track = getReq.result;
      if (!track) {
        reject(new Error(`Track ${id} not found`));
        return;
      }
      const updated = { ...track, ...data };
      const putReq = store.put(updated);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };

    getReq.onerror = () => reject(getReq.error);
  });
}

/**
 * Get a single track by ID
 * @param {string} id 
 * @returns {Promise<Object|null>}
 */
export async function getTrack(id) {
  return withStore('tracks', 'readonly', (store) => store.get(id));
}

/**
 * Get all tracks, sorted by startTime descending
 * @returns {Promise<Array>}
 */
export async function getAllTracks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tracks', 'readonly');
    const store = tx.objectStore('tracks');
    const request = store.getAll();

    request.onsuccess = () => {
      const tracks = request.result || [];
      tracks.sort((a, b) => b.startTime - a.startTime);
      resolve(tracks);
    };

    request.onerror = () => reject(request.error);
  });
}

/**
 * Get only tracks that have not been synced to the cloud yet
 * @returns {Promise<Array>}
 */
export async function getUnsyncedTracks() {
  const all = await getAllTracks();
  return all.filter((t) => !t.synced && (t.status === 'completed' || t.endTime));
}

/**
 * Delete a track and all its points
 * @param {string} trackId
 * @returns {Promise<void>}
 */
export async function deleteTrack(trackId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['tracks', 'points'], 'readwrite');
    const trackStore = tx.objectStore('tracks');
    const pointStore = tx.objectStore('points');

    // Delete the track
    trackStore.delete(trackId);

    // Delete all points for this track
    const index = pointStore.index('trackId');
    const range = IDBKeyRange.only(trackId);
    const cursorReq = index.openCursor(range);

    cursorReq.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Point Operations ─────────────────────────────────────────

/**
 * Add a single GPS point
 * @param {Object} point - { trackId, lat, lng, speed, accuracy, altitude, timestamp }
 * @returns {Promise<number>} auto-incremented point id
 */
export async function addPoint(point) {
  const record = {
    trackId: point.trackId,
    lat: point.lat,
    lng: point.lng,
    speed: point.speed ?? null,
    accuracy: point.accuracy ?? null,
    altitude: point.altitude ?? null,
    timestamp: point.timestamp || Date.now(),
  };

  const id = await withStore('points', 'readwrite', (store) => store.add(record));

  // Update point count on the track (fire-and-forget)
  incrementPointCount(point.trackId).catch(() => {});

  return id;
}

/**
 * Increment pointCount on a track record
 * @param {string} trackId 
 */
async function incrementPointCount(trackId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tracks', 'readwrite');
    const store = tx.objectStore('tracks');
    const getReq = store.get(trackId);

    getReq.onsuccess = () => {
      const track = getReq.result;
      if (track) {
        track.pointCount = (track.pointCount || 0) + 1;
        store.put(track);
      }
      resolve();
    };

    getReq.onerror = () => reject(getReq.error);
  });
}

/**
 * Get all points for a track, sorted by timestamp
 * @param {string} trackId 
 * @returns {Promise<Array>}
 */
export async function getTrackPoints(trackId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('points', 'readonly');
    const store = tx.objectStore('points');
    const index = store.index('trackId');
    const range = IDBKeyRange.only(trackId);
    const request = index.getAll(range);

    request.onsuccess = () => {
      const points = request.result || [];
      points.sort((a, b) => a.timestamp - b.timestamp);
      resolve(points);
    };

    request.onerror = () => reject(request.error);
  });
}

/**
 * Get the last N points for a track (for live display)
 * @param {string} trackId 
 * @param {number} n 
 * @returns {Promise<Array>}
 */
export async function getLastPoints(trackId, n = 50) {
  const points = await getTrackPoints(trackId);
  return points.slice(-n);
}

/**
 * Get total point count for a track
 * @param {string} trackId 
 * @returns {Promise<number>}
 */
export async function getPointCount(trackId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('points', 'readonly');
    const store = tx.objectStore('points');
    const index = store.index('trackId');
    const range = IDBKeyRange.only(trackId);
    const request = index.count(range);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Export all data (for backup/sync)
 * @returns {Promise<Object>} { tracks, points }
 */
export async function exportAllData() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['tracks', 'points'], 'readonly');
    const trackReq = tx.objectStore('tracks').getAll();
    const pointReq = tx.objectStore('points').getAll();

    tx.oncomplete = () => {
      resolve({
        tracks: trackReq.result || [],
        points: pointReq.result || [],
        exportedAt: new Date().toISOString(),
      });
    };

    tx.onerror = () => reject(tx.error);
  });
}
