// cars-mods v45: persistent image cache via IndexedDB (survives reloads + sessions + days).
// Why IndexedDB (not Service Worker): SW registered from the app bundle gets scope /static/,
// but image URLs live at /data/local-files/ — SW would not intercept them without a
// Service-Worker-Allowed:/ header (requires Python/Docker changes). IndexedDB is pure
// frontend, persistent, ~50% disk quota (tens of GB). We wire cache → <img> manually.
//
// Storage: object store keyed by image URL → Blob value.
// Read path: ImageDataGroup checks cache on mount; on hit → URL.createObjectURL(blob).
// Write path: warmCache button (GridView) batch-fetches + stores; also opportunistic
// caching on first network render.

const DB_NAME = "cars-image-cache";
const STORE = "previews";
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      dbPromise = null; // allow retry next call
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE); // key = url string, value = Blob
      }
    };
    req.onsuccess = () => resolve(req.result);
    // Review fix #2: reset singleton on failure so a later call can retry the open
    // (private mode / quota / transient browser error must not poison the whole session).
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      dbPromise = null;
      reject(new Error("indexedDB open blocked"));
    };
  });
  return dbPromise;
}

export async function getCachedBlob(url) {
  if (!url) return null;
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(url);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function putCachedBlob(url, blob) {
  if (!url || !blob) return;
  try {
    const db = await openDB();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, url);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* quota exceeded or other — fail silently, falls back to network */
  }
}

// Fetch + store if not already cached. Returns true if cached (now or before).
export async function cacheImageUrl(url) {
  if (!url) return false;
  const existing = await getCachedBlob(url);
  if (existing) return true;
  try {
    const resp = await fetch(url, { credentials: "same-origin" });
    if (!resp.ok) return false;
    const blob = await resp.blob();
    await putCachedBlob(url, blob);
    return true;
  } catch {
    return false;
  }
}

// Count entries (for UI status). Cheap-ish — uses count() on the store.
export async function cacheCount() {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(0);
    });
  } catch {
    return 0;
  }
}

// Wipe entire cache (admin/reset).
export async function clearCache() {
  try {
    const db = await openDB();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {}
}
