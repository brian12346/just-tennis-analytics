(() => {
  // Browser cache that survives page reloads (IndexedDB, this browser only). Keeps the dashboard from downloading the
  // same data again on every visit: query results for 30 minutes, and Amazon day documents longer the older the day is
  // (see dayTtl). Anything going wrong here (private window, storage blocked or full) just means no cache.
  const DB = "jt-cache", STORE = "kv", MAX_BYTES = 80 * 1024 * 1024;
  let dbP = null;
  function open() {
    if (dbP) return dbP;
    dbP = new Promise((res) => {
      try {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => { const s = r.result.createObjectStore(STORE); s.createIndex("t", "t"); };
        r.onsuccess = () => res(r.result);
        r.onerror = r.onblocked = () => res(null);
      } catch (_) { res(null); }
    });
    return dbP;
  }
  const tx = async (mode, fn) => {
    const db = await open(); if (!db) return null;
    return new Promise((res) => {
      try {
        const t = db.transaction(STORE, mode), s = t.objectStore(STORE);
        const out = fn(s);
        t.oncomplete = () => res(out && "result" in out ? out.result : null);
        t.onerror = t.onabort = () => res(null);
      } catch (_) { res(null); }
    });
  };
  // {t: saved at, v: value, n: size} by key
  const get = (k) => tx("readonly", s => s.get(k));
  async function getMany(keys) {
    const db = await open(); if (!db || !keys.length) return keys.map(() => null);
    return new Promise((res) => {
      try {
        const t = db.transaction(STORE, "readonly"), s = t.objectStore(STORE), out = new Array(keys.length).fill(null);
        keys.forEach((k, i) => { const r = s.get(k); r.onsuccess = () => { out[i] = r.result || null; }; });
        t.oncomplete = () => res(out); t.onerror = t.onabort = () => res(keys.map(() => null));
      } catch (_) { res(keys.map(() => null)); }
    });
  }
  let used = null;
  async function put(k, v) {
    let n = 0; try { n = JSON.stringify(v).length; } catch (_) { return; }
    if (n > 8 * 1024 * 1024) return;                   // not worth keeping one huge reply
    await tx("readwrite", s => s.put({ t: Date.now(), v, n }, k));
    used = (used || 0) + n;
    if (used > MAX_BYTES) trim();
  }
  async function putMany(entries) {
    const now = Date.now();
    await tx("readwrite", s => { for (const [k, v] of entries) { let n = 0; try { n = JSON.stringify(v).length; } catch (_) { continue; } s.put({ t: now, v, n }, k); used = (used || 0) + n; } });
    if (used > MAX_BYTES) trim();
  }
  // Drop the oldest entries until the cache is back under 3/4 of its size limit.
  async function trim() {
    const db = await open(); if (!db) return;
    try {
      const t = db.transaction(STORE, "readwrite"), s = t.objectStore(STORE);
      let total = 0; const all = [];
      s.index("t").openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (c) { all.push([c.primaryKey, c.value.n || 0]); total += c.value.n || 0; c.continue(); return; }
        for (const [k, n] of all) { if (total <= MAX_BYTES * 0.75) break; s.delete(k); total -= n; }
        used = total;
      };
    } catch (_) {}
  }
  const del = (k) => tx("readwrite", s => s.delete(k));
  // Delete every key starting with `prefix` (all keys when empty).
  async function clear(prefix) {
    if (!prefix) { used = 0; return tx("readwrite", s => s.clear()); }
    return tx("readwrite", s => s.delete(IDBKeyRange.bound(prefix, prefix + "￿")));
  }

  // How long an Amazon day document stays good, by how old the day is: recent days still change (orders ship, fees
  // post, refunds come in), older ones rarely do. Refresh on the tab always reloads the shown days.
  function dayTtl(day, today) {
    const age = Math.round((new Date(today + "T12:00:00Z") - new Date(day + "T12:00:00Z")) / 864e5);
    if (age <= 2) return 30 * 60000;
    if (age <= 14) return 6 * 3600000;
    if (age <= 60) return 24 * 3600000;
    return 7 * 24 * 3600000;
  }
  window.JTCache = { get, getMany, put, putMany, del, clear, dayTtl };
})();
