/* ============================================================================
   تيسير — Persistent client-side file & listing cache  (IndexedDB)

   PURPOSE
   -------
   Make re-opening a file and re-entering a folder INSTANT, even after the
   browser was fully closed and reopened, WITHOUT the file ever landing in the
   phone's Downloads folder or being saved as a visible file. Everything lives
   inside the site's own IndexedDB (private origin storage) and is rendered from
   an in-memory Blob URL, so the OS download manager is never involved.

   SECURITY MODEL (this must not weaken the existing file-link security)
   --------------------------------------------------------------------
   • The FIRST time a file (or listing) is requested it is ALWAYS fetched through
     the Worker. Only bytes the server AGREED to serve are ever written here.
   • There are NO accounts, sessions or signed-in users in this app, so the cache
     is scoped to a single fixed ANON_SCOPE instead of a user id. Isolation comes
     from the browser itself: IndexedDB is partitioned per origin AND per browser
     profile, so one visitor can never read another visitor's cached bytes — a
     per-visitor key would add nothing on top of that.
   • Because the scope is constant it can never "change", so the cache is NEVER
     implicitly wiped. HTTP errors, timeouts and network failures all leave every
     stored file untouched: such failures are usually transient and losing the
     whole cache over one is unacceptable. The ONLY wipe is an explicit
     FileCache.clearAll() call.
   • Access enforcement stays on the SERVER: the first fetch of any file/listing
     still goes through the Worker route, so the cache only ever holds bytes the
     server already agreed to serve.
   • Nothing secret (tokens, API keys) is ever stored — only the already-served
     bytes + safe metadata, exactly what the browser already held in memory.

   STORAGE HYGIENE
   ---------------
   • Two SEPARATE size limits: a PER-FILE cap (MAX_FILE_BYTES) and a WHOLE-CACHE
     budget (MAX_TOTAL_BYTES). They used to be one constant, which meant a single
     large file consumed the entire budget and evicted everything else. The total
     budget is additionally clamped to the device's real quota via
     navigator.storage.estimate(), so iOS Safari's small quota is respected while
     Android/desktop get to use much more space.
   • LRU eviction (oldest `savedAt` first, refreshed on every cache hit) runs
     until BOTH the entry-count cap and the effective byte budget are satisfied,
     so device storage never fills up.
   • Folder listings are cached separately (tiny) with a short freshness window;
     files are cached with their content-type so the viewer can rebuild a Blob.

   This module exposes a single global: `window.FileCache`.
   ========================================================================== */
