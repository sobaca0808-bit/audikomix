(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlleyDirectorStorage = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const DB_NAME = 'alley-director-v1';
  const DB_VERSION = 1;
  const MAX_MEDIA = 32 * 1024 * 1024;
  const MAX_PROJECT = 1024 * 1024;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const copy = value => JSON.parse(JSON.stringify(value));
  function storageError(error, fallback) {
    if (error?.name === 'QuotaExceededError') return new Error('В браузере недостаточно места. Освободите место или экспортируйте проект и звук.');
    if (error?.name === 'SecurityError' || error?.name === 'InvalidStateError') return new Error('Браузер запретил локальное хранилище. Откройте плеер через HTTP и разрешите хранение данных.');
    return new Error(fallback || 'Не удалось сохранить данные в браузере.');
  }
  function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value); }

  function create(options = {}) {
    const indexedDB = own(options, 'indexedDB') ? options.indexedDB : root.indexedDB;
    let connection = null;
    function open() {
      if (!indexedDB || typeof indexedDB.open !== 'function') return Promise.reject(new Error('Локальное хранилище недоступно. Сохранение не выполнено; экспортируйте проект и аудиофайлы.'));
      if (connection) return connection;
      connection = new Promise((resolve, reject) => {
        let request, settled = false;
        function fail(error, message) {
          if (settled) return;
          settled = true; connection = null; reject(storageError(error, message));
        }
        try { request = indexedDB.open(DB_NAME, DB_VERSION); }
        catch (error) { fail(error); return; }
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains('projects')) database.createObjectStore('projects', { keyPath: 'id' });
          if (!database.objectStoreNames.contains('media')) database.createObjectStore('media', { keyPath: 'id' });
        };
        request.onblocked = () => fail(null, 'Хранилище занято другой вкладкой. Закройте её и попробуйте сохранить ещё раз.');
        request.onerror = () => fail(request.error);
        request.onsuccess = () => {
          const database = request.result;
          if (settled) { database.close(); return; }
          settled = true;
          database.onversionchange = () => { database.close(); connection = null; };
          resolve(database);
        };
      });
      // A synchronous open failure must not leave a rejected cached promise.
      connection.catch(() => { connection = null; });
      return connection;
    }

    async function transaction(names, mode, action) {
      const database = await open();
      return new Promise((resolve, reject) => {
        let tx, output, explicitError;
        try { tx = database.transaction(names, mode); }
        catch (error) { reject(storageError(error)); return; }
        tx.oncomplete = () => resolve(output);
        tx.onabort = () => reject(explicitError || storageError(tx.error));
        tx.onerror = () => { /* The abort event reports failure; request success is not a commit. */ };
        function result(value) { output = value; }
        function abort(error) {
          explicitError = error instanceof Error ? error : storageError(error);
          try { tx.abort(); } catch (_) { reject(explicitError); }
        }
        try { action(tx, result, abort); }
        catch (error) { abort(storageError(error)); }
      });
    }

    async function load() {
      return transaction(['projects'], 'readonly', (tx, result) => {
        const request = tx.objectStore('projects').get('current');
        request.onsuccess = () => result(request.result?.project ? copy(request.result.project) : null);
      });
    }

    async function save(project) {
      let value, serialized;
      try { serialized = JSON.stringify(project); value = JSON.parse(serialized); }
      catch (_) { throw new Error('Проект не является корректным JSON. Сохранение не выполнено.'); }
      const length = typeof TextEncoder === 'function' ? new TextEncoder().encode(serialized).length : serialized.length * 3;
      if (length > MAX_PROJECT || value?.format !== 'alley-director' || value?.version !== 1 || !Array.isArray(value.scenes) || !Array.isArray(value.media)) throw new Error('Некорректный или слишком большой проект. Сохранение не выполнено.');
      return transaction(['projects'], 'readwrite', (tx, result) => {
        tx.objectStore('projects').put({ id: 'current', project: value });
        result(copy(value));
      });
    }

    async function putMedia({ id, blob, metadata } = {}) {
      if (!validId(id) || !blob || typeof blob.arrayBuffer !== 'function' || !Number.isFinite(blob.size) || blob.size < 1 || blob.size > MAX_MEDIA) throw new Error('Недопустимый аудиофайл или его размер превышает 32 МБ.');
      if (!metadata || metadata.id !== id || metadata.size !== blob.size || typeof metadata.name !== 'string' || !metadata.name.trim() || metadata.name.length > 240 || /[\\/\u0000-\u001f]/.test(metadata.name) || typeof metadata.type !== 'string' || !Number.isFinite(metadata.durationMs) || metadata.durationMs <= 0 || metadata.durationMs > 600000) throw new Error('Описание аудиофайла не соответствует файлу.');
      const meta = { id, name: metadata.name, type: metadata.type, size: metadata.size, durationMs: Math.round(metadata.durationMs) };
      return transaction(['media'], 'readwrite', (tx, result, abort) => {
        const store = tx.objectStore('media');
        const request = store.get(id);
        request.onsuccess = () => {
          if (request.result) { abort(new Error('Этот аудиофайл уже сохранён. Для замены добавьте файл с новым идентификатором.')); return; }
          store.add({ id, blob, metadata: meta });
          result(copy(meta));
        };
      });
    }

    async function getMedia(id) {
      if (!validId(id)) return null;
      return transaction(['media'], 'readonly', (tx, result) => {
        const request = tx.objectStore('media').get(id);
        request.onsuccess = () => result(request.result?.blob || null);
      });
    }

    async function listMedia() {
      return transaction(['media'], 'readonly', (tx, result) => {
        const request = tx.objectStore('media').getAll();
        request.onsuccess = () => result(request.result.map(item => copy(item.metadata)));
      });
    }

    async function deleteMedia(id) {
      if (!validId(id)) throw new Error('Недопустимый идентификатор аудиофайла.');
      return transaction(['projects', 'media'], 'readwrite', (tx, result, abort) => {
        const request = tx.objectStore('projects').get('current');
        request.onsuccess = () => {
          const project = request.result?.project;
          if (project?.scenes?.some(scene => scene.tracks?.some(track => track.assetId === id))) {
            abort(new Error('Аудиофайл используется сохранённым проектом. Сначала удалите дорожку из проекта и сохраните изменения.'));
            return;
          }
          tx.objectStore('media').delete(id);
          result(undefined);
        };
      });
    }

    return { load, save, putMedia, getMedia, listMedia, deleteMedia };
  }

  return { create, DB_NAME, DB_VERSION };
});
