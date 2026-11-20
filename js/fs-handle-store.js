'use strict';

// O popup escolhe o arquivo (precisa de gesto do usuário) e guarda o handle aqui.
// O documento offscreen, que é quem grava, lê o handle do mesmo IndexedDB
// (mesma origem chrome-extension://<id>).
const TVRFileHandleStore = (() => {
  const DB_NAME = 'tvr-fs-handles';
  const DB_VERSION = 1;
  const STORE = 'handles';
  const KEY = 'target';

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB indisponível.'));
    });
    return dbPromise;
  }

  async function save(handle) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('Falha ao guardar o arquivo escolhido.'));
      tx.onabort = () => reject(tx.error || new Error('Transação abortada.'));
    });
  }

  async function load() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Falha ao ler o arquivo escolhido.'));
    });
  }

  async function clear() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('Falha ao limpar o arquivo escolhido.'));
    });
  }

  return { save, load, clear };
})();

// Scripts clássicos: `const` no topo não vira propriedade de window, então expõe explicitamente
// para o popup e para o documento offscreen.
self.TVRFileHandleStore = TVRFileHandleStore;
