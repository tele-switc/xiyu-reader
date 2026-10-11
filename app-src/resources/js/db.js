/* IndexedDB 封装：书籍、进度、书签、生词本、翻译缓存 */
const DB = (() => {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const req = indexedDB.open('spa-reader', 2);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache');
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    return dbp;
  }
  function tx(store, mode, fn) {
    return open().then(db => new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      fn(s, r => { out = r; });
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
    }));
  }
  const wrap = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  return {
    putBook: meta => tx('books', 'readwrite', s => s.put(meta)),
    delBook: async id => { await tx('books', 'readwrite', s => s.delete(id));
      await tx('files', 'readwrite', s => s.delete(id));
      await tx('kv', 'readwrite', s => s.delete('meta:' + id)); },
    listBooks: () => tx('books', 'readonly', (s, done) => { const r = s.getAll(); r.onsuccess = () => done(r.result); }),
    getBook: id => tx('books', 'readonly', (s, done) => { const r = s.get(id); r.onsuccess = () => done(r.result); }),
    putFile: (id, blob) => tx('files', 'readwrite', s => s.put(blob, id)),
    getFile: id => tx('files', 'readonly', (s, done) => { const r = s.get(id); r.onsuccess = () => done(r.result); }),
    traceKV: msg => { try { tx('kv', 'readwrite', s => s.put({ t: Date.now(), msg }, 'trace:open')); } catch (e) {} },
    getTrace: () => tx('kv', 'readonly', (s, done) => { const r = s.get('trace:open'); r.onsuccess = () => done(r.result); }),
    getKV: async key => { try { return await tx('kv', 'readonly', (s, done) => { const r = s.get(key); r.onsuccess = () => done(r.result); }); } catch (e) { return null; } },
    setKV: (key, val) => tx('kv', 'readwrite', s => s.put(val, key)),
    cacheGet: async key => { try { return await tx('cache', 'readonly', (s, done) => { const r = s.get(key); r.onsuccess = () => done(r.result); }); } catch (e) { return null; } },
    cacheSet: (key, val) => tx('cache', 'readwrite', s => s.put(val, key)).catch(() => {}),
  };
})();
