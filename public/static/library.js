/* ============================================================================
   تيسير — Library browser behaviour  ·  Google Drive–style UI

   - Fetches folder listings from the server API (/api/library/*). The Google
     API key stays on the server; this file only ever sees safe JSON.
   - Renders folders + files as Drive-style cards (grid) or rows (list).
   - Folder navigation via the History API (back/forward + deep links work).
   - Global search across the whole library (server-backed, debounced).
   - Skeleton loaders, lazy thumbnails (IntersectionObserver), prefetch-on-hover.
   - List virtualization so 400+ files stay smooth (tiny DOM).
   - Locked files (non-subscribers) open the shared Subscribe modal; access is
     ALSO enforced server-side, so a forged flag still gets nothing.
   ========================================================================== */
(function () {
  'use strict';

  var API = '/api/library';
  var THUMB = API + '/thumb/';

  /* ------------------------------------------------------------- elements */
  var els = {
    subjects:       document.getElementById('lib-subjects'),
    breadcrumb:     document.getElementById('lib-breadcrumb'),
    scroller:       document.getElementById('gd-scroller'),
    content:        document.getElementById('lib-content'),
    skeletons:      document.getElementById('lib-skeletons'),
    empty:          document.getElementById('lib-empty'),
    error:          document.getElementById('lib-error'),
    retry:          document.getElementById('lib-retry'),
    search:         document.getElementById('lib-search'),
    searchIcon:     document.getElementById('gd-search-icon'),
    searchClear:    document.getElementById('lib-search-clear'),
    searchResults:  document.getElementById('lib-search-results'),
    searchBody:     document.getElementById('lib-search-body'),
    searchSummary:  document.getElementById('lib-search-summary'),
    searchEmpty:    document.getElementById('lib-search-empty'),
    searchBack:     document.getElementById('lib-search-back'),
    viewGrid:       document.getElementById('view-grid'),
    viewList:       document.getElementById('view-list'),
    sampleNote:     document.getElementById('lib-sample-note'),
    sidebar:        document.getElementById('gd-sidebar'),
    menuToggle:     document.getElementById('gd-menu-toggle'),
    scrim:          document.getElementById('gd-scrim'),
    logout:         document.getElementById('lib-logout'),
    viewer:         document.getElementById('gd-viewer'),
    viewerTitle:    document.getElementById('gd-viewer-title'),
    viewerBadge:    document.getElementById('gd-viewer-badge'),
    viewerStage:    document.getElementById('gd-viewer-stage'),
    viewerClose:    document.getElementById('gd-viewer-close'),
    viewerZoom:     document.getElementById('gd-viewer-zoom'),
    zoomIn:         document.getElementById('gd-zoom-in'),
    zoomOut:        document.getElementById('gd-zoom-out'),
    zoomFit:        document.getElementById('gd-zoom-fit'),
    zoomLevel:      document.getElementById('gd-zoom-level'),
  };

  /* ---------------------------------------------------------------- state */
  var state = {
    folder: 'root',
    subscriber: false,
    view: (localStorage.getItem('bac_lib_view') || 'list'),
    listing: null,
    query: '',
    subjectsLoaded: false,
    searching: false,
  };

  var listingCache = {};
  var inflight = {};
  var searchCache = {};
  var searchSeq = 0;

  // Client-side file-metadata cache + in-flight dedup. Lets us open a file
  // instantly on a warm cache and prefetch meta on hover, so the SPA viewer
  // pops without a visible network wait — the byte stream then fills in.
  var metaCache = {};
  var metaInflight = {};
  var viewerOpen = false;
  var _deepLinkViewer = false; // true when viewer was opened via a direct ?view= load

  // Persistent file cache (IndexedDB, via file-cache.js). Optional — everything
  // still works if it's unavailable, just without the instant-reopen boost. It
  // is scoped per browser profile (no accounts exist) and only ever stores bytes
  // the Worker already agreed to serve.
  var FC = window.FileCache || null;
  // Ask the browser ONCE per page-session to mark our origin storage as
  // persistent, so the IndexedDB file cache is not silently evicted under
  // storage pressure. Purely advisory: a denial (or an unsupported browser)
  // changes nothing — it never blocks, delays or alters any behaviour.
  var _persistRequested = false;
  // Blob object URLs held by the viewer, tracked per "generation": the CURRENT
  // open owns its URLs; when a new open starts the previous generation is only
  // RETIRED, and revoked strictly AFTER the new content is mounted. A fresh
  // object URL is minted from the cached Blob on EVERY open, so a quick
  // close→reopen can never render against an already-revoked / stale URL (the
  // cause of the blank-white-page-on-second-open bug). These URLs live only in
  // memory; nothing is ever written to the phone's Downloads folder.
  var _viewerBlobUrls = [];   // URLs owned by the current viewer generation
  var _staleBlobUrls = [];    // previous generations, awaiting safe revocation
  function trackBlobUrl(url) { if (url) _viewerBlobUrls.push(url); return url; }
  // Move the current generation to the stale pool (called when a new open
  // starts). Nothing is revoked yet — the old file may still be on screen.
  function retireViewerBlobUrls() {
    if (_viewerBlobUrls.length) {
      _staleBlobUrls = _staleBlobUrls.concat(_viewerBlobUrls);
      _viewerBlobUrls = [];
    }
  }
  // Revoke previous-generation URLs — safe once the new content is mounted.
  function revokeStaleBlobUrls() {
    for (var i = 0; i < _staleBlobUrls.length; i++) {
      try { URL.revokeObjectURL(_staleBlobUrls[i]); } catch (e) {}
    }
    _staleBlobUrls = [];
  }
  // Full teardown (viewer really closed): retire + revoke everything.
  function revokeViewerBlobUrls() { retireViewerBlobUrls(); revokeStaleBlobUrls(); }

  // Virtualization kicks in only for large folders.
  var VIRTUAL_THRESHOLD = 140;
  var VIRTUAL_OVERSCAN = 6;

  /* --------------------------------------------------------------- icons
     Google-Drive-style file/folder glyphs, colourised per type. */
  var IC = {
    chevron: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8.6 5.6 14 11l-5.4 5.4L10 18l7-7-7-7z"/></svg>',
    // Navigation glyphs for the toolbar (back one folder / library home).
    back: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
    homeNav: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>',
    lock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    open: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5S21.3 16.4 23 12c-1.7-4.4-6-7.5-11-7.5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>',
    // Solid folder — themed to the site's deep ink-blue primary (was grey-blue).
    folder: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="var(--color-primary, #16324F)" d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
  };

  // File glyphs keyed by coarse type. Colours are drawn from the site theme
  // tokens (ink blue / ochre accent / success / warning / danger) so the icons
  // match the rest of the site while keeping the Drive-style filled-doc look.
  var GLYPH = {
    doc:     'var(--color-primary, #16324F)',   // Documents → ink blue
    pdf:     'var(--color-accent, #B97E2C)',     // PDFs / most library files → ochre accent
    sheet:   'var(--color-success, #2F7D52)',    // Spreadsheets → success green
    slides:  'var(--color-warning, #A9631A)',    // Presentations → warm ochre
    image:   'var(--color-success, #2F7D52)',    // Images → success green
    video:   'var(--color-danger, #A63D2F)',     // Video → danger red
    other:   'var(--color-ink-secondary, #52606D)'
  };
  function fileGlyph(type) {
    var doc = function (fill) {
      return '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
        '<path fill="' + fill + '" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
        '<path fill="#fff" fill-opacity="0.85" d="M14 2v6h6z"/></svg>';
    };
    switch (type) {
      case 'pdf':
      case 'exam':
      case 'mock':
      case 'book':
      case 'lesson':
      case 'summary':
      case 'exercises':
        return doc(GLYPH.pdf);            // most library files are PDF → ochre accent
      case 'doc':      return doc(GLYPH.doc);
      case 'sheet':    return doc(GLYPH.sheet);
      case 'slides':   return doc(GLYPH.slides);
      case 'image':
        return '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="' + GLYPH.image + '" d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z"/></svg>';
      case 'video':
        return '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="' + GLYPH.video + '" d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm6 4v8l6-4z" fill-opacity="0.9"/></svg>';
      default:
        return doc(GLYPH.other);
    }
  }

  // Big thumbnail-area fallback glyph (grey, large).
  function thumbFallbackGlyph(type) {
    if (type === 'image') {
      return '<svg viewBox="0 0 24 24" width="52" height="52" fill="currentColor" aria-hidden="true"><path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5z"/></svg>';
    }
    if (type === 'video') {
      return '<svg viewBox="0 0 24 24" width="52" height="52" fill="currentColor" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm6 4v8l6-4z"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm-1 7V3.5L18.5 9z"/></svg>';
  }

  var TYPE_LABEL = {
    lesson: 'Lesson', summary: 'Summary', exercises: 'Exercises', exam: 'Exam',
    mock: 'Mock exam', book: 'Book', pdf: 'PDF', doc: 'Document', sheet: 'Spreadsheet',
    slides: 'Presentation', image: 'Image', video: 'Video', other: 'File'
  };

  /* -------------------------------------------------------------- helpers */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function typeLabel(t) { return TYPE_LABEL[t] || TYPE_LABEL.other; }
  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '—';
      return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (e) { return '—'; }
  }
  function hide(el) { if (el) el.hidden = true; }
  function show(el) { if (el) el.hidden = false; }

  /* -------- lazy thumbnails: one shared IntersectionObserver ------------- */
  var thumbObserver = null;
  function getThumbObserver() {
    if (thumbObserver || !('IntersectionObserver' in window)) return thumbObserver;
    thumbObserver = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isIntersecting) continue;
        loadThumb(entries[i].target);
        thumbObserver.unobserve(entries[i].target);
      }
    }, { root: els.scroller, rootMargin: '400px 0px', threshold: 0.01 });
    return thumbObserver;
  }
  function loadThumb(holder) {
    var id = holder.getAttribute('data-thumb');
    if (!id || holder._thumbLoaded) return;
    holder._thumbLoaded = true;
    var img = new Image();
    img.decoding = 'async';
    img.loading = 'lazy';
    img.alt = '';
    img.className = 'gd-thumb-img';
    img.onload = function () { holder.classList.add('has-thumb'); };
    img.onerror = function () { /* keep the icon fallback silently */ };
    img.src = THUMB + encodeURIComponent(id);
    holder.appendChild(img);
  }
  function observeThumbs(root) {
    var obs = getThumbObserver();
    var holders = (root || els.content).querySelectorAll('[data-thumb]');
    for (var i = 0; i < holders.length; i++) {
      if (holders[i]._thumbLoaded) continue;
      if (obs) obs.observe(holders[i]);
      else loadThumb(holders[i]);
    }
  }

  /* ----------------------------------------------------------- API layer */
  // Always hits the network (deduped); refreshes the in-memory + persistent
  // caches on success. Used on cache misses and for background revalidation.
  function fetchListingNetwork(folderId) {
    var key = folderId || 'root';
    if (inflight[key]) return inflight[key];

    var url = API + '/list' + (folderId && folderId !== 'root' ? '?folder=' + encodeURIComponent(folderId) : '');
    var p = fetch(url, { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.error) || 'bad response');
        listingCache[key] = data;
        delete inflight[key];
        // Persist the listing so navigation stays instant after a browser
        // restart (tied to the live session; only safe JSON is stored).
        if (FC && FC.supported) FC.putListing(key, data).catch(function () {});
        return data;
      })
      .catch(function (err) { delete inflight[key]; throw err; });

    inflight[key] = p;
    return p;
  }

  function fetchListing(folderId) {
    var key = folderId || 'root';
    if (listingCache[key]) return Promise.resolve(listingCache[key]);
    return fetchListingNetwork(folderId);
  }

  // CACHE-FIRST listing load: memory → persistent IndexedDB → network. A hit
  // resolves immediately with NO network round-trip; a stale persistent hit is
  // still served instantly while a background revalidation refreshes it. Only
  // a full miss blocks on the Drive API — this is what makes moving between
  // folders instant instead of re-fetching the same listing every navigation.
  function loadListing(folderId) {
    var key = folderId || 'root';
    if (listingCache[key]) return Promise.resolve(listingCache[key]);
    return persistentListing(key).then(function (cached) {
      if (cached && cached.data) {
        listingCache[key] = cached.data;
        if (!cached.fresh) revalidateListing(key);
        return cached.data;
      }
      return fetchListingNetwork(folderId);
    }).catch(function () { return fetchListingNetwork(folderId); });
  }

  // Background refresh of a stale cached listing. Never blocks the UI; only
  // repaints if the user is still on that folder AND the data actually changed.
  function revalidateListing(key) {
    fetchListingNetwork(key).then(function (data) {
      if (state.folder !== key || state.searching) return;
      applyListing(key, data);
    }).catch(function () {});
  }

  // Read a folder listing from the persistent IndexedDB cache (session-scoped).
  // Resolves to { data, fresh } or null. Used to paint navigation instantly on
  // a cold start; a background revalidation through the Worker always follows.
  function persistentListing(folderId) {
    var key = folderId || 'root';
    if (!FC || !FC.supported) return Promise.resolve(null);
    return FC.getListing(key).catch(function () { return null; });
  }

  // Network fetch of a file's safe viewer metadata (gated server-side). On
  // success the meta is also persisted (tiny JSON) so the viewer can open
  // instantly on the next session without a blocking round-trip.
  function fetchMetaNetwork(id) {
    var url = API + '/file/' + encodeURIComponent(id) + '/meta';
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok || !data || !data.ok) {
          var err = new Error((data && data.error) || ('HTTP ' + r.status));
          err.status = r.status;
          err.code = data && data.error;
          throw err;
        }
        metaCache[id] = data.file;
        if (FC && FC.supported) FC.putListing('meta:' + id, data.file).catch(function () {});
        return data.file;
      });
    });
  }

  // CACHE-FIRST viewer metadata: memory → persistent IndexedDB → network.
  // Deduped so hover-prefetch and click share one lookup. Rejects on the
  // server's gate (402/403/…) exactly as before on a cache miss.
  function fetchMeta(id) {
    if (metaCache[id]) return Promise.resolve(metaCache[id]);
    if (metaInflight[id]) return metaInflight[id];
    var p;
    if (FC && FC.supported) {
      p = FC.getListing('meta:' + id).then(function (hit) {
        if (hit && hit.data && hit.data.id) {
          metaCache[id] = hit.data;
          // Serve instantly from cache, and refresh the meta in the background.
          // A failed refresh (401/402/403, offline, timeout) is IGNORED: it must
          // never destroy cached content. Access stays enforced server-side on
          // every byte request, and the cache is only ever wiped explicitly.
          if (!hit.fresh) {
            fetchMetaNetwork(id).catch(function () { /* keep cache intact */ });
          }
          return hit.data;
        }
        return fetchMetaNetwork(id);
      }).catch(function () { return fetchMetaNetwork(id); });
    } else {
      p = fetchMetaNetwork(id);
    }
    p = p.then(
      function (meta) { delete metaInflight[id]; return meta; },
      function (err) { delete metaInflight[id]; throw err; }
    );
    metaInflight[id] = p;
    return p;
  }

  // Warm the meta cache for a file (used on hover / for visible files) so a
  // subsequent open is instant. Silently ignores gate rejections.
  function prefetchMeta(id, locked) {
    if (locked || !state.subscriber) return;
    if (metaCache[id] || metaInflight[id]) return;
    fetchMeta(id).catch(function () {});
  }

  // Resolve a same-origin URL the viewer can render for a file's bytes. This is
  // where the persistent file cache plugs in WITHOUT weakening security:
  //   1. Try the IndexedDB cache (per-browser scope — see file-cache.js). If
  //      present → build an in-memory Blob URL and render from that. The file
  //      never touches Downloads.
  //   2. On a cache miss, hand the viewer the GATED same-origin content URL
  //      STRAIGHT AWAY so PDF.js / <img> / <video> can stream (and Range-request)
  //      it — first paint no longer waits for 100% of the bytes. The full-file
  //      download that feeds the IndexedDB cache is then kicked off in the
  //      BACKGROUND and never blocks rendering.
  // Auth is unchanged: every byte still travels through the gated Worker route,
  // which re-decides the subscription/device gate on each request (including the
  // viewer's own range requests). A gate rejection is already surfaced by the
  // gated /meta call that runs before this, so the subscribe modal still pops.
  // If IndexedDB is unavailable we fall back to the direct gated content URL —
  // identical to the previous behaviour.
  function resolveContentUrl(meta) {
    var id = meta.id;
    var directUrl = API + '/file/' + encodeURIComponent(id) + '/content';
    if (!FC || !FC.supported || meta.sample) {
      // No cache (or sample placeholder content) → stream straight from the
      // gated endpoint, exactly as before.
      return Promise.resolve(directUrl);
    }
    // Miss path — SINGLE-DOWNLOAD strategy per viewer kind (the old code always
    // ran a SECOND full background fetch purely to feed the cache, so every
    // file's bytes travelled twice; on iPhone the tab was often suspended
    // before that second download finished, so nothing got cached at all):
    //   • pdf   → stream from the gated URL (Range/206 kept intact); after the
    //             document loads, renderPdf() harvests the bytes PDF.js
    //             ALREADY downloaded via doc.getData() and writes those to the
    //             cache — one download total, no extra request.
    //   • image/text → fetch the full bytes ONCE, cache them, and render from
    //             the very same bytes via an in-memory Blob URL.
    //   • video/other → stream from the gated URL (seeking needs live Range
    //             requests) and warm the cache in the background as before.
    function cacheInBackground() {
      // Fire-and-forget: nothing here is awaited by the caller, so first paint
      // is never delayed by it.
      try {
        fetch(directUrl, { credentials: 'same-origin' }).then(function (r) {
          if (!r.ok) {
            // Nothing to cache for this attempt. An auth/authorization refusal
            // (401/402/403) or an expired session is NOT a reason to touch the
            // already-cached files — they stay exactly where they are.
            return;
          }
          var ct = r.headers.get('content-type') || meta.contentType || 'application/octet-stream';
          return r.blob().then(function (blob) {
            if (blob && blob.size > 0) {
              FC.putFile(id, blob, ct, meta.name).catch(function () {});
            }
          });
        }).catch(function () { /* offline / aborted → just no cache entry */ });
      } catch (e) { /* never let cache warming break the open */ }
    }

    // Fetch the FULL bytes once, cache them, and render from those same bytes.
    // Used for images/text where full-download-then-paint is imperceptible.
    function fetchOnceAndCache() {
      return fetch(directUrl, { credentials: 'same-origin' }).then(function (r) {
        if (!r.ok) {
          var err = new Error('HTTP ' + r.status);
          err.status = r.status;
          throw err;
        }
        var ct = r.headers.get('content-type') || meta.contentType || 'application/octet-stream';
        return r.blob().then(function (blob) {
          if (blob && blob.size > 0) {
            FC.putFile(id, blob, ct, meta.name).catch(function () {});
            try {
              var u = URL.createObjectURL(blob);
              if (u) return trackBlobUrl(u);
            } catch (e) { /* fall back to streaming below */ }
          }
          return directUrl;
        });
      });
    }

    function fetchFresh() {
      if (meta.viewerKind === 'image' || meta.viewerKind === 'text') {
        return fetchOnceAndCache().catch(function (err) {
          // Surface gate refusals; anything transient degrades to streaming.
          if (err && (err.status === 401 || err.status === 402 || err.status === 403)) throw err;
          return directUrl;
        });
      }
      // video / other kinds: stream now, warm the cache in the background.
      // PDFs: no extra fetch AT ALL — renderPdf() harvests PDF.js's own
      // download via doc.getData(), so the bytes travel exactly once.
      if (meta.viewerKind !== 'pdf') cacheInBackground();
      return directUrl;
    }

    return FC.getFile(id).then(function (hit) {
      if (hit && hit.blob) {
        // ALWAYS mint a FRESH object URL from the stored Blob on every open —
        // never reuse a URL from a previous open (it may already be revoked,
        // which rendered a blank white page). If the stored Blob can't even
        // produce a URL, drop the bad entry and fall back to the Worker.
        try {
          var freshUrl = URL.createObjectURL(hit.blob);
          if (freshUrl) return trackBlobUrl(freshUrl);
        } catch (e) { /* unreadable stored blob → treat as a miss */ }
        if (FC.removeFile) FC.removeFile(id).catch(function () {});
      }
      return Promise.resolve(fetchFresh());
    }, function () {
      // IndexedDB read failed outright → behave as a plain cache miss.
      return Promise.resolve(fetchFresh());
    }).catch(function (err) {
      // If the miss-fetch was refused by the gate, surface it so the viewer can
      // react (subscribe modal). The stored cache is deliberately left UNTOUCHED:
      // a 401/402/403 or an expired session is transient and must never destroy
      // content the server had already agreed to serve. Access enforcement stays
      // server-side on every request.
      if (err && (err.status === 401 || err.status === 402 || err.status === 403)) {
        throw err;
      }
      return directUrl;
    });
  }

  /* --------------------------------------------------------- view toggle */
  function setView(view) {
    state.view = view;
    localStorage.setItem('bac_lib_view', view);
    els.viewGrid.classList.toggle('is-active', view === 'grid');
    els.viewList.classList.toggle('is-active', view === 'list');
    els.viewGrid.setAttribute('aria-pressed', String(view === 'grid'));
    els.viewList.setAttribute('aria-pressed', String(view === 'list'));
    if (state.listing && !state.searching) renderContent();
  }

  /* --------------------------------------------------------- skeletons */
  function showSkeletons(showIt) {
    if (els.skeletons) els.skeletons.hidden = !showIt;
    if (showIt) { hide(els.empty); hide(els.error); }
  }

  /* ---------------------------------------------------------- breadcrumb
     Per product decision the textual folder path is replaced by two clean
     icon buttons: "back" (one folder up) and "home" (library root). The
     underlying folder-navigation logic is untouched — both buttons simply
     carry a data-folder id that the existing delegated click handler feeds
     into navigate(). Buttons are hidden at the root, where there is nowhere
     to go back to. */
  function renderBreadcrumb(crumbs) {
    var atRoot = !crumbs || crumbs.length <= 1;
    var rootId = (crumbs && crumbs.length) ? crumbs[0].id : 'root';
    // Parent = the crumb just before the current one (one folder up).
    var parentId = (crumbs && crumbs.length > 1) ? crumbs[crumbs.length - 2].id : rootId;

    if (atRoot) {
      // At the library home there is no "up" or "home" to navigate to.
      els.breadcrumb.innerHTML = '';
      return;
    }

    var back = '<button type="button" class="gd-icon-btn gd-nav-btn" data-folder="' + esc(parentId) +
      '" data-tooltip="رجوع" aria-label="رجوع" title="رجوع">' + IC.back + '</button>';
    var home = '<button type="button" class="gd-icon-btn gd-nav-btn" data-folder="' + esc(rootId) +
      '" data-tooltip="الرئيسية" aria-label="الرئيسية" title="الرئيسية">' + IC.homeNav + '</button>';

    els.breadcrumb.innerHTML = back + home;
  }

  /* ------------------------------------------------------------- sidebar */
  function subjectIcon() {
    return '<span class="gd-subject-icon">' + IC.folder + '</span>';
  }
  function homeIcon() {
    return '<span class="gd-subject-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12 3 2 12h3v8h5v-6h4v6h5v-8h3z"/></svg></span>';
  }
  function renderSubjects(folders, activeId) {
    var html = '<button type="button" class="gd-subject' + (activeId === 'root' ? ' is-active' : '') +
      '" data-folder="root">' + homeIcon() + '<span class="gd-subject-label">My Library</span></button>';
    html += folders.map(function (f) {
      var active = f.id === activeId ? ' is-active' : '';
      return '<button type="button" class="gd-subject' + active + '" data-folder="' + esc(f.id) + '">' +
        subjectIcon() + '<span class="gd-subject-label">' + esc(f.name) + '</span></button>';
    }).join('');
    els.subjects.innerHTML = html;
  }

  /* ------------------------------------------------------- card / row markup */
  function folderCard(f) {
    return '<button type="button" class="gd-card gd-folder" data-folder="' + esc(f.id) + '" title="' + esc(f.name) + '">' +
      '<div class="gd-card-head">' +
        '<span class="gd-card-icon">' + IC.folder + '</span>' +
        '<span class="gd-card-name">' + esc(f.name) + '</span>' +
        '<span class="gd-card-lock">' + IC.chevron + '</span>' +
      '</div></button>';
  }

  function fileCard(f) {
    var locked = f.locked;
    var lock = locked ? '<span class="gd-card-lock" title="Locked">' + IC.lock + '</span>' : '';
    var thumbAttr = (f.hasThumb && !locked) ? ' data-thumb="' + esc(f.id) + '"' : '';
    return '<button type="button" class="gd-card gd-file' + (locked ? ' is-locked' : '') +
      '" data-file="' + esc(f.id) + '" data-locked="' + (locked ? '1' : '0') + '" data-name="' + esc(f.name) + '" title="' + esc(f.name) + '">' +
      '<div class="gd-card-head">' +
        '<span class="gd-card-icon">' + fileGlyph(f.fileType) + '</span>' +
        '<span class="gd-card-name">' + esc(f.name) + '</span>' + lock +
      '</div>' +
      '<div class="gd-card-thumb"' + thumbAttr + '>' +
        '<span class="gd-thumb-fallback">' + thumbFallbackGlyph(f.fileType) + '</span>' +
      '</div></button>';
  }

  function folderRow(f) {
    return '<button type="button" class="gd-row gd-folder" data-folder="' + esc(f.id) + '">' +
      '<span class="gd-row-name"><span class="gd-card-icon">' + IC.folder + '</span>' +
        '<span class="gd-row-title">' + esc(f.name) + '</span></span>' +
      '<span class="gd-row-meta gd-col-type">Folder</span>' +
      '<span class="gd-row-meta gd-col-modified">—</span>' +
      '<span class="gd-row-end"><span class="gd-row-open">' + IC.chevron + '</span></span>' +
      '</button>';
  }

  function fileRow(f) {
    var locked = f.locked;
    var end = locked
      ? '<span class="gd-row-lock" title="Locked">' + IC.lock + '</span>'
      : '<span class="gd-row-open" title="Open">' + IC.open + '</span>';
    return '<button type="button" class="gd-row gd-file' + (locked ? ' is-locked' : '') +
      '" data-file="' + esc(f.id) + '" data-locked="' + (locked ? '1' : '0') + '" data-name="' + esc(f.name) + '">' +
      '<span class="gd-row-name"><span class="gd-card-icon">' + fileGlyph(f.fileType) + '</span>' +
        '<span class="gd-row-title">' + esc(f.name) + '</span></span>' +
      '<span class="gd-row-meta gd-col-type">' + esc(typeLabel(f.fileType)) + (f.size ? ' · ' + esc(f.size) : '') + '</span>' +
      '<span class="gd-row-meta gd-col-modified">' + esc(fmtDate(f.modified)) + '</span>' +
      '<span class="gd-row-end">' + end + '</span>' +
      '</button>';
  }

  function listHeader() {
    return '<div class="gd-list-header">' +
      '<span>Name</span>' +
      '<span class="gd-col-type">Type</span>' +
      '<span class="gd-col-modified">Modified</span>' +
      '<span></span>' +
    '</div>';
  }

  function filterListing() {
    // In-folder filter is no longer used (search is global), but keep the shape.
    return { folders: state.listing.folders, files: state.listing.files };
  }

  function renderNode(node) {
    if (node.kind === 'folder') {
      return state.view === 'grid' ? folderCard(node) : folderRow(node);
    }
    return state.view === 'grid' ? fileCard(node) : fileRow(node);
  }

  /* ----------------------------------------------------------- rendering */
  function renderContent() {
    if (!state.listing) return;
    var data = filterListing();
    var folders = data.folders, files = data.files;

    showSkeletons(false);
    teardownVirtual();

    if (folders.length === 0 && files.length === 0) {
      clearDynamic();
      show(els.empty);
      return;
    }
    hide(els.empty); hide(els.error);

    var isGrid = state.view === 'grid';
    var total = folders.length + files.length;

    // Large folder → windowed virtualization (single combined list).
    if (total > VIRTUAL_THRESHOLD) {
      setupVirtual(folders.concat(files), isGrid);
      return;
    }

    // Normal render: Folders section, then Files section (Drive-style).
    var html = '<div id="lib-dynamic">';
    if (isGrid) {
      if (folders.length) {
        html += '<div class="gd-section-label">Folders</div>';
        html += '<div class="gd-grid">' + folders.map(folderCard).join('') + '</div>';
      }
      if (files.length) {
        html += '<div class="gd-section-label">Files</div>';
        html += '<div class="gd-grid">' + files.map(fileCard).join('') + '</div>';
      }
    } else {
      html += '<div class="gd-list">' + listHeader() +
        folders.map(folderRow).join('') + files.map(fileRow).join('') + '</div>';
    }
    html += '</div>';
    setDynamic(html);
    observeThumbs(els.content);
  }

  /* Manage the dynamic content wrapper without wiping the empty/error/search
     nodes that live inside #lib-content. */
  function setDynamic(html) {
    var existing = document.getElementById('lib-dynamic');
    if (existing) existing.remove();
    els.content.insertAdjacentHTML('afterbegin', html);
  }
  function clearDynamic() {
    var existing = document.getElementById('lib-dynamic');
    if (existing) existing.remove();
  }

  /* ------------------------------------------------------ virtualization */
  var vlist = null;
  function teardownVirtual() {
    if (vlist) {
      if (els.scroller) els.scroller.removeEventListener('scroll', vlist.onScroll);
      window.removeEventListener('resize', vlist.onScroll);
      vlist = null;
    }
  }

  function setupVirtual(nodes, isGrid) {
    var wrapClass = isGrid ? 'gd-grid' : 'gd-list';
    var header = isGrid ? '' : listHeader();
    var html =
      '<div id="lib-dynamic"><div class="gd-virtual" id="lib-virtual">' + header +
        '<div class="gd-virtual-spacer" id="lib-vtop"></div>' +
        '<div class="' + wrapClass + '" id="lib-vwindow"></div>' +
        '<div class="gd-virtual-spacer" id="lib-vbot"></div>' +
      '</div></div>';
    setDynamic(html);

    var windowEl = document.getElementById('lib-vwindow');
    var topSpacer = document.getElementById('lib-vtop');
    var botSpacer = document.getElementById('lib-vbot');
    var container = document.getElementById('lib-virtual');

    function measure() {
      var cw = windowEl.clientWidth || container.clientWidth || 800;
      var isMobile = window.innerWidth <= 640;
      var gap = isMobile ? 14 : 20;
      var cols, rowH;
      if (isGrid) {
        // Keep these in sync with the .gd-grid / .gd-card sizes in library.css
        // so the virtualized window aligns with the real (bigger) cards.
        var minCard = window.innerWidth <= 480 ? cw : (isMobile ? 240 : 300);
        cols = Math.max(1, Math.floor((cw + gap) / (minCard + gap)));
        rowH = (isMobile ? 268 : 300) + gap; // file-card height + gap
      } else {
        cols = 1;
        rowH = 48; // row height (list rows are 48px, no gap)
      }
      return { cols: cols, rowH: rowH };
    }

    var geom = measure();

    function render() {
      geom = measure();
      var totalRows = Math.ceil(nodes.length / geom.cols);
      var scRect = els.scroller.getBoundingClientRect();
      var contTop = container.getBoundingClientRect().top - scRect.top + els.scroller.scrollTop;
      var viewTop = els.scroller.scrollTop;
      var viewH = els.scroller.clientHeight;

      var firstRow = Math.max(0, Math.floor((viewTop - contTop) / geom.rowH) - VIRTUAL_OVERSCAN);
      var visibleRows = Math.ceil(viewH / geom.rowH) + VIRTUAL_OVERSCAN * 2;
      var lastRow = Math.min(totalRows, firstRow + visibleRows);

      var startIdx = firstRow * geom.cols;
      var endIdx = Math.min(nodes.length, lastRow * geom.cols);

      topSpacer.style.height = (firstRow * geom.rowH) + 'px';
      botSpacer.style.height = Math.max(0, (totalRows - lastRow) * geom.rowH) + 'px';

      windowEl.innerHTML = nodes.slice(startIdx, endIdx).map(renderNode).join('');
      observeThumbs(windowEl);
    }

    var ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { render(); ticking = false; });
    }

    vlist = { onScroll: onScroll };
    els.scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    render();
  }

  /* --------------------------------------------------------- navigation */
  // Apply a resolved listing to the UI (shared by cache hits, network loads
  // and background revalidations). Skips the re-render entirely when the same
  // listing object is already painted, so revisiting a folder from the
  // in-memory cache never tears down and rebuilds an identical DOM.
  function applyListing(folderId, data, opts) {
    opts = opts || {};
    if (state.folder !== folderId || state.searching) return;
    // "Already painted" only counts when the listing DOM is really on screen
    // (search mode clears it, so returning from search must still re-render).
    var alreadyPainted = state.listing === data && !!document.getElementById('lib-dynamic');
    state.listing = data;
    state.subscriber = !!data.subscriber;

    // Sample/placeholder banner is permanently suppressed: the Drive is
    // connected and live, so the "showing example content" notice is obsolete
    // and must never appear to the user.
    if (els.sampleNote) els.sampleNote.hidden = true;
    renderBreadcrumb(data.breadcrumb);

    if (!state.subjectsLoaded) {
      if (data.folder && data.folder.isRoot) {
        renderSubjects(data.folders, folderId);
        state.subjectsLoaded = true;
      } else {
        loadListing('root').then(function (root) {
          if (state.subjectsLoaded) return;
          renderSubjects(root.folders, findTopSubject(data.breadcrumb));
          state.subjectsLoaded = true;
        }).catch(function () {});
      }
    } else {
      highlightSubject(findTopSubject(data.breadcrumb));
    }

    if (!alreadyPainted) renderContent();
    else showSkeletons(false);
    prefetchChildren(data.folders);
    prefetchFileMetas(data.files);
    if (opts.scrollTop) els.scroller.scrollTop = 0;
  }

  function navigate(folderId, opts) {
    opts = opts || {};
    folderId = folderId || 'root';
    state.folder = folderId;
    state.query = '';
    if (els.search) els.search.value = '';
    if (els.searchClear) els.searchClear.hidden = true;
    state.searching = false;
    searchSeq++;
    if (els.searchResults) els.searchResults.hidden = true;
    if (els.searchEmpty) els.searchEmpty.hidden = true;
    if (els.searchBody) els.searchBody.innerHTML = '';
    closeSidebar();

    // CACHE-FIRST: a folder already in the in-memory cache paints synchronously
    // with zero network and zero skeleton flash. Only a genuine miss shows
    // skeletons while IndexedDB / the Drive API is consulted (loadListing).
    if (listingCache[folderId]) {
      applyListing(folderId, listingCache[folderId], opts);
    } else {
      state.listing = null;
      teardownVirtual();
      clearDynamic();
      showSkeletons(true);

      loadListing(folderId).then(function (data) {
        applyListing(folderId, data, opts);
      }).catch(function () {
        if (state.folder !== folderId) return;
        // The Drive is connected and working. A hiccup here is transient, so we
        // never show the obsolete "couldn't load / try again" copy. Instead we
        // retry silently once in the background and simply keep the current view.
        var retryFolder = folderId;
        setTimeout(function () {
          if (state.folder !== retryFolder) return;
          loadListing(retryFolder).then(function (data) {
            applyListing(retryFolder, data);
          }).catch(function () {
            // Still failing → leave a clean, silent state (no error banner).
            if (state.folder !== retryFolder) return;
            showSkeletons(false);
            clearDynamic();
          });
        }, 1200);
      });
    }

    if (!opts.replace) {
      var url = folderId === 'root' ? '/library' : '/library?folder=' + encodeURIComponent(folderId);
      history.pushState({ folder: folderId }, '', url);
    }
  }

  function findTopSubject(crumbs) {
    return crumbs && crumbs.length > 1 ? crumbs[1].id : 'root';
  }
  function highlightSubject(id) {
    var links = els.subjects.querySelectorAll('.gd-subject');
    for (var i = 0; i < links.length; i++) {
      links[i].classList.toggle('is-active', links[i].getAttribute('data-folder') === id);
    }
  }
  function prefetchChildren(folders) {
    if (!folders || !folders.length) return;
    var run = function () {
      folders.slice(0, 6).forEach(function (f) {
        // loadListing = memory → IndexedDB → network, so warming a child folder
        // that's already persisted costs no request at all.
        if (!listingCache[f.id] && !inflight[f.id]) loadListing(f.id).catch(function () {});
      });
    };
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1500 });
    else setTimeout(run, 600);
  }
  // Warm viewer-meta for the first few unlocked files in a folder so tapping
  // any of them opens instantly (meta is tiny; content still streams on open).
  function prefetchFileMetas(files) {
    if (!files || !files.length || !state.subscriber) return;
    var run = function () {
      var n = 0;
      for (var i = 0; i < files.length && n < 8; i++) {
        if (files[i].locked) continue;
        prefetchMeta(files[i].id, false);
        n++;
      }
    };
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 2000 });
    else setTimeout(run, 800);
  }

  /* ------------------------------------------------- locked-file → modal */
  function openSubscribeModal(name) {
    var lede = document.getElementById('subscribe-modal-lede');
    var title = document.getElementById('subscribe-modal-title');
    if (title) title.textContent = 'هذا الملف متاح للمشتركين فقط';
    if (lede) {
      lede.innerHTML = name
        ? 'الملف <strong>' + esc(name) + '</strong> متاح للمشتركين فقط. للاشتراك تواصل مع المالك عبر تيك توك لفتح جميع الملفات داخل الموقع.'
        : 'هذا الملف متاح للمشتركين فقط. للاشتراك تواصل مع المالك عبر تيك توك لفتح جميع الملفات داخل الموقع.';
    }
    var overlay = document.getElementById('subscribe-modal');
    if (!overlay) return;
    overlay.hidden = false;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { overlay.classList.add('is-open'); });
    });
    document.body.style.overflow = 'hidden';
    var closeBtn = overlay.querySelector('.js-modal-close');
    if (closeBtn) closeBtn.focus();
  }
  function closeSubscribeModal() {
    var overlay = document.getElementById('subscribe-modal');
    if (!overlay) return;
    overlay.classList.remove('is-open');
    document.body.style.overflow = '';
    setTimeout(function () { overlay.hidden = true; }, 200);
  }

  /* ----------------------------------------------- SPA in-app file viewer
     Opening, switching between, and closing files happens in this overlay
     without a full page reload — the library listing (and its cache) stays
     mounted underneath, so navigation is instant, especially on mobile.
     Access is STILL enforced server-side: the gated /meta + /content
     endpoints refuse anything the session isn't entitled to, and we surface
     that by popping the subscribe modal. A direct load of /library/view/:id
     remains a working no-JS fallback. */
  function openFile(id, name, locked) {
    if (locked || !state.subscriber) { openSubscribeModal(name); return; }
    if (!els.viewer) { window.location.href = '/library/view/' + encodeURIComponent(id); return; }
    // Push a history entry so Back closes the viewer (not the whole page).
    _deepLinkViewer = false;
    var url = '/library?' + (state.folder && state.folder !== 'root'
      ? 'folder=' + encodeURIComponent(state.folder) + '&' : '') + 'view=' + encodeURIComponent(id);
    history.pushState({ folder: state.folder, view: id }, '', url);
    showViewer(id, name);
  }

  var viewerSeq = 0;
  function showViewer(id, name) {
    var seq = ++viewerSeq;
    viewerOpen = true;
    _viewerId = id;
    // Retire (do NOT revoke yet) any Blob URLs from a previously-viewed file.
    // They are freed only after the new content is mounted, so an in-flight
    // open can never lose its URL mid-render (blank-page bug).
    retireViewerBlobUrls();
    // Chrome first (instant), then stream content.
    if (els.viewerTitle) els.viewerTitle.textContent = name || '…';
    if (els.viewerBadge) els.viewerBadge.textContent = '';
    if (els.viewerStage) els.viewerStage.innerHTML = '<div class="gd-viewer-spinner"><span class="gd-spin"></span></div>';
    els.viewer.hidden = false;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { els.viewer.classList.add('is-open'); });
    });
    document.body.style.overflow = 'hidden';
    if (els.viewerClose) els.viewerClose.focus();

    fetchMeta(id).then(function (meta) {
      if (seq !== viewerSeq) return;
      return renderViewer(meta, seq);
    }).catch(function (err) {
      if (seq !== viewerSeq) return;
      // Server refused (not entitled / gone) → close viewer, guide the user.
      closeViewer(true);
      if (err && (err.code === 'SUBSCRIPTION_REQUIRED' || err.status === 402 ||
                  err.status === 401 || err.status === 403)) {
        openSubscribeModal(name);
      } else {
        renderViewerMessage('This file could not be opened. Please try again.');
      }
    });
  }

  // Render the viewer for a file. Resolves the bytes through the persistent
  // cache first (instant on a warm cache; still gated on a miss) and renders
  // from an in-memory Blob URL so nothing is ever saved to the device. `seq`
  // guards against a stale async resolve landing after the user switched files.
  function renderViewer(meta, seq) {
    if (els.viewerTitle) els.viewerTitle.textContent = meta.name || '';
    if (els.viewerBadge) els.viewerBadge.textContent = typeLabel(meta.fileType);
    var kind = meta.viewerKind;

    // Reset any zoom UI/state left over from a previous file.
    resetZoomUi();

    // Unsupported types need no bytes at all — render the note immediately.
    if (kind !== 'pdf' && kind !== 'image' && kind !== 'video' && kind !== 'text') {
      var note = '<p class="gd-viewer-msg">This file type can\u2019t be previewed inline, but it stays inside the site \u2014 no external links or downloads.</p>';
      if (meta.sample) {
        note += '<p class="gd-viewer-msg" style="position:absolute;bottom:4px;left:0;right:0;margin:0;font-size:.78rem;">Sample mode \u2014 placeholder content.</p>';
      }
      if (els.viewerStage) els.viewerStage.innerHTML = note;
      revokeStaleBlobUrls();
      return Promise.resolve();
    }

    // Direct gated Worker URL — the fallback if a cached blob turns out bad.
    var directUrl = API + '/file/' + encodeURIComponent(meta.id) + '/content';

    return resolveContentUrl(meta).then(function (contentUrl) {
      // Bail if the viewer moved on (closed or switched) while we resolved.
      if (typeof seq === 'number' && seq !== viewerSeq) return;

      // PDFs: render in-page with PDF.js onto canvases. This keeps the file
      // INSIDE the site's own viewer (crucial on iPhone/Safari, where an
      // <object>/<iframe> PDF is handed off to the system PDF viewer), and lets
      // us offer real zoom / fit-to-width controls. Falls back to an inline
      // <iframe> if PDF.js can't load for any reason.
      if (kind === 'pdf') {
        return renderPdf(contentUrl, meta, seq, directUrl);
      }

      var html;
      if (kind === 'image') {
        // Large, zoom/pan-able image inside a scroll stage.
        html = '<div class="gd-media-scroll" id="gd-media-scroll">' +
          '<img class="gd-viewer-img" id="gd-viewer-img" src="' + esc(contentUrl) + '" alt="' + esc(meta.name) + '" />' +
          '</div>';
      } else if (kind === 'video') {
        html = '<video class="gd-viewer-video" controls controlslist="nodownload" src="' + esc(contentUrl) + '"></video>';
      } else { // text
        html = '<iframe class="gd-viewer-frame" src="' + esc(contentUrl) + '" title="' + esc(meta.name) + '"></iframe>';
      }
      if (meta.sample) {
        html += '<p class="gd-viewer-msg" style="position:absolute;bottom:4px;left:0;right:0;margin:0;font-size:.78rem;">Sample mode \u2014 placeholder content.</p>';
      }
      if (els.viewerStage) els.viewerStage.innerHTML = html;
      // New content is mounted → the previous file's blob URLs are safe to free.
      revokeStaleBlobUrls();

      if (kind === 'image') {
        setupImageZoom();
        wireMediaFallback(document.getElementById('gd-viewer-img'), contentUrl, directUrl, meta);
      } else if (kind === 'video' && els.viewerStage) {
        wireMediaFallback(els.viewerStage.querySelector('.gd-viewer-video'), contentUrl, directUrl, meta);
      }
    });
  }

  // If a blob: URL minted from the persistent cache turns out to be unreadable
  // (evicted / corrupt backing data), transparently retry from the gated Worker
  // endpoint instead of leaving a blank stage, and drop the bad cache entry.
  function wireMediaFallback(el, contentUrl, directUrl, meta) {
    if (!el || !contentUrl || contentUrl.indexOf('blob:') !== 0) return;
    el.addEventListener('error', function () {
      if (FC && FC.supported && FC.removeFile) FC.removeFile(meta.id).catch(function () {});
      el.src = directUrl;
    }, { once: true });
  }
  function renderViewerMessage(msg) {
    if (els.viewerStage) els.viewerStage.innerHTML = '<p class="gd-viewer-msg">' + esc(msg) + '</p>';
  }

  /* ============================================================ ZOOM ENGINE
     A single zoom controller drives both PDF (re-render at scale) and image
     (CSS transform) modes. Default is fit-to-width, which reads best on both
     phone and desktop; the +/- buttons step from there. All of this lives
     inside the site's own overlay — nothing is handed to the OS viewer. */

  // Lazily-loaded PDF.js handle + the currently-open PDF document.
  var _pdfjs = null;            // window.pdfjsLib once loaded
  var _pdfjsLoading = null;     // in-flight load promise
  var _pdfDoc = null;           // current PDFDocumentProxy
  var _pdfRenderSeq = 0;        // guards async page renders across files
  var _pdfGen = 0;   // current PDF document generation
  var _pdfPageViewports = [];   // base (scale=1) viewport per page, for fit calc
  var _pdfObserver = null;      // IntersectionObserver driving lazy page render
  var _pdfCurrentScale = 1;     // effective scale (fit * zoom) of last layout

  // Active zoom mode for the current file: 'pdf' | 'image' | null.
  var _zoomKind = null;
  // Current zoom: a multiplier over the fit-to-width baseline (1 = fit width).
  var _zoomFactor = 1;
  var _zoomFit = true;          // true while tracking fit-to-width
  var ZOOM_MIN = 0.5, ZOOM_MAX = 4, ZOOM_STEP = 0.25;

  var PDFJS_VERSION = '3.11.174';
  var PDFJS_BASE = '/static/vendor/pdfjs/' + PDFJS_VERSION + '/';

  function loadPdfJs() {
    if (_pdfjs) return Promise.resolve(_pdfjs);
    if (_pdfjsLoading) return _pdfjsLoading;
    _pdfjsLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = PDFJS_BASE + 'pdf.min.js';
      s.async = true;
      s.onload = function () {
        var lib = window['pdfjsLib'];
        if (!lib) { reject(new Error('pdfjs missing')); return; }
        try { lib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.js'; } catch (e) {}
        _pdfjs = lib;
        resolve(lib);
      };
      s.onerror = function () { reject(new Error('pdfjs load failed')); };
      document.head.appendChild(s);
    });
    return _pdfjsLoading;
  }

  // Render a PDF fully in-page with PDF.js. `url` is a same-origin/blob URL;
  // `fallbackUrl` is the direct gated Worker URL, used if a cached blob fails.
  function renderPdf(url, meta, seq, fallbackUrl) {
    _zoomKind = null;
    return loadPdfJs().then(function (pdfjs) {
      if (typeof seq === 'number' && seq !== viewerSeq) return;
      // pdfjs.getDocument accepts a URL; blob: and same-origin URLs both work.
      var task = pdfjs.getDocument({ url: url });
      return task.promise;
    }).then(function (doc) {
      if (!doc) return;
      if (typeof seq === 'number' && seq !== viewerSeq) { try { doc.destroy(); } catch (e) {} return; }
      // Drop any previous document.
      if (_pdfDoc) { try { _pdfDoc.destroy(); } catch (e) {} }
      _pdfGen++;
      _pdfDoc = doc;
      _zoomKind = 'pdf';
      _zoomFit = true;
      _zoomFactor = 1;

      // SINGLE-DOWNLOAD cache warm: when the document was streamed from the
      // network (not from a cached blob), harvest the bytes PDF.js has ALREADY
      // downloaded (doc.getData() resolves once its own progressive download
      // completes — zero additional requests) and persist them. This replaces
      // the old second full-file background fetch, halving bandwidth per open.
      // Best-effort: a viewer closed before the download finishes simply skips
      // the cache write for this open (identical to an aborted fetch before).
      if (FC && FC.supported && !meta.sample && url.indexOf('blob:') !== 0) {
        try {
          doc.getData().then(function (u8) {
            if (u8 && u8.length) {
              var blob = new Blob([u8], { type: 'application/pdf' });
              FC.putFile(meta.id, blob, 'application/pdf', meta.name).catch(function () {});
            }
          }).catch(function () { /* doc destroyed early → no cache this open */ });
        } catch (e) { /* cache warming must never break rendering */ }
      }

      var container = document.createElement('div');
      container.className = 'gd-pdf-scroll';
      container.id = 'gd-pdf-scroll';
      if (els.viewerStage) {
        els.viewerStage.innerHTML = '';
        els.viewerStage.appendChild(container);
      }
      // New document is mounted → previous file's blob URLs are safe to free.
      revokeStaleBlobUrls();

      if (meta.sample) {
        var note = document.createElement('p');
        note.className = 'gd-viewer-msg';
        note.style.cssText = 'position:absolute;bottom:4px;left:0;right:0;margin:0;font-size:.78rem;';
        note.textContent = 'Sample mode \u2014 placeholder content.';
        if (els.viewerStage) els.viewerStage.appendChild(note);
      }

      // Pre-create an empty slot per page WITHOUT eagerly fetching every page.
      // Each page's PDFPageProxy + base viewport is fetched lazily the first
      // time it approaches the viewport (see ensurePdfPage / the observer), so
      // opening a many-page document no longer blocks on getPage() for all of
      // them. Slots are pre-sized so the scroll container has a correct total
      // height right away and scrolling is smooth from the first frame.
      _pdfPageViewports = [];
      for (var i = 1; i <= doc.numPages; i++) {
        (function (num) {
          var pageEl = document.createElement('div');
          pageEl.className = 'gd-pdf-page';
          pageEl.setAttribute('data-page', String(num));
          container.appendChild(pageEl);
        })(i);
      }

      // We only need page 1 up front: it gives the base viewport used both for
      // the fit-to-width calc and as the size estimate for not-yet-loaded pages
      // (PDF pages are near-always uniform in size). Everything else is lazy.
      return doc.getPage(1).then(function (page1) {
        if (typeof seq === 'number' && seq !== viewerSeq) { return; }
        _pdfPageViewports[1] = page1.getViewport({ scale: 1 });
        var firstEl = container.querySelector('.gd-pdf-page[data-page="1"]');
        if (firstEl) firstEl._pdfPage = page1;

        _pdfRenderSeq++;
        showZoomUi('pdf');
        // Defer the first paint to the next frame so the overlay/stage has real
        // layout dimensions before we compute fit-to-width. Rendering too early
        // (against a not-yet-laid-out, 0-width stage) produced a blank page on
        // desktop. A second frame is used because the overlay animates in.
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            if (typeof seq === 'number' && seq !== viewerSeq) return;
            layoutPdfPages(seq);
          });
        });
      });
    }).catch(function (err) {
      if (typeof seq === 'number' && seq !== viewerSeq) return;
      // A cached blob: URL whose backing data can't be read must never end in
      // a blank page — drop the bad cache entry and retry ONCE straight from
      // the gated Worker endpoint.
      if (fallbackUrl && url !== fallbackUrl && url.indexOf('blob:') === 0) {
        if (FC && FC.supported && FC.removeFile) FC.removeFile(meta.id).catch(function () {});
        return renderPdf(fallbackUrl, meta, seq, fallbackUrl);
      }
      // PDF.js unavailable (offline / blocked CDN) → graceful inline fallback so
      // the file still opens. On iOS this may hand off to the system viewer, but
      // that only happens when in-page rendering is impossible.
      var fb = '<iframe class="gd-viewer-frame" src="' + esc(fallbackUrl || url) + '" title="' + esc(meta.name) + '"></iframe>';
      if (els.viewerStage) els.viewerStage.innerHTML = fb;
      revokeStaleBlobUrls();
      hideZoomUi();
    });
  }

  // Compute the scale that makes a page fill the available stage width.
  function pdfFitScale() {
    var scroller = document.getElementById('gd-pdf-scroll');
    var stage = els.viewerStage;
    var base = _pdfPageViewports && _pdfPageViewports.length ? _pdfPageViewports[1] : null;
    // find first available viewport
    if (!base) {
      for (var k = 0; k < _pdfPageViewports.length; k++) { if (_pdfPageViewports[k]) { base = _pdfPageViewports[k]; break; } }
    }
    if (!base) return 1;
    // Measure the real content width of the scroll container (its clientWidth
    // already excludes any vertical scrollbar). The 32px accounts for the
    // .gd-pdf-scroll left/right padding (16px each). Fall back to the stage,
    // then the window, so we never fit against a 0-width box (which would draw
    // a zero-size canvas → blank page, the desktop bug).
    var box = 0;
    if (scroller && scroller.clientWidth) box = scroller.clientWidth - 32;
    if (box < 120 && stage && stage.clientWidth) box = stage.clientWidth - 32;
    if (box < 120) box = (window.innerWidth || 360) - 32;
    if (box < 120) box = 320;
    var s = box / base.width;
    if (!isFinite(s) || s <= 0) s = 1;
    return s;
  }

  // Estimate a page's base (scale=1) size. Uses the page's own viewport once it
  // has been fetched; otherwise falls back to page 1's size (PDF pages are
  // near-always uniform), so a not-yet-loaded page still gets a correct-enough
  // placeholder height for smooth scrolling.
  function pdfBaseSize(num) {
    var vp = _pdfPageViewports[num] || _pdfPageViewports[1];
    if (vp) return { width: vp.width, height: vp.height };
    return null;
  }

  // Maximum backing-store pixel area allowed per canvas (~16.7M px, e.g.
  // 4096x4096). Bounds memory on very large pages without a blanket dpr cap.
  var MAX_CANVAS_AREA = 16777216;

  // Clamp the effective device pixel ratio so the canvas backing store
  // (cssW*dpr x cssH*dpr) stays under MAX_CANVAS_AREA. Typical 3x phone pages
  // are well under budget, so they keep the full native ratio (no blur); only
  // extreme pages get scaled down to protect memory.
  function clampDprForArea(dpr, cssW, cssH) {
    if (!(dpr > 0)) dpr = 1;
    var area = cssW * cssH;
    if (area > 0 && area * dpr * dpr > MAX_CANVAS_AREA) {
      dpr = Math.sqrt(MAX_CANVAS_AREA / area);
    }
    return dpr < 1 ? 1 : dpr;
  }

  // Reserve layout space for a page slot at the current effective scale WITHOUT
  // rendering it. Setting an explicit min-width/height gives the scroll
  // container its full, correct height up front so the scrollbar and the
  // IntersectionObserver behave, and pages don't jump as they render in.
  function sizePdfSlot(pageEl, scale) {
    var num = parseInt(pageEl.getAttribute('data-page'), 10);
    var base = pdfBaseSize(num);
    if (!base) return;
    var w = Math.floor(base.width * scale);
    var h = Math.floor(base.height * scale);
    pageEl.style.width = w + 'px';
    pageEl.style.height = h + 'px';
    // Track what scale this slot is currently sized/rendered at so we can tell
    // when a re-render (after zoom) is actually needed.
    pageEl._sizedScale = scale;
  }

  // Lazily fetch a page's PDFPageProxy (and cache its base viewport) the first
  // time we need it. Returns a promise resolving to the page, or null if the
  // document/seq is stale.
  function ensurePdfPage(pageEl) {
    if (pageEl._pdfPage) return Promise.resolve(pageEl._pdfPage);
    if (pageEl._pageLoading) return pageEl._pageLoading;
    if (!_pdfDoc) return Promise.resolve(null);
    var num = parseInt(pageEl.getAttribute('data-page'), 10);
    var doc = _pdfDoc;
    pageEl._pageLoading = doc.getPage(num).then(function (page) {
      pageEl._pageLoading = null;
      if (_pdfDoc !== doc) { try { page.cleanup(); } catch (e) {} return null; }
      _pdfPageViewports[num] = page.getViewport({ scale: 1 });
      pageEl._pdfPage = page;
      return page;
    }).catch(function () { pageEl._pageLoading = null; return null; });
    return pageEl._pageLoading;
  }

  // Draw a single page's canvas at the current effective scale. Skipped if the
  // page is already rendered at that exact scale (avoids redundant work while
  // scrolling back and forth).
  function renderPdfPage(pageEl, gen) {
    if (!_pdfDoc || !pageEl) return;
    if (typeof gen !== 'number') gen = _pdfGen;
    if (gen !== _pdfGen) return;
    var scale = _pdfCurrentScale;
    if (pageEl._renderedScale === scale && pageEl.querySelector('canvas')) return;
    ensurePdfPage(pageEl).then(function (page) {
      if (!page || !_pdfDoc || gen !== _pdfGen) return;
      // Bail if a zoom/relayout changed the target scale while we were loading.
      if (_pdfCurrentScale !== scale) { renderPdfPage(pageEl, gen); return; }
      // Make sure the slot is sized to this page's real viewport now we have it.
      sizePdfSlot(pageEl, scale);
      var viewport = page.getViewport({ scale: scale });
      // Use the FULL device pixel ratio so pages render at the screen's native
      // resolution (crisp on Retina / 3x phones). Instead of a blanket dpr=2
      // cap, only clamp the effective ratio when a single canvas would exceed a
      // sane backing-store pixel budget, so normal pages keep full sharpness.
      var dpr = window.devicePixelRatio || 1;
      dpr = clampDprForArea(dpr, viewport.width, viewport.height);
      var canvas = pageEl.querySelector('canvas');
      if (!canvas) {
        canvas = document.createElement('canvas');
        pageEl.appendChild(canvas);
      }
      // Cancel any in-flight render for this page before starting a new one.
      if (pageEl._renderTask && pageEl._renderTask.cancel) {
        try { pageEl._renderTask.cancel(); pageEl._renderTask = null; } catch (e) {}
      }
      if (gen !== _pdfGen || !_pdfDoc) return;
      // CSS size = layout size; backing store scaled by dpr for sharpness.
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      var ctx = canvas.getContext('2d');
      var renderTask = page.render({
        canvasContext: ctx,
        viewport: viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      });
      pageEl._renderTask = renderTask;
      if (renderTask && renderTask.promise) {
        renderTask.promise.then(function () {
          if (gen === _pdfGen) pageEl._renderedScale = scale;
        // Ignore errors from cancelled renders when the user zooms rapidly.
        }).catch(function () {});
      }
    });
  }

  // Release a page's canvas + cached proxy when it is far from the viewport, so
  // long documents don't accumulate hundreds of live canvases. The slot keeps
  // its reserved size, so scroll position and layout are unaffected.
  function releasePdfPage(pageEl) {
    if (!pageEl) return;
    if (pageEl._renderTask && pageEl._renderTask.cancel) {
      try { pageEl._renderTask.cancel(); } catch (e) {}
    }
    pageEl._renderTask = null;
    var canvas = pageEl.querySelector('canvas');
    if (canvas) {
      // Zero the backing store first so the browser frees the pixel buffer.
      canvas.width = canvas.height = 0;
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }
    pageEl._renderedScale = null;
  }

  // Shared observer that renders pages as they approach the viewport and frees
  // them once they scroll well away. Rebuilt per document so `root` is correct.
  function buildPdfObserver() {
    if (_pdfObserver) { try { _pdfObserver.disconnect(); } catch (e) {} _pdfObserver = null; }
    var container = document.getElementById('gd-pdf-scroll');
    if (!container || !('IntersectionObserver' in window)) return null;
    var obsGen = _pdfGen;
    _pdfObserver = new IntersectionObserver(function (entries) {
      if (obsGen !== _pdfGen) return;
      for (var i = 0; i < entries.length; i++) {
        var pageEl = entries[i].target;
        if (entries[i].isIntersecting) renderPdfPage(pageEl, obsGen);
        else releasePdfPage(pageEl);
      }
    }, {
      root: container,
      // Render pages just BEFORE they enter the viewport so their text is ready
      // as the user reaches them; keep a matching release margin for memory.
      rootMargin: '600px 0px',
      threshold: 0.01,
    });
    return _pdfObserver;
  }

  // Layout pass: (re)compute fit-to-width, size every slot, then let the
  // IntersectionObserver render only the pages in/near the viewport. Called for
  // the first paint and again on every zoom change — never blanks the whole
  // document, because untouched off-screen pages keep their existing canvas
  // until the observer decides to re-render or release them.
  function layoutPdfPages(seq) {
    if (!_pdfDoc) return;
    if (typeof seq === 'number' && seq !== viewerSeq) return;
    _pdfRenderSeq++;
    var fit = pdfFitScale();
    var scale = fit * _zoomFactor;
    _pdfCurrentScale = scale;
    var container = document.getElementById('gd-pdf-scroll');
    if (!container) return;
    var pages = container.querySelectorAll('.gd-pdf-page');
    // Reserve space for every slot at the new scale so total height is correct.
    for (var i = 0; i < pages.length; i++) sizePdfSlot(pages[i], scale);
    // (Re)wire the observer and start watching every slot. If a page already
    // has a canvas at the old scale it stays visible until the observer fires
    // and re-renders it at the new scale — so zooming never blanks the doc.
    var obs = buildPdfObserver();
    if (obs) {
      for (var j = 0; j < pages.length; j++) obs.observe(pages[j]);
    } else {
      // No IntersectionObserver (very old browser): render everything eagerly.
      for (var k = 0; k < pages.length; k++) renderPdfPage(pages[k]);
    }
    updateZoomLabel();
  }

  // Backwards-compatible alias: zoom handlers call this to re-flow at the new
  // scale. It now re-lays-out and lazily re-renders instead of eagerly redrawing
  // every page (which used to blank the whole document mid-zoom).
  function renderAllPdfPages(seq) {
    layoutPdfPages(seq);
  }

  /* ------------------------------------------------------------ image zoom */
  var _imgZoomBound = false;
  function setupImageZoom() {
    var img = document.getElementById('gd-viewer-img');
    if (!img) return;
    _zoomKind = 'image';
    _zoomFit = true;
    _zoomFactor = 1;
    var apply = function () {
      // Fit = natural CSS max-sizing (baseline). Beyond fit, scale up width.
      if (_zoomFit) {
        img.style.width = '';
        img.style.maxWidth = '100%';
        img.style.maxHeight = '100%';
        img.style.cursor = '';
      } else {
        img.style.maxWidth = 'none';
        img.style.maxHeight = 'none';
        img.style.width = (_zoomFactor * 100) + '%';
        img.style.cursor = 'grab';
      }
      updateZoomLabel();
    };
    img._applyZoom = apply;
    if (img.complete) { showZoomUi('image'); apply(); }
    else img.addEventListener('load', function () { showZoomUi('image'); apply(); }, { once: true });
  }

  /* ---------------------------------------------------------- zoom controls */
  function showZoomUi(kind) {
    _zoomKind = kind;
    if (els.viewerZoom) els.viewerZoom.hidden = false;
    updateZoomLabel();
  }
  function hideZoomUi() {
    if (els.viewerZoom) els.viewerZoom.hidden = true;
  }
  function resetZoomUi() {
    _zoomKind = null;
    _zoomFit = true;
    _zoomFactor = 1;
    _pdfPageViewports = [];
    _pdfCurrentScale = 1;
    // Stop the lazy-render observer and release every rendered page + canvas so
    // memory is fully freed (mirrors the eager teardown the old renderer had).
    _pdfGen++;
    if (_pdfObserver) { try { _pdfObserver.disconnect(); } catch (e) {} _pdfObserver = null; }
    var container = document.getElementById('gd-pdf-scroll');
    if (container) {
      var pages = container.querySelectorAll('.gd-pdf-page');
      for (var i = 0; i < pages.length; i++) {
        releasePdfPage(pages[i]);
        pages[i]._pdfPage = null;
        pages[i]._pageLoading = null;
      }
    }
    if (_pdfDoc) { try { _pdfDoc.destroy(); } catch (e) {} _pdfDoc = null; }
    hideZoomUi();
  }
  function updateZoomLabel() {
    if (!els.zoomLevel) return;
    if (_zoomFit) { els.zoomLevel.textContent = 'ملائم للعرض'; return; }
    els.zoomLevel.textContent = Math.round(_zoomFactor * 100) + '%';
  }

  function applyZoom() {
    if (_zoomKind === 'pdf') {
      renderAllPdfPages();
    } else if (_zoomKind === 'image') {
      var img = document.getElementById('gd-viewer-img');
      if (img && img._applyZoom) img._applyZoom();
    }
  }

  function zoomIn() {
    if (!_zoomKind) return;
    if (_zoomFit) { _zoomFit = false; _zoomFactor = 1; }
    _zoomFactor = Math.min(ZOOM_MAX, +(_zoomFactor + ZOOM_STEP).toFixed(2));
    applyZoom();
  }
  function zoomOut() {
    if (!_zoomKind) return;
    if (_zoomFit) { _zoomFit = false; _zoomFactor = 1; }
    _zoomFactor = Math.max(ZOOM_MIN, +(_zoomFactor - ZOOM_STEP).toFixed(2));
    // Dropping back to ~fit snaps to fit-to-width for a clean baseline.
    if (_zoomFactor <= 1) { _zoomFit = true; _zoomFactor = 1; }
    applyZoom();
  }
  function zoomFit() {
    if (!_zoomKind) return;
    _zoomFit = true;
    _zoomFactor = 1;
    applyZoom();
  }

  function closeViewer(skipHistory) {
    if (!els.viewer) return;
    viewerOpen = false;
    viewerSeq++;
    var closeSeq = viewerSeq;
    els.viewer.classList.remove('is-open');
    document.body.style.overflow = '';
    // Tear down zoom state + the PDF document (frees canvases / worker memory).
    resetZoomUi();
    setTimeout(function () {
      // If the viewer was REOPENED during the close animation, do NOT tear it
      // down — hiding the stage / revoking the freshly-minted blob URLs here
      // was exactly what produced the blank white page on a close→reopen.
      if (closeSeq !== viewerSeq || viewerOpen) return;
      els.viewer.hidden = true;
      if (els.viewerStage) els.viewerStage.innerHTML = '';
      // Free the in-memory Blob URLs once the viewer is fully closed.
      revokeViewerBlobUrls();
    }, 200);
    _deepLinkViewer = false;
    // Drop the ?view= history entry unless the caller is already reacting to a
    // popstate (Back button), in which case history moved for us.
    if (!skipHistory) {
      var url = state.folder === 'root' ? '/library' : '/library?folder=' + encodeURIComponent(state.folder);
      history.replaceState({ folder: state.folder }, '', url);
    }
  }

  // User-triggered close (button / Escape). If we pushed our own history entry
  // when opening, going Back closes it and keeps history tidy; for a direct
  // deep-link load there's nothing to go back to, so close in place.
  function dismissViewer() {
    if (!viewerOpen) return;
    if (_deepLinkViewer) closeViewer(false);
    else history.back();
  }

  /* ------------------------------------------------------ sidebar drawer */
  function openSidebar() {
    if (!els.sidebar) return;
    els.sidebar.classList.add('is-open');
    if (els.scrim) { els.scrim.hidden = false; requestAnimationFrame(function () { els.scrim.classList.add('is-open'); }); }
    if (els.menuToggle) els.menuToggle.setAttribute('aria-expanded', 'true');
  }
  function closeSidebar() {
    if (!els.sidebar) return;
    els.sidebar.classList.remove('is-open');
    if (els.scrim) { els.scrim.classList.remove('is-open'); setTimeout(function () { els.scrim.hidden = true; }, 200); }
    if (els.menuToggle) els.menuToggle.setAttribute('aria-expanded', 'false');
  }

  /* -------------------------------------------------------- event wiring */
  function onDelegatedClick(e) {
    // Modal close
    if (e.target.closest('.js-modal-close')) { e.preventDefault(); closeSubscribeModal(); return; }
    // Subscribe triggers (account button / cta)
    if (e.target.closest('.js-subscribe') || e.target.closest('.js-subscribe-cta')) {
      var cta = e.target.closest('.js-subscribe-cta');
      if (!cta) { e.preventDefault(); openSubscribeModal(); return; }
      // cta is a real link → let it navigate to TikTok
    }
    // Clicking the modal overlay backdrop closes it
    var overlay = document.getElementById('subscribe-modal');
    if (overlay && e.target === overlay) { closeSubscribeModal(); return; }

    var inResults = els.searchResults && els.searchResults.contains(e.target);
    var folderEl = e.target.closest('[data-folder]');
    if (folderEl && (els.content.contains(folderEl) || els.breadcrumb.contains(folderEl) || els.subjects.contains(folderEl) || inResults)) {
      e.preventDefault();
      navigate(folderEl.getAttribute('data-folder'), { scrollTop: true });
      return;
    }
    var fileEl = e.target.closest('[data-file]');
    if (fileEl && (els.content.contains(fileEl) || inResults)) {
      e.preventDefault();
      openFile(fileEl.getAttribute('data-file'), fileEl.getAttribute('data-name'), fileEl.getAttribute('data-locked') === '1');
    }
  }

  function onDelegatedHover(e) {
    var folderEl = e.target.closest('[data-folder]');
    if (folderEl) {
      var id = folderEl.getAttribute('data-folder');
      if (id && id !== 'root' && !listingCache[id] && !inflight[id]) loadListing(id).catch(function () {});
      return;
    }
    // Prefetch a file's viewer metadata on hover so opening it is instant.
    var fileEl = e.target.closest('[data-file]');
    if (fileEl) {
      prefetchMeta(fileEl.getAttribute('data-file'), fileEl.getAttribute('data-locked') === '1');
    }
  }

  /* ---------------------------------------------------- GLOBAL SEARCH */
  var searchTimer = null;
  function onSearch() {
    var q = (els.search.value || '').trim();
    if (els.searchClear) els.searchClear.hidden = q.length === 0;
    clearTimeout(searchTimer);
    if (q.length < 2) { exitSearch(); return; }
    searchTimer = setTimeout(function () { runSearch(q); }, 150);
  }

  function fetchSearch(q) {
    var key = q.toLowerCase();
    if (searchCache[key]) return Promise.resolve(searchCache[key]);
    var url = API + '/search?q=' + encodeURIComponent(q);
    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.error) || 'bad response');
        searchCache[key] = data;
        return data;
      });
  }

  function enterSearch() {
    state.searching = true;
    showSkeletons(false);
    teardownVirtual();
    clearDynamic();
    hide(els.empty); hide(els.error);
    if (els.searchResults) els.searchResults.hidden = false;
  }
  function exitSearch() {
    if (!state.searching && els.search.value === '') return;
    state.searching = false;
    searchSeq++;
    if (els.searchResults) els.searchResults.hidden = true;
    if (els.searchEmpty) els.searchEmpty.hidden = true;
    if (els.searchBody) els.searchBody.innerHTML = '';
    if (state.listing) renderContent();
  }

  function runSearch(q) {
    var seq = ++searchSeq;
    enterSearch();
    if (els.searchSummary) els.searchSummary.textContent = 'Searching…';
    if (els.searchEmpty) els.searchEmpty.hidden = true;
    if (els.searchBody) els.searchBody.innerHTML = '';

    fetchSearch(q).then(function (data) {
      if (seq !== searchSeq) return;
      state.subscriber = !!data.subscriber;
      renderSearchResults(q, data);
    }).catch(function () {
      if (seq !== searchSeq) return;
      if (els.searchSummary) els.searchSummary.textContent = 'Search failed — please try again.';
      if (els.searchBody) els.searchBody.innerHTML = '';
      if (els.searchEmpty) els.searchEmpty.hidden = true;
    });
  }

  function searchFolderRow(f) {
    return '<button type="button" class="gd-row gd-folder" data-folder="' + esc(f.id) + '">' +
      '<span class="gd-row-name"><span class="gd-card-icon">' + IC.folder + '</span>' +
        '<span class="gd-row-title">' + esc(f.name) + '</span></span>' +
      '<span class="gd-row-meta gd-col-type">Folder</span>' +
      '<span class="gd-row-meta gd-col-modified gd-result-path">' + esc(f.parentPath || 'Library') + '</span>' +
      '<span class="gd-row-end"><span class="gd-row-open">' + IC.chevron + '</span></span>' +
      '</button>';
  }
  function searchFileRow(f) {
    var locked = f.locked;
    var end = locked
      ? '<span class="gd-row-lock" title="Locked">' + IC.lock + '</span>'
      : '<span class="gd-row-open" title="Open">' + IC.open + '</span>';
    return '<button type="button" class="gd-row gd-file' + (locked ? ' is-locked' : '') +
      '" data-file="' + esc(f.id) + '" data-locked="' + (locked ? '1' : '0') + '" data-name="' + esc(f.name) + '">' +
      '<span class="gd-row-name"><span class="gd-card-icon">' + fileGlyph(f.fileType) + '</span>' +
        '<span class="gd-row-title">' + esc(f.name) + '</span></span>' +
      '<span class="gd-row-meta gd-col-type">' + esc(typeLabel(f.fileType)) + '</span>' +
      '<span class="gd-row-meta gd-col-modified gd-result-path">' + esc(f.parentPath || 'Library') + '</span>' +
      '<span class="gd-row-end">' + end + '</span>' +
      '</button>';
  }

  function renderSearchResults(q, data) {
    var folders = data.folders || [];
    var files = data.files || [];
    var total = folders.length + files.length;

    if (total === 0) {
      if (els.searchSummary) els.searchSummary.textContent = 'No matches for “' + q + '”';
      if (els.searchBody) els.searchBody.innerHTML = '';
      if (els.searchEmpty) els.searchEmpty.hidden = false;
      return;
    }
    if (els.searchEmpty) els.searchEmpty.hidden = true;

    var summary = total + (total === 1 ? ' result' : ' results') + ' for “' + q + '”';
    if (data.truncated) summary += ' (showing the first ' + total + ')';
    if (els.searchSummary) els.searchSummary.textContent = summary;

    var html = '';
    if (folders.length) {
      html += '<p class="gd-search-group">Folders</p>';
      html += '<div class="gd-list">' + folders.map(searchFolderRow).join('') + '</div>';
    }
    if (files.length) {
      html += '<p class="gd-search-group">Files</p>';
      html += '<div class="gd-list">' + files.map(searchFileRow).join('') + '</div>';
    }
    if (els.searchBody) els.searchBody.innerHTML = html;
  }

  /* --------------------------------------------------------------- init */
  function init() {
    els.viewGrid.addEventListener('click', function () { setView('grid'); });
    els.viewList.addEventListener('click', function () { setView('list'); });
    setView(state.view);

    if (els.search) {
      els.search.addEventListener('input', onSearch);
      els.search.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { els.search.value = ''; onSearch(); els.search.blur(); }
      });
    }
    if (els.searchIcon) els.searchIcon.addEventListener('click', function () { els.search && els.search.focus(); });
    if (els.searchClear) els.searchClear.addEventListener('click', function () {
      els.search.value = ''; els.searchClear.hidden = true; exitSearch(); els.search.focus();
    });
    if (els.searchBack) els.searchBack.addEventListener('click', function () {
      els.search.value = ''; if (els.searchClear) els.searchClear.hidden = true; exitSearch(); els.search.focus();
    });

    document.addEventListener('click', onDelegatedClick);
    document.addEventListener('mouseover', onDelegatedHover, { passive: true });

    if (els.retry) els.retry.addEventListener('click', function () { navigate(state.folder, { replace: true }); });

    // Leftover log-out control (there are no accounts any more). It deliberately
    // NO LONGER wipes the file cache: with no user there is nothing to log out
    // of, and dropping an anonymous visitor's cached files on a stray click is
    // exactly the invalidation this cache must never do.
    if (els.logout) els.logout.addEventListener('click', function () {
      if (els.logout.disabled) return;
      els.logout.disabled = true;
      fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
        .then(function () { window.location.href = '/login'; })
        .catch(function () { window.location.href = '/login'; });
    });

    // Sidebar drawer (mobile)
    if (els.menuToggle) els.menuToggle.addEventListener('click', function () {
      if (els.sidebar.classList.contains('is-open')) closeSidebar(); else openSidebar();
    });
    if (els.scrim) els.scrim.addEventListener('click', closeSidebar);

    // In-app viewer close button
    if (els.viewerClose) els.viewerClose.addEventListener('click', dismissViewer);

    // Zoom controls
    if (els.zoomIn)  els.zoomIn.addEventListener('click', zoomIn);
    if (els.zoomOut) els.zoomOut.addEventListener('click', zoomOut);
    if (els.zoomFit) els.zoomFit.addEventListener('click', zoomFit);

    // Keep fit-to-width honest when the viewport changes (rotate / resize).
    var _refitTimer = null;
    window.addEventListener('resize', function () {
      if (!viewerOpen || !_zoomKind || !_zoomFit) return;
      clearTimeout(_refitTimer);
      _refitTimer = setTimeout(function () { applyZoom(); }, 150);
    });

    // Durability hook: when the page is being hidden or unloaded (tab closed,
    // browser backgrounded — extremely common on iPhone right after opening a
    // file), give any in-flight IndexedDB file write a chance to COMMIT so the
    // file is durably cached for the next session instead of being lost and
    // re-downloaded. Best-effort and time-boxed inside FileCache.flush().
    if (FC && FC.supported && FC.flush) {
      var flushCache = function () { try { FC.flush(); } catch (e) {} };
      window.addEventListener('pagehide', flushCache);
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') flushCache();
      });
      // Fallback for browsers that fire only the legacy unload event.
      window.addEventListener('beforeunload', flushCache);
    }

    // Keyboard zoom shortcuts while the viewer is open (+ / - / 0).
    document.addEventListener('keydown', function (e) {
      if (!viewerOpen || !_zoomKind) return;
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomIn(); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomOut(); }
      else if (e.key === '0') { e.preventDefault(); zoomFit(); }
    });

    // Escape closes viewer / modal / sidebar (in priority order)
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (viewerOpen) { dismissViewer(); return; }
      var overlay = document.getElementById('subscribe-modal');
      if (overlay && !overlay.hidden) { closeSubscribeModal(); return; }
      if (els.sidebar && els.sidebar.classList.contains('is-open')) closeSidebar();
    });

    window.addEventListener('popstate', function (e) {
      var viewId = (e.state && e.state.view) || viewFromUrl();
      var f = (e.state && e.state.folder) || folderFromUrl() || 'root';
      if (viewId) {
        // History moved to a viewer entry → make sure the folder is right and
        // show the file (no full reload).
        if (state.folder !== f) navigate(f, { replace: true });
        if (!viewerOpen || viewerCurrentId() !== viewId) showViewer(viewId, null);
        return;
      }
      // No view in the target entry → close the viewer if open, else navigate.
      if (viewerOpen) { closeViewer(true); if (state.folder !== f) navigate(f, { replace: true }); return; }
      navigate(f, { replace: true });
    });

    var start = folderFromUrl() || 'root';
    var deepView = viewFromUrl();

    // The persistent cache is scoped anonymously (per browser profile), so
    // there is no identity to resolve and no /api/auth/me round-trip to wait
    // for: it is live from the first read. Starting the app is therefore never
    // gated on the cache binding.
    function startApp() {
      navigate(start, { replace: true });
      // Deep link with ?view=<id> → open the SPA viewer over the folder. Mark it
      // so the close button removes the ?view= param instead of leaving the app.
      if (deepView) { _deepLinkViewer = true; showViewer(deepView, null); }
    }

    if (FC && FC.supported) {
      requestPersistentStorage();
      // Records the scope in the cache's meta store; never blocks the app.
      if (FC.bindStoredSession) {
        try { FC.bindStoredSession().catch(function () {}); } catch (e) {}
      }
    }
    startApp();

    // Fire-and-forget: requested once, never awaited by any caller.
    function requestPersistentStorage() {
      if (_persistRequested) return;
      _persistRequested = true;
      try {
        if (navigator.storage && typeof navigator.storage.persist === 'function') {
          navigator.storage.persist().then(function (granted) {
            console.log('[cache] persistent storage granted:', granted);
          }, function (e) {
            console.log('[cache] persist() failed:', e);
          });
        }
      } catch (e) {
        console.log('[cache] persist() failed:', e);
      }
    }

    if (lockedHintFromUrl()) {
      openSubscribeModal();
      try {
        var clean = state.folder === 'root' ? '/library' : '/library?folder=' + encodeURIComponent(state.folder);
        history.replaceState({ folder: state.folder }, '', clean);
      } catch (e) {}
    }
  }

  function lockedHintFromUrl() {
    try { return new URLSearchParams(window.location.search).get('locked') === '1'; }
    catch (e) { return false; }
  }
  function folderFromUrl() {
    try { return new URLSearchParams(window.location.search).get('folder'); }
    catch (e) { return null; }
  }
  function viewFromUrl() {
    try { return new URLSearchParams(window.location.search).get('view'); }
    catch (e) { return null; }
  }
  var _viewerId = null;
  function viewerCurrentId() { return _viewerId; }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* ------------------------------------------------ service worker (SW-1c)
     Registers the shell-only Service Worker so /library can paint offline.
     Deliberately fire-and-forget and registered on `load` so it never
     competes with first paint or the initial API calls. Any failure
     (unsupported browser, insecure origin, blocked registration) is logged
     and otherwise harmless — the page keeps working exactly as before. */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/service-worker.js').then(function (reg) {
        console.log('[sw] registered, scope:', reg.scope);
      }, function (e) { console.log('[sw] registration failed:', e); });
    });
  }
})();
