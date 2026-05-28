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

// ============================================================================
// cars-mods v46: bulk resize cacher via inline Web Worker.
// Caches PREVIEW-sized images (resized to maxDim, JPEG q0.8) for ALL tasks —
// not originals — so IndexedDB stays small (~30-50KB/img) and render is fast.
// Worker does fetch + createImageBitmap + OffscreenCanvas resize + IndexedDB put,
// all OFF the main thread (no UI jank). Pause/resume via control messages.
// Resume-across-reload is free: worker has()-checks each URL, cached skip instantly.
// ============================================================================

const BULK_WORKER_SRC = `
const DB_NAME=${JSON.stringify(DB_NAME)}, STORE=${JSON.stringify(STORE)}, DB_VERSION=${DB_VERSION};
let dbp=null;
function openDB(){
  if(dbp) return dbp;
  dbp=new Promise((res,rej)=>{
    let r; try{ r=indexedDB.open(DB_NAME,DB_VERSION); }catch(e){ dbp=null; rej(e); return; }
    r.onupgradeneeded=()=>{ const d=r.result; if(!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE); };
    r.onsuccess=()=>res(r.result);
    r.onerror=()=>{ dbp=null; rej(r.error); };
    r.onblocked=()=>{ dbp=null; rej(new Error("blocked")); };
  });
  return dbp;
}
async function has(url){ try{const db=await openDB(); return await new Promise(res=>{const t=db.transaction(STORE,"readonly"); const q=t.objectStore(STORE).get(url); q.onsuccess=()=>res(!!q.result); q.onerror=()=>res(false);});}catch(e){return false;} }
async function put(url,blob){ try{const db=await openDB(); await new Promise(res=>{const t=db.transaction(STORE,"readwrite"); t.objectStore(STORE).put(blob,url); t.oncomplete=()=>res(); t.onerror=()=>res(); t.onabort=()=>res();});}catch(e){} }
async function process(url,maxDim,origin){
  try{
    if(await has(url)) return "cached";
    // Worker is created from a blob: URL — resolve relative paths against the real origin
    // so /data/local-files/... hits the LS server, then key the cache by the ORIGINAL url
    // (that's what ImageDataGroup looks up via getCachedBlob(value)).
    const fetchUrl=(url.startsWith("http")||!origin)?url:(origin+url);
    const resp=await fetch(fetchUrl,{credentials:"include"});
    if(!resp.ok) return "err";
    const blob=await resp.blob();
    let out;
    try{
      const bmp=await createImageBitmap(blob);
      const scale=Math.min(1, maxDim/Math.max(bmp.width,bmp.height));
      const w=Math.max(1,Math.round(bmp.width*scale)), h=Math.max(1,Math.round(bmp.height*scale));
      const cv=new OffscreenCanvas(w,h);
      cv.getContext("2d").drawImage(bmp,0,0,w,h);
      bmp.close();
      out=await cv.convertToBlob({type:"image/jpeg",quality:0.8});
    }catch(e){ out=blob; } // resize failed (decode error?) — store original as fallback
    await put(url,out);
    return "ok";
  }catch(e){ return "err"; }
}
let queue=[], active=0, paused=false, maxDim=512, conc=6, done=0, total=0, ok=0, cached=0, err=0, origin="";
function pump(){
  if(paused) return;
  while(active<conc && queue.length){
    const url=queue.shift();
    active++;
    process(url,maxDim,origin).then((r)=>{
      active--; done++;
      if(r==="ok") ok++; else if(r==="cached") cached++; else err++;
      if(done%20===0 || queue.length===0){ postMessage({type:"progress",done,total,ok,cached,err}); }
      if(queue.length===0 && active===0){ postMessage({type:"complete",done,total,ok,cached,err}); }
      else pump();
    });
  }
}
self.onmessage=(e)=>{
  const m=e.data||{};
  if(m.type==="start"){ queue=m.urls.slice(); total=queue.length; done=0; ok=0; cached=0; err=0; maxDim=m.maxDim||512; conc=m.concurrency||6; origin=m.origin||""; paused=false; pump(); }
  else if(m.type==="pause"){ paused=true; postMessage({type:"paused",done,total,ok,cached,err}); }
  else if(m.type==="resume"){ if(paused){ paused=false; pump(); } }
  else if(m.type==="stop"){ paused=true; queue=[]; postMessage({type:"stopped",done,total,ok,cached,err}); }
};
`;

/**
 * Create a bulk cacher backed by an inline Web Worker.
 * @returns {{ start:(urls:string[])=>void, pause:()=>void, resume:()=>void, stop:()=>void, terminate:()=>void }}
 */
export function createBulkCacher({ maxDim = 512, concurrency = 6, onProgress, onComplete } = {}) {
  let worker = null;
  let blobUrl = null;
  try {
    blobUrl = URL.createObjectURL(new Blob([BULK_WORKER_SRC], { type: "application/javascript" }));
    worker = new Worker(blobUrl);
  } catch (e) {
    return {
      start() {},
      pause() {},
      resume() {},
      stop() {},
      terminate() {},
      unsupported: true,
    };
  }
  worker.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === "progress" || m.type === "paused" || m.type === "stopped") {
      onProgress?.(m);
    } else if (m.type === "complete") {
      onProgress?.(m);
      onComplete?.(m);
    }
  };
  const cleanup = () => {
    try { worker?.terminate(); } catch (_) {}
    try { if (blobUrl) URL.revokeObjectURL(blobUrl); } catch (_) {}
    worker = null;
  };
  return {
    start(urls) {
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      worker?.postMessage({ type: "start", urls, maxDim, concurrency, origin });
    },
    pause() { worker?.postMessage({ type: "pause" }); },
    resume() { worker?.postMessage({ type: "resume" }); },
    stop() { worker?.postMessage({ type: "stop" }); },
    terminate: cleanup,
  };
}

/**
 * Paginate the DM tasks API to collect every image URL for a project.
 * Lightweight — only reads data.image/data.thumb. ~1 call per 1000 tasks.
 */
export async function fetchAllImageUrls(projectId, onChunk, signal) {
  const urls = [];
  let page = 1;
  const PAGE_SIZE = 1000;
  // safety cap — avoid infinite loop on API quirk
  for (let guard = 0; guard < 1000; guard++) {
    if (signal?.aborted) break;
    let resp;
    try {
      resp = await fetch(
        `/api/dm/tasks?project=${projectId}&page=${page}&page_size=${PAGE_SIZE}`,
        { credentials: "same-origin", signal },
      );
    } catch (_) {
      break;
    }
    if (!resp.ok) break;
    let data;
    try { data = await resp.json(); } catch (_) { break; }
    const tasks = data?.tasks ?? [];
    if (!tasks.length) break;
    for (const t of tasks) {
      const img = t?.data?.image || t?.data?.thumb;
      if (img && typeof img === "string") urls.push(img);
    }
    onChunk?.(urls.length);
    if (tasks.length < PAGE_SIZE) break;
    page++;
  }
  return urls;
}
