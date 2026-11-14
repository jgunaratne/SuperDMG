// Browser persistence: preferences and battery saves in localStorage, and the most
// recently played ROM plus upgraded HD tile packs in IndexedDB so a reload picks up
// where you left off. Everything degrades to "not remembered" if storage is unavailable.

const SETTINGS_KEY = 'gameboy.settings';
const SAVE_PREFIX = 'gameboy.save.';
const DB_NAME = 'gameboy';
const STORE = 'roms';
const HD_STORE = 'hdtiles';
const HD_SCHEMA = 'v5';
const LEGACY_HD_SCHEMA = 'v4';

export function loadSettings(defaults) {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* storage full or blocked */ }
}

/** Stable identifier for a cartridge based on its header title and ROM checksum. */
export function cartridgeId(cart) {
  const { title, globalChecksum } = cart.header;
  return `${(title || 'untitled').replace(/\s+/g, '_')}.${globalChecksum.toString(16).padStart(4, '0')}`;
}

/** Saves are keyed by title and checksum, so revisions of a game do not collide. */
function saveKey(cart) {
  const { title, globalChecksum } = cart.header;
  return `${SAVE_PREFIX}${title || 'untitled'}.${globalChecksum.toString(16).padStart(4, '0')}`;
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Writes the cartridge's battery RAM. Returns false if it could not be stored. */
export function storeBatterySave(cart) {
  const data = cart.getSaveData();
  if (!data) return false;
  try {
    localStorage.setItem(saveKey(cart), toBase64(data));
    cart.ramDirty = false;
    return true;
  } catch {
    return false;
  }
}

/** Restores battery RAM saved earlier for this cartridge. Returns whether one existed. */
export function restoreBatterySave(cart) {
  if (!cart.hasBattery) return false;
  try {
    const text = localStorage.getItem(saveKey(cart));
    if (!text) return false;
    cart.loadSaveData(fromBase64(text));
    return true;
  } catch {
    return false;
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(HD_STORE)) db.createObjectStore(HD_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function rememberRom(name, bytes) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ name, bytes }, 'last');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* not remembered */ }
}

/** @return {Promise<?{name: string, bytes: Uint8Array}>} */
export async function recallRom() {
  try {
    const db = await openDb();
    const entry = await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get('last');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return entry;
  } catch {
    return null;
  }
}

export async function storeHdPack(cartId, style, record) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HD_STORE, 'readwrite');
      tx.objectStore(HD_STORE).put(record, `${HD_SCHEMA}:${cartId}.${style}`);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* non-fatal */ }
}

export async function recallHdPack(cartId, style) {
  try {
    const db = await openDb();
    const getKey = (schema) => new Promise((resolve, reject) => {
      const request = db.transaction(HD_STORE).objectStore(HD_STORE).get(`${schema}:${cartId}.${style}`);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    const record = (await getKey(HD_SCHEMA)) || (await getKey(LEGACY_HD_SCHEMA));
    db.close();
    return record;
  } catch {
    return null;
  }
}

export async function deleteHdPack(cartId, style) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HD_STORE, 'readwrite');
      tx.objectStore(HD_STORE).delete(`${HD_SCHEMA}:${cartId}.${style}`);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* non-fatal */ }
}