(function () {
  'use strict';

  var DB_NAME = 'taysir-lib-cache';
  // NOTE: bumped 2 → 3 to repair databases left in a partial state (missing one
  // of the three stores) by an earlier build. The upgrade handler below creates
  // every store idempotently, so a plain versioned upgrade fully heals such a
  // DB. The DB is NEVER opened at a version above this constant — doing so would
  // leave the on-disk DB ahead of the version later loads request, making every
  // subsequent open fail permanently with VersionError.
  var DB_VERSION = 3;
  var STORE_FILES = 'files';       // { id, sessionKey, data:ArrayBuffer, contentType, name, savedAt, bytes }
  // NOTE (iOS fix): file bytes are stored as an ArrayBuffer in `data`, NOT as a
  // Blob. iOS Safari has long-standing WebKit bugs where Blob records written
  // to IndexedDB become unreadable after the browser is fully closed and
  // reopened (the row is still there, blob.size looks fine, but reading the
  // bytes fails) — which made every reopen a re-download on iPhone/iPad.
  // ArrayBuffers are serialized inline into the database and survive restarts
  // reliably on every platform. Legacy rows that still hold a Blob are read
  // if usable and migrated opportunistically; no version bump / wipe needed.
  var STORE_LISTINGS = 'listings'; // { key, sessionKey, data, savedAt }
  var STORE_META = 'meta';         // { key:'session', value:<sessionKey> }

  /* --------------------------------------------------------- size budgets
     TWO DISTINCT limits — conflating them was a real bug: a single 100 MB file
     used to consume the whole cache budget and evict every other file, so
     students who opened one large document lost every small one.

       • MAX_FILE_BYTES  — per-file cap. A single file larger than this is never
                           cached at all (it would be pointless churn).
       • MAX_TOTAL_BYTES — ceiling for the SUM of all cached file bytes, i.e.
                           the whole-cache budget. Deliberately much larger than
                           the per-file cap so several large files can coexist.
       • MAX_FILES       — secondary cap on the entry COUNT (files may now be
                           smaller on average, so this is generous).

     The effective total budget is additionally clamped at runtime to what the
     device actually offers (see initStorageBudget / navigator.storage.estimate). */
  var MAX_FILE_BYTES  = 150 * 1024 * 1024;         // ~150 MB per single file
  var MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;    // ~2 GB whole-cache budget
  var MAX_FILES = 200;                             // keep at most N recent files
  // Folder listings are cheap; keep a generous recent set.
  var MAX_LISTINGS = 400;
  // How long a cached listing is served before we treat it as stale and refresh
  // in the background (content still shows instantly meanwhile).
  var LISTING_FRESH_MS = 5 * 60 * 1000;     // 5 minutes

  var _dbPromise = null;
  // Fixed scope for an account-less site. IndexedDB is already isolated per
  // origin + browser profile, so this is only a namespace tag on each row.
  var ANON_SCOPE = 'anon';
  var _sessionKey = ANON_SCOPE;   // always bound; never null
  var _supported = ('indexedDB' in window);

  /* ------------------------------------------------------------------- log
     Lightweight, non-blocking instrumentation. Every call is wrapped so a
     missing/!throwing console (or a frozen console in some webviews) can never
     affect control flow. Prefix is always "[cache]" so the whole cache lifecycle
     can be filtered in devtools with a single search. */
  function log() {
    try {
      if (typeof console === 'undefined' || !console || !console.log) return;
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[cache]');
      console.log.apply(console, args);
    } catch (_e) { /* logging must never throw */ }
  }

  /* ------------------------------------------------- adaptive total budget
     MAX_TOTAL_BYTES is only an UPPER bound. The real limit is whatever the
     browser is willing to give this origin, which differs wildly: iOS Safari
     hands out a small quota, while Android Chrome / desktop typically offer
     many GB. Trying to store more than the quota just produces
     QuotaExceededError write failures, so we probe the quota once (best effort)
     via navigator.storage.estimate() and clamp the budget to it.

       effective = max(MAX_FILE_BYTES, min(MAX_TOTAL_BYTES, floor(quota * 0.8)))

     * quota * 0.8 leaves 20 % of the origin quota free so the browser never
       evicts our whole database under pressure.
     * `usage` is NOT subtracted. Most of `usage` is our OWN cached files, so
       subtracting it double-counted them: every probe shrank the budget again
       (a ratchet), which on iOS Safari's small quota collapsed it to 1-2 MB and
       made the cache evict files milliseconds after writing them.
     * The result is floored at MAX_FILE_BYTES so any single file the per-file
       cap allows can always be stored, on every device.

     Everything here is wrapped: estimate() may be missing, may reject, or may
     report nonsense — in every such case we silently keep MAX_TOTAL_BYTES. */
  var _effectiveTotalBytes = MAX_TOTAL_BYTES;   // resolved budget actually enforced
  var _budgetProbe = null;                      // single in-flight probe promise

  function effectiveTotalBytes() { return _effectiveTotalBytes; }

  function initStorageBudget() {
    if (_budgetProbe) return _budgetProbe;
    _budgetProbe = new Promise(function (resolve) {
      var est = null;
      try {
        if (typeof navigator !== 'undefined' && navigator && navigator.storage &&
            typeof navigator.storage.estimate === 'function') {
          est = navigator.storage.estimate();
        }
      } catch (_e) { est = null; }

      if (!est || typeof est.then !== 'function') {
        // Storage API unavailable (older Safari / webview) → keep the default.
        log('effective total budget: ' + _effectiveTotalBytes +
            ' (quota=unknown, usage=unknown — storage.estimate() unavailable)');
        resolve(_effectiveTotalBytes);
        return;
      }

      est.then(function (info) {
        var quota = (info && typeof info.quota === 'number' && isFinite(info.quota) && info.quota > 0)
          ? info.quota : 0;
        var usage = (info && typeof info.usage === 'number' && isFinite(info.usage) && info.usage > 0)
          ? info.usage : 0;
        if (quota > 0) {
          // 80 % of the quota. `usage` is deliberately NOT subtracted: most of
          // it IS our own cached files, so subtracting it double-counted them
          // and made the budget ratchet monotonically downwards on every probe
          // (collapsing to 1-2 MB on iOS Safari, where the quota is small).
          // Eviction already enforces the total, so the budget must stay a
          // stable function of the quota alone.
          var allowed = Math.floor(quota * 0.8);
          _effectiveTotalBytes = Math.min(MAX_TOTAL_BYTES, allowed);
          // Never end up with a budget so small that not even one allowed file
          // could ever be cached. This floor is UNCONDITIONAL — the old
          // `quota > MAX_FILE_BYTES` guard never fired on iOS (small quota),
          // which is exactly where the collapse needed rescuing.
          if (_effectiveTotalBytes < MAX_FILE_BYTES) {
            _effectiveTotalBytes = Math.min(MAX_TOTAL_BYTES, MAX_FILE_BYTES);
          }
        }
        log('effective total budget: ' + _effectiveTotalBytes +
            ' (quota=' + (quota || 'unknown') + ', usage=' + (usage || 0) + ')');
        resolve(_effectiveTotalBytes);
      }, function (e) {
        log('effective total budget: ' + _effectiveTotalBytes +
            ' (quota=unknown, usage=unknown — storage.estimate() failed)', e);
        resolve(_effectiveTotalBytes);
      });
    }).catch(function () { return _effectiveTotalBytes; });
    return _budgetProbe;
  }

  // Probe once at module init; never awaited by any caller, so a slow/hostile
  // Storage API can never delay a read or a write. Until it settles the default
  // MAX_TOTAL_BYTES is used, which is safe (eviction simply runs again later).
  try { initStorageBudget(); } catch (_e) { /* must never throw */ }

  // Set of in-flight file-write promises. A write is only removed once its
  // IndexedDB transaction has actually COMMITTED (txDone). flush() awaits these
  // so a quick tab-close / app-background (very common on iPhone) can no longer
  // lose a file that was just opened — it is guaranteed persisted for the next
  // session instead of being silently re-downloaded.
  var _pendingWrites = [];
  function trackWrite(p) {
    _pendingWrites.push(p);
    var done = function () {
      var i = _pendingWrites.indexOf(p);
      if (i !== -1) _pendingWrites.splice(i, 1);
    };
    p.then(done, done);
    return p;
  }

  // One-time warning so a broken/evicted store is observable instead of
  // silently degrading to a permanent re-download. Never throws.
  var _warnedStoreUnavailable = false;
  function warnStoreUnavailable(e) {
    if (_warnedStoreUnavailable) return;
    _warnedStoreUnavailable = true;
    try { console.warn('[FileCache] store unavailable', e); } catch (_e) {}
  }

  // Idempotent store creation. Guarded by contains() checks so it can run for
  // both the initial upgrade and a self-healing reopen without error.
  function ensureStores(db) {
    if (!db.objectStoreNames.contains(STORE_FILES)) {
      var fs = db.createObjectStore(STORE_FILES, { keyPath: 'id' });
      fs.createIndex('savedAt', 'savedAt', { unique: false });
    }
    if (!db.objectStoreNames.contains(STORE_LISTINGS)) {
      var ls = db.createObjectStore(STORE_LISTINGS, { keyPath: 'key' });
      ls.createIndex('savedAt', 'savedAt', { unique: false });
    }
    if (!db.objectStoreNames.contains(STORE_META)) {
      db.createObjectStore(STORE_META, { keyPath: 'key' });
    }
  }

  function hasAllStores(db) {
    return db.objectStoreNames.contains(STORE_FILES) &&
           db.objectStoreNames.contains(STORE_LISTINGS) &&
           db.objectStoreNames.contains(STORE_META);
  }

  // Wire the shared teardown handlers on a live db handle.
  function wireDbHandlers(db) {
    // If another tab requests a version change (or the DB is deleted), let
    // go of our handle so we transparently reopen instead of throwing
    // "connection is closing" on the next transaction.
    db.onversionchange = function () {
      try { db.close(); } catch (e) {}
      _dbPromise = null;
    };
    db.onclose = function () { _dbPromise = null; };
  }

  /* ------------------------------------------------------------------ open */
  function openDb() {
    if (!_supported) return Promise.reject(new Error('no-idb'));
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        ensureStores(req.result);
      };
      req.onsuccess = function () {
        var db = req.result;
        log('idb open OK (name=' + DB_NAME + ', version=' + db.version + ')');
        // A partial DB (missing one of the stores) is repaired by the normal
        // versioned upgrade above: DB_VERSION was bumped and ensureStores() is
        // idempotent, so onupgradeneeded runs and creates whatever is missing.
        // We deliberately do NOT reopen at a higher version here — that would
        // push the on-disk DB ahead of DB_VERSION and make every later
        // indexedDB.open(DB_NAME, DB_VERSION) fail forever with VersionError.
        // If stores are somehow still missing we just surface it so callers
        // fall back to the network for this page-session.
        if (!hasAllStores(db)) {
          warnStoreUnavailable(new Error('missing-object-stores'));
          try { db.close(); } catch (e) {}
          reject(new Error('idb-missing-object-stores'));
          return;
        }
        wireDbHandlers(db);
        resolve(db);
      };
      req.onerror = function () {
        var e = req.error || new Error('idb-open-failed');
        log('idb open FAILED: ' + (e && (e.name + ': ' + e.message)));
        reject(e);
      };
      // A blocked open (older connection still holding the DB) must not hang the
      // read/write path forever — surface it so callers fall back to the network.
      req.onblocked = function () {
        log('idb open BLOCKED (another tab holds an old connection)');
        reject(new Error('idb-open-blocked'));
      };
    }).catch(function (e) { _dbPromise = null; throw e; });
    return _dbPromise;
  }

  function tx(store, mode) {
    return openDb().then(function (db) {
      var t = db.transaction(store, mode);
      return { store: t.objectStore(store), tx: t };
    });
  }

  function reqToPromise(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function txDone(t) {
    return new Promise(function (resolve, reject) {
      t.oncomplete = function () { resolve(); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error || new Error('tx-abort')); };
    });
  }

  /* --------------------------------------------------------- scope binding
     With no accounts there is nothing to bind: the scope is the constant
     ANON_SCOPE and it is active from module load, so the cache is usable on the
     very first read of the very first page-load. The meta row is still written
     once purely so the store keeps a record of its own scope.

     Nothing here ever wipes. There is no identity that can change, and HTTP
     errors / session expiry / timeouts never invalidate stored bytes. */
  function writeStoredSessionKey(key) {
    return tx(STORE_META, 'readwrite').then(function (o) {
      o.store.put({ key: 'session', value: key });
      return txDone(o.tx);
    }).catch(function () {});
  }

  /**
   * Adopt the anonymous scope and record it. Kept as a function (and exported
   * under the old names) so existing call sites need no restructuring.
   * Resolves with the active scope; never wipes, never rejects.
   */
  function bindStoredSession() {
    _sessionKey = ANON_SCOPE;
    if (!_supported) return Promise.resolve(_sessionKey);
    return writeStoredSessionKey(_sessionKey)
      .then(function () {
        log('cache scope bound (anonymous, per-browser)', { scope: _sessionKey });
        return _sessionKey;
      })
      .catch(function () { return _sessionKey; });
  }

  // Back-compat alias: any caller that still calls bindSession(...) simply
  // re-affirms the anonymous scope. The argument is ignored on purpose — a
  // null/absent identity must NOT detach or wipe the cache any more.
  function bindSession(_ignoredKey) {
    return bindStoredSession().then(function () {});
  }

  /** Back-compat: the cache scope no longer depends on any user object. */
  function deriveKey() {
    return ANON_SCOPE;
  }

  /* ----------------------------------------------------------------- clear
     A full wipe now happens in EXACTLY ONE situation: an explicit
     FileCache.clearAll() call. Nothing else — no HTTP 401 / 402 / 403, no
     timeout, no network error — is allowed to call this. `reason` is logged so
     the exact trigger of any wipe is always visible in the console. */
  function clearAllStores(reason) {
    log('CLEAR all stores — reason:', reason || 'unspecified');
    if (!_supported) return Promise.resolve();
    return openDb().then(function (db) {
      var t = db.transaction([STORE_FILES, STORE_LISTINGS, STORE_META], 'readwrite');
      t.objectStore(STORE_FILES).clear();
      t.objectStore(STORE_LISTINGS).clear();
      t.objectStore(STORE_META).clear();
      return txDone(t);
    }).catch(function () {});
  }

  /**
   * Public: clear the entire cache. Only an explicit user-initiated "clear
   * cache" action should call this. Never call it from an error/HTTP-status
   * handler: authorization failures (401 / 402 / 403), timeouts and network
   * errors must leave the stored files untouched.
   * @param {string} [reason] trigger description, logged for traceability.
   */
  function clearAll(reason) {
    // The scope stays bound: a wipe empties the stores but the cache must keep
    // working (and re-filling) immediately afterwards.
    return clearAllStores(reason || 'explicit-clearAll')
      .then(function () { return writeStoredSessionKey(_sessionKey); });
  }

  /* ------------------------------------------------------------- files API */

  /**
   * Look up a cached file. Resolves to { blob, contentType, name } or null.
   * There is no per-user scoping any more, so a row is never rejected for its
   * `sessionKey`: rows written by an older, user-scoped build are simply
   * adopted into the anonymous scope instead of being thrown away.
   */
  function getFile(id) {
    if (!_supported) {
      log('MISS', id, '(indexeddb unsupported)');
      return Promise.resolve(null);
    }
    return tx(STORE_FILES, 'readonly').then(function (o) {
      return reqToPromise(o.store.get(id));
    }).then(function (row) {
      if (!row) { log('MISS', id, '(not cached → will fetch from network)'); return null; }
      // Preferred (iOS-safe) format: bytes stored as an ArrayBuffer in `data`.
      // Rebuild a fresh Blob from it on every read — ArrayBuffers survive a
      // full browser restart on iOS Safari, where stored Blobs did not.
      var blob = null;
      if (row.data && typeof row.data.byteLength === 'number' && row.data.byteLength > 0) {
        try {
          blob = new Blob([row.data], { type: row.contentType || 'application/octet-stream' });
        } catch (_e) { blob = null; }
      }
      // Legacy rows (pre-ArrayBuffer builds) may still hold a Blob; serve it if
      // it looks usable so existing caches keep working without a re-download,
      // and MIGRATE it to the restart-proof ArrayBuffer format in the
      // background (putFile converts + rewrites the row; best-effort).
      if (!blob) {
        var legacy = row.blob;
        var ok = legacy && (typeof legacy.size !== 'number' || legacy.size > 0) &&
                 (typeof Blob === 'undefined' || legacy instanceof Blob);
        if (ok) {
          blob = legacy;
          try {
            log('migrating legacy blob row \u2192 ArrayBuffer', id);
            putFile(id, legacy, row.contentType, row.name).catch(function () {});
          } catch (_e2) { /* migration is pure hygiene */ }
        }
      }
      if (!blob) {
        log('MISS', id, '(stored bytes unusable → dropped)');
        deleteFile(id);
        return null;
      }
      // Touch savedAt (LRU) without blocking the read path.
      touchFile(id);
      log('HIT', id, (row.bytes || blob.size || 0) + ' bytes (served from local cache)');
      return { blob: blob, contentType: row.contentType, name: row.name };
    }).catch(function (e) {
      warnStoreUnavailable(e);
      log('MISS', id, '(cache read failed → network)');
      return null;
    });
  }

  function touchFile(id) {
    tx(STORE_FILES, 'readwrite').then(function (o) {
      var g = o.store.get(id);
      g.onsuccess = function () {
        var row = g.result;
        if (row) {
          row.savedAt = Date.now();
          row.sessionKey = _sessionKey;   // adopt legacy user-scoped rows
          o.store.put(row);
        }
      };
      return txDone(o.tx);
    }).catch(function () {});
  }

  function deleteFile(id) {
    return tx(STORE_FILES, 'readwrite').then(function (o) {
      o.store.delete(id);
      return txDone(o.tx);
    }).catch(function () {});
  }

  /** Public: drop one cached file (used when a stored blob turns out to be
   *  unreadable, so the next open falls back to a fresh gated fetch instead
   *  of a blank page). Never rejects. */
  function removeFile(id) {
    if (!_supported) return Promise.resolve();
    return deleteFile(id);
  }

  /**
   * Store a file blob, then evict down to budget. No-op when IndexedDB is
   * unsupported. Never rejects (best-effort cache).
   *
   * The write is registered as a PENDING WRITE and only settles once its
   * transaction has COMMITTED, so flush() (wired to pagehide / visibilitychange
   * in library.js) can guarantee a just-opened file is durably persisted even
   * if the user immediately closes or backgrounds the browser — this is what
   * makes "opened once → opens instantly forever" actually hold on mobile.
   *
   * Large blobs are handled explicitly, with the PER-FILE cap kept strictly
   * separate from the whole-cache budget:
   *   • bytes > MAX_FILE_BYTES              → never cached (single file too big).
   *   • bytes > effective total budget      → cannot fit even with an empty
   *                                           cache → skipped.
   *   • otherwise                           → written, then the eviction pass
   *                                           removes OLDER entries until the
   *                                           total is back under budget, so a
   *                                           large file no longer wipes the
   *                                           cache and small files coexist
   *                                           with it.
   */
  // Blob → ArrayBuffer, with a fallback for engines lacking blob.arrayBuffer().
  function blobToArrayBuffer(blob) {
    try {
      if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
    } catch (_e) { /* fall through */ }
    try {
      return new Response(blob).arrayBuffer();
    } catch (_e2) {
      return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { reject(fr.error || new Error('read-failed')); };
        fr.readAsArrayBuffer(blob);
      });
    }
  }

  function putFile(id, blob, contentType, name) {
    if (!_supported || !blob) return Promise.resolve();
    var bytes = (blob && typeof blob.size === 'number') ? blob.size : 0;
    // (1) PER-FILE cap: a single file above this is never worth caching.
    if (bytes > MAX_FILE_BYTES) {
      log('WRITE skipped', id, bytes + ' bytes (exceeds per-file cap ' + MAX_FILE_BYTES + ')');
      return Promise.resolve();
    }
    // (2) WHOLE-CACHE budget: if the file alone cannot fit even after evicting
    //     every other entry, storing it would only trash the cache for nothing.
    if (bytes > effectiveTotalBytes()) {
      log('WRITE skipped (too large for budget)', id,
          bytes + ' bytes > total budget ' + effectiveTotalBytes());
      return Promise.resolve();
    }
    // Convert to an ArrayBuffer BEFORE the transaction: ArrayBuffers are
    // serialized inline into IndexedDB and reliably survive a full browser
    // restart on iOS Safari, where stored Blobs frequently became unreadable
    // (the root cause of "reopen always re-downloads" on iPhone/iPad).
    var owner = _sessionKey;
    var p = blobToArrayBuffer(blob).then(function (buf) {
      if (!buf || !buf.byteLength) throw new Error('empty-buffer');
      var record = {
        id: id,
        sessionKey: owner,
        data: buf,
        contentType: contentType || (blob.type || 'application/octet-stream'),
        name: name || '',
        bytes: buf.byteLength,
        savedAt: Date.now(),
      };
      // The eviction pass runs AFTER the write has committed, so a slow evict
      // can never abort or race the durable write of the just-opened file.
      return tx(STORE_FILES, 'readwrite').then(function (o) {
        o.store.put(record);
        return txDone(o.tx);
      });
    });
    // Track only the durable-write phase for flush(); eviction is pure hygiene.
    trackWrite(p.then(function () {}, function () {}));
    return p.then(function () {
      log('WRITE', id, bytes + ' bytes (stored in local cache)');
      // Pass the id we just wrote so the eviction pass can never delete the
      // file the user is currently viewing.
      return evictFiles(id);
    }).catch(function (e) {
      warnStoreUnavailable(e);
      log('WRITE failed', id, bytes + ' bytes (cache left unchanged)');
    });
  }

  /**
   * Public: resolve once every in-flight file write has COMMITTED (or after a
   * safety timeout, so a stuck write never blocks a page unload). Called from
   * the page's pagehide / visibilitychange handlers so leaving the site can
   * never strand a half-written cache entry. Never rejects.
   */
  function flush() {
    if (!_supported || !_pendingWrites.length) return Promise.resolve();
    var pending = _pendingWrites.slice();
    var settleAll = Promise.all(pending.map(function (p) {
      return Promise.resolve(p).catch(function () {});
    }));
    var guard = new Promise(function (resolve) { setTimeout(resolve, 2000); });
    return Promise.race([settleAll, guard]);
  }

  /**
   * Evict OLDEST-FIRST (LRU by `savedAt`, which getFile() touches on every hit)
   * until BOTH caps hold:
   *     count      <= MAX_FILES                (secondary, entry-count cap)
   *     totalBytes <= effectiveTotalBytes()    (primary, whole-cache budget)
   *
   * A newly written large file that fits under MAX_FILE_BYTES but pushes the
   * total over budget therefore makes room by dropping the OLDEST entries —
   * it is never itself the reason the cache is wiped, and it is never skipped
   * here (putFile already refused anything that could not possibly fit).
   */
  function evictFiles(protectId) {
    return tx(STORE_FILES, 'readonly').then(function (o) {
      return reqToPromise(o.store.getAll());
    }).then(function (rows) {
      if (!rows || !rows.length) return;
      var budget = effectiveTotalBytes();
      // Single anonymous scope: every row counts toward the total budget.
      rows.sort(function (a, b) { return (a.savedAt || 0) - (b.savedAt || 0); }); // oldest first
      var totalBytes = 0, i;
      for (i = 0; i < rows.length; i++) totalBytes += (rows[i].bytes || 0);
      var toDelete = [];
      var freedBytes = 0;
      var count = rows.length;
      var overCount = count > MAX_FILES;
      var overBytes = totalBytes > budget;
      // Evict oldest while over EITHER cap; stop as soon as both are satisfied.
      i = 0;
      // The newest row is never a sensible eviction target either: it is the
      // file the user just opened (LRU order makes it last).
      var newestId = rows.length ? rows[rows.length - 1].id : null;
      while ((count > MAX_FILES || totalBytes > budget) && i < rows.length) {
        var row = rows[i];
        var rowBytes = (row.bytes || 0);
        // NEVER evict the entry that was just written (nor the most recently
        // saved row): deleting it is what made a freshly opened file vanish
        // milliseconds after being cached.
        if ((protectId != null && row.id === protectId) || row.id === newestId) {
          log('eviction: keeping just-written ' + row.id);
          i++;
          continue;
        }
        var reason = (count > MAX_FILES)
          ? ('count ' + count + ' > MAX_FILES ' + MAX_FILES)
          : ('total ' + totalBytes + ' > budget ' + budget);
        toDelete.push(row.id);
        freedBytes += rowBytes;
        totalBytes -= rowBytes;
        count--;
        i++;
        log('EVICT', row.id, 'freed ' + rowBytes + ' bytes (oldest-first, reason: ' + reason + ')');
      }
      if (!toDelete.length) return;
      return tx(STORE_FILES, 'readwrite').then(function (o) {
        for (var j = 0; j < toDelete.length; j++) o.store.delete(toDelete[j]);
        return txDone(o.tx);
      }).then(function () {
        log('EVICT done: removed ' + toDelete.length + ' entr' +
            (toDelete.length === 1 ? 'y' : 'ies') + ', freed ' + freedBytes +
            ' bytes, now ' + count + ' file(s) / ' + totalBytes + ' bytes' +
            ' (caps: MAX_FILES=' + MAX_FILES + ', budget=' + budget +
            ', triggered by: ' + (overCount && overBytes ? 'count+bytes' : (overCount ? 'count' : 'bytes')) + ')');
      });
    }).catch(function () {});
  }

  /* ---------------------------------------------------------- listings API */

  /**
   * Get a cached folder listing. Resolves to { data, fresh } or null. `fresh`
   * is false once past LISTING_FRESH_MS so the caller can show it instantly AND
   * refresh in the background. Rows from an older user-scoped build are served
   * rather than discarded — the scope is no longer part of the lookup.
   */
  function getListing(key) {
    if (!_supported) return Promise.resolve(null);
    return tx(STORE_LISTINGS, 'readonly').then(function (o) {
      return reqToPromise(o.store.get(key));
    }).then(function (row) {
      if (!row) return null;
      var age = Date.now() - (row.savedAt || 0);
      return { data: row.data, fresh: age < LISTING_FRESH_MS };
    }).catch(function () { return null; });
  }

  function deleteListing(key) {
    return tx(STORE_LISTINGS, 'readwrite').then(function (o) {
      o.store.delete(key);
      return txDone(o.tx);
    }).catch(function () {});
  }

  function putListing(key, data) {
    if (!_supported || !data) return Promise.resolve();
    var record = { key: key, sessionKey: _sessionKey, data: data, savedAt: Date.now() };
    return tx(STORE_LISTINGS, 'readwrite').then(function (o) {
      o.store.put(record);
      return txDone(o.tx);
    }).then(function () { return evictListings(); }).catch(function () {});
  }

  function evictListings() {
    return tx(STORE_LISTINGS, 'readonly').then(function (o) {
      return reqToPromise(o.store.getAll());
    }).then(function (rows) {
      if (!rows || rows.length <= MAX_LISTINGS) return;
      rows.sort(function (a, b) { return (a.savedAt || 0) - (b.savedAt || 0); });
      var toDelete = rows.slice(0, rows.length - MAX_LISTINGS).map(function (r) { return r.key; });
      if (!toDelete.length) return;
      return tx(STORE_LISTINGS, 'readwrite').then(function (o) {
        for (var j = 0; j < toDelete.length; j++) o.store.delete(toDelete[j]);
        return txDone(o.tx);
      });
    }).catch(function () {});
  }

  /* --------------------------------------------------------------- export */
  window.FileCache = {
    supported: _supported,
    bindSession: bindSession,
    bindStoredSession: bindStoredSession,
    deriveKey: deriveKey,
    // Read-only introspection for the temporary on-screen debug panel.
    sessionKey: function () { return _sessionKey; },
    effectiveBudget: function () { return _effectiveTotalBytes; },
    clearAll: clearAll,
    getFile: getFile,
    putFile: putFile,
    removeFile: removeFile,
    flush: flush,
    getListing: getListing,
    putListing: putListing,
  };
})();
