// db.js — Eclipse IndexedDB layer
const DB_NAME    = 'eclipse-store';
const DB_VERSION = 1;
const STORE_FILES = 'app-files';
const STORE_META  = 'app-meta';

let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_FILES))
        db.createObjectStore(STORE_FILES);   // key = "appId/rel/path"
      if (!db.objectStoreNames.contains(STORE_META))
        db.createObjectStore(STORE_META);    // key = appId, value = meta obj
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = e => reject(e.target.error);
  });
}

export async function putFile(appId, relativePath, arrayBuffer) {
  const db  = await openDB();
  const key = `${appId}/${relativePath}`;
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_FILES, 'readwrite');
    const req = tx.objectStore(STORE_FILES).put(arrayBuffer, key);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

export async function getFile(appId, relativePath) {
  const db  = await openDB();
  const key = `${appId}/${relativePath}`;
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_FILES, 'readonly');
    const req = tx.objectStore(STORE_FILES).get(key);
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror   = e => reject(e.target.error);
  });
}

export async function deleteApp(appId) {
  const db = await openDB();
  // Delete all files prefixed appId/
  await new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_FILES, 'readwrite');
    const st  = tx.objectStore(STORE_FILES);
    const req = st.openCursor();
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (!cursor) return;
      if (cursor.key.startsWith(`${appId}/`)) cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
  // Delete meta
  await setMeta(appId, null);
}

export async function setMeta(appId, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_META, 'readwrite');
    const st  = tx.objectStore(STORE_META);
    const req = value === null ? st.delete(String(appId)) : st.put(value, String(appId));
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

export async function getMeta(appId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_META, 'readonly');
    const req = tx.objectStore(STORE_META).get(String(appId));
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror   = e => reject(e.target.error);
  });
}

export async function getAllMetaKeys() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_META, 'readonly');
    const req = tx.objectStore(STORE_META).getAllKeys();
    req.onsuccess = e => resolve(e.target.result ?? []);
    req.onerror   = e => reject(e.target.error);
  });
}
