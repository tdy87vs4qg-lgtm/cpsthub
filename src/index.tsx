import { Hono } from 'hono'
import { spaShell } from './generated/spa-shell'
import { styleGuidePage } from './pages/styleguide'
import { libraryPage } from './pages/library'
import { shelfPage } from './pages/shelf'
import { shelfFolderPage } from './pages/shelfFolder'
import { adminPage } from './pages/admin'
import { libraryApi } from './routes/library'
import { publicApi } from './routes/public'
import { authApi } from './routes/auth'
import { adminApi } from './routes/admin'
import type { Env } from './lib/drive'
import { getFileMeta } from './lib/drive'
import { isSubscriber } from './lib/auth'
import { getSessionUser } from './lib/auth'
import { getSubscriberStats } from './lib/users'
import { requireActiveSubscriber, type AuthVars } from './lib/guards'
// Presentation-only shared markup for the redesign (faint background doodles,
// the animated sun/moon toggle, the pre-paint theme resolver and the theme
// stylesheet links). Pure string constants — no logic, no routes.
import { bgDecor, themeToggle, themeBoot, themeHead } from './pages/_decor'

const app = new Hono<{ Bindings: Env; Variables: AuthVars }>()

/** HTML-escape helper for safely injecting server values into the viewer. */
function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string)
  )
}

/**
 * Palette for the standalone in-app file viewer pages
 * (`/library/view/:id` and its not-found fallback).
 *
 * REDESIGN NOTE — APPEARANCE ONLY: these pages reuse tokens.css +
 * components.css, so the base `--color-*` tokens are re-pointed at the
 * finished prototype's palette (white canvas + #6C3EF4 purple in light; deep
 * slate #0E1016 in dark) instead of the previous ink-navy/cyan scheme. The
 * mapping itself now lives in /static/taysir-theme.css §17.4, which these
 * pages load; the few rules kept here only re-assert the canvas and the
 * frosted bar, scoped under `html[data-theme="…"]` so the admin page (which
 * has no data-theme) is unaffected.
 *
 * Nothing about the viewer's behaviour is touched: the gated content URL, the
 * PDF.js pipeline, the zoom controls and the media elements are unchanged.
 */
const viewerBrandTheme = `
  html[data-theme="light"] body,
  html:not([data-theme="dark"]) body { background-color: var(--bg); color: var(--text); }
  html[data-theme="dark"] body { background-color: var(--bg); color: var(--text); }
  html[data-theme="light"] .viewer-shell,
  html:not([data-theme="dark"]) .viewer-shell { background: var(--bg); }
  html[data-theme="dark"] .viewer-shell { background: var(--bg); }
  .viewer-frame { border-color: var(--border-strong); background: var(--bg-elevated); }
  .viewer-zoombar { background: var(--bg-tabs); }
  .viewer-zoombar button { color: var(--text); }
  .viewer-zoombar button:hover { background: var(--purple-soft); color: var(--purple); }
  .viewer-back { border-radius: var(--radius-btn); font-weight: 800; }
  .badge-primary {
    background: var(--purple-soft);
    color: var(--purple);
    border-radius: 999px;
    font-weight: 700;
  }
  .viewer-pdf .pdf-page {
    border-radius: 12px;
    box-shadow: var(--shadow-md);
    background: var(--illu-paperPure);
  }
`.trim()

// ---------------------------------------------------------------------------
// PUBLIC / EXTERIOR EXPERIENCE — the "تيسير" React SPA.
//
// The exterior (home, login, signup) is a Vite/React single-page
// app. Its hashed JS/CSS assets are served as static files from /react/* (the
// Cloudflare Pages asset layer resolves those before the worker runs); the SPA
// *shell* HTML is returned by the worker for every client-routed public path so
// React Router can boot on a hard refresh / deep link.
//
// The flow is: exterior (تيسير) → login → internal drive. The login/signup
// forms POST to /api/auth/* (below); on success the browser hard-navigates to
// /library (or /admin), handing control to the ORIGINAL internal experience.
const PUBLIC_SPA_ROUTES = ['/', '/login', '/signup']
for (const route of PUBLIC_SPA_ROUTES) {
  app.get(route, (c) => c.html(spaShell))
}

// Design-system style guide (Task 1 deliverable)
app.get('/styleguide', (c) => c.html(styleGuidePage))

// Library browser (Task 3 deliverable) — dynamic content is fetched
// client-side from /api/library/* which proxies Google Drive server-side.
app.get('/library', (c) => c.html(libraryPage))

// Shelf (home) page — merge step 5/10.
//
// The cartoon "library room" shelf, adapted from the staged design source in
// library-src/index.html (see src/pages/shelf.ts for exactly what was adapted).
// Same shape as /library and /styleguide above: a static server-rendered HTML
// string handed to c.html(). It has NO server-side gate in this step — the
// subscription/Drive wiring lands in later steps — so it deliberately does not
// touch the session, guards or Drive helpers.
//
// Its assets are plain static files under public/ (served by the Cloudflare
// Pages asset layer BEFORE this worker runs, per _routes.json "exclude"):
//   /static/shelf.css              — isolated skin, scoped under .shelf-root
//   /static/shelf/js/config.js     — subject list + cover paths (loaded first)
//   /static/shelf/js/app.js        — shelf behaviour
//   /static/shelf/covers/*.png     — the 8 book covers
app.get('/shelf', (c) => c.html(shelfPage))

// Subject (folder) page — merge step 9/10.
//
// The "inside a book" folder scene, adapted from library-src/folder.html (see
// src/pages/shelfFolder.ts for exactly what was adapted). Registered with the
// SAME shape as /shelf directly above: a static server-rendered HTML string
// handed to c.html(), with NO server-side gate — it does not touch the
// session, guards or Drive helpers in this step either.
//
// This is where a book on /shelf navigates. config.js builds that link in
// window.TAYSIR_FOLDER_URL, repointed in this step from the raw staged file
// "folder.html?..." to this route, keeping the query string identical:
//
//   /shelf/folder?subject=<key>&folder=<driveId>
//
// The two query params are NOT read here. They are read client-side by
// public/static/shelf/js/app.js → initFolderPage() via URLSearchParams,
// exactly as the original folder.html expected, so the handler stays a pure
// static response and Hono ignores the query string when matching.
//
// ROUTING: no _redirects / _routes.json change is needed. "/shelf/folder" is a
// literal Hono path with no wildcard above it, and the SPA shell is only
// returned for the three exact paths in PUBLIC_SPA_ROUTES ('/', '/login',
// '/signup') — there is no app.get('*') catch-all — so
// nothing can swallow this route. The public/_redirects "/* /index.html 200"
// line is the Pages ASSET-layer fallback, which only runs when neither a
// static asset nor the worker answers; dist/_routes.json sends every path
// except /_redirects, /react/* and /static/* to the worker first, so
// /shelf/folder reaches this handler exactly like /shelf already does.
//
// It reuses the SAME static assets as /shelf (served by the Pages asset layer
// before this worker runs, per the _routes.json "exclude" list):
//   /static/shelf.css              — isolated skin, scoped under .shelf-root
//   /static/shelf/js/config.js     — subject list + cover paths (loaded first)
//   /static/shelf/js/app.js        — shelf + folder behaviour
//   /static/shelf/covers/*.png     — the 8 book covers
//
// NO DRIVE WIRING HERE (step 10/10): window.TAYSIR_FOLDER_ITEMS is still [] in
// config.js, so the shelves render empty with app.js's Arabic note.
app.get('/shelf/folder', (c) => c.html(shelfFolderPage))

// Server-side Google Drive API (key + folder id live only in env/secrets)
app.route('/api/library', libraryApi)
app.route('/api/public', publicApi)

// Auth API (Task 4A) — login / logout / me. Accounts are admin-provisioned in
// D1; there is no public self-signup. Role-based route protection (Part B) and
// file-access gating (Part C) build on top of this foundation.
app.route('/api/auth', authApi)

// Admin dashboard PAGE (Task 9, Steps 1–2/3) — admin-ONLY console UI.
//
// Server-side protection: we resolve the session on the server and require a
// live, ACTIVE 'admin' account before rendering ANY of the dashboard markup.
// Because this is a PAGE (not a JSON API) we bounce unauthorized visitors with
// a redirect instead of a JSON error:
//   • not signed in / suspended  → /login  (the exterior sign-in form)
//   • signed in but not an admin → /library   (their normal area)
// The privileged stats are computed server-side (getSubscriberStats → D1) and
// only the final numbers are sent to the browser.
//
// Step 2 adds the CREATE & EDIT UI: an account list + a "New subscriber" form
// and per-row "Edit" form. Those forms call the already-existing admin-only
// endpoints (POST/PATCH /api/admin/accounts[/:id]); the browser only ever
// carries the opaque session cookie, and every mutation is re-authorised and
// validated server-side. The admin's own id is passed to the page purely so
// the UI can label their row + soft-guard self-demotion (the server enforces
// the real rule).
app.get('/admin', async (c) => {
  const user = await getSessionUser(c)
  if (!user || user.status !== 'active') {
    return c.redirect('/login')
  }
  if (user.role !== 'admin') {
    return c.redirect('/library')
  }

  const stats = await getSubscriberStats(c.env)
  return c.html(adminPage(stats, user.email, user.id))
})

// Admin account-management API (Task 4B) — create / edit / deactivate /
// reactivate accounts. EVERY endpoint is behind requireRole('admin') inside
// the router, enforced server-side. There is no public self-signup; accounts
// are only ever created here by an authenticated admin. (The admin UI itself
// arrives in Task 9 — this ships the protected endpoints + logic.)
app.route('/api/admin', adminApi)

// In-app file viewer (Task 4C) — files are ALWAYS opened inside the site through
// a server-proxied byte stream, never via a raw Drive link or a download.
//
// Access is gated SERVER-SIDE by requireActiveSubscriber: a guest or non-
// subscriber is redirected back to the library (which pops the subscribe
// modal). Even if someone reached this page, the /file/:id/content endpoint it
// embeds is INDEPENDENTLY gated by the same guard, so no bytes ever leak.
app.get('/library/view/:id', async (c) => {
  // Reuse the shared guard, but for a PAGE we prefer a redirect over a JSON
  // envelope. Run the guard; if it denies, bounce to the library with a hint.
  let allowed = false
  await requireActiveSubscriber(c as any, async () => {
    allowed = true
  })
  if (!allowed) {
    return c.redirect('/library?locked=1')
  }

  const id = c.req.param('id')
  const meta = await getFileMeta(c.env, id)

  if (!meta) {
    return c.html(
      `<!DOCTYPE html><html lang="ar" dir="rtl" data-theme="light"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light dark" />
<meta name="theme-color" content="#FFFFFF" />
<title>Not found — تيسير</title>
<link rel="icon" type="image/svg+xml" href="/static/favicon.svg" />
${themeBoot}
<link href="/static/tokens.css" rel="stylesheet" />
<link href="/static/components.css" rel="stylesheet" />
${themeHead}
<style>${viewerBrandTheme}</style></head>
<body class="viewer-shell" dir="rtl">
${bgDecor}
<main class="container" style="padding-block: var(--space-9); max-width: var(--container-text); text-align: center; position: relative; z-index: 1;">
<!-- The "connection lost" illustration: inlined by illustrations.js so its
     fills follow the --illu-* tokens and re-tint on a theme switch. -->
<img src="/static/illustrations/connection-lost.svg" alt="" class="taysir-illu float-illu"
     style="width:min(70vw,320px);margin:0 auto 28px;" />
<p class="overline">In-app viewer</p><h1>الملف غير متاح</h1>
<p class="text-lede">هذا الملف غير متاح حاليًا، يرجى التواصل مع المشرف.</p>
<p><a href="/library" class="btn btn-primary">العودة إلى المكتبة</a></p>
</main>
<script src="/static/illustrations.js" defer></script>
</body></html>`,
      404
    )
  }

  const contentUrl = `/api/library/file/${encodeURIComponent(id)}/content`
  const title = esc(meta.name)
  const kind = meta.viewerKind
  const badge = esc(meta.fileType)

  // Choose the right embedded renderer for the resolved viewer kind. Everything
  // is served same-origin through the gated proxy — no Drive URLs, no download
  // buttons. Unsupported types get a graceful message (still no raw link).
  let viewerHtml = ''
  if (kind === 'pdf') {
    // Render in-page with PDF.js so the document stays INSIDE the site (iOS
    // Safari would otherwise hand an <object>/<iframe> PDF to the system app).
    // A plain <iframe> stays as the no-PDF.js fallback.
    viewerHtml = `<div class="viewer-pdf" id="viewer-pdf" data-src="${esc(contentUrl)}">
        <noscript><iframe class="viewer-frame" src="${esc(contentUrl)}" title="${title}"></iframe></noscript>
      </div>`
  } else if (kind === 'image') {
    viewerHtml = `<div class="viewer-media"><img class="viewer-img" src="${esc(contentUrl)}" alt="${title}" /></div>`
  } else if (kind === 'video') {
    viewerHtml = `<div class="viewer-media"><video class="viewer-video" controls controlslist="nodownload" src="${esc(contentUrl)}"></video></div>`
  } else if (kind === 'text') {
    viewerHtml = `<iframe class="viewer-frame" src="${esc(contentUrl)}" title="${title}"></iframe>`
  } else {
    viewerHtml = `<div class="viewer-media viewer-unsupported">
        <p class="text-lede">This file type can't be previewed inline, but it stays inside the site — no external links or downloads. Ask the founder for the best format on TikTok.</p>
      </div>`
  }

  const sampleNote = meta.sample
    ? `<p class="viewer-sample">Sample mode — placeholder content (no Drive secrets configured).</p>`
    : ''

  return c.html(`<!DOCTYPE html>
<html lang="ar" dir="rtl" data-theme="light">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <meta name="theme-color" content="#FFFFFF" />
  <title>${title} — تيسير</title>
  <link rel="icon" type="image/svg+xml" href="/static/favicon.svg" />
  ${themeBoot}
  <link href="/static/tokens.css" rel="stylesheet" />
  <link href="/static/components.css" rel="stylesheet" />
  ${themeHead}
  <style>
    ${viewerBrandTheme}
    .viewer-shell { min-height: 100vh; display: flex; flex-direction: column; background: var(--color-surface-2, #f2ede3); }
    .viewer-bar { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-5);
      border-bottom: 1px solid var(--color-border, #e2d9c8); background: var(--color-surface, #fff); position: sticky; top: 0; z-index: 5; }
    .viewer-bar .viewer-back { flex: 0 0 auto; }
    .viewer-title { font-family: 'Fraunces', Georgia, serif; font-size: 1.05rem; font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .viewer-meta { margin-left: auto; display: flex; align-items: center; gap: var(--space-2); }
    .viewer-body { flex: 1 1 auto; display: flex; padding: var(--space-4); }
    .viewer-frame { width: 100%; height: calc(100vh - 120px); min-height: 480px; border: 1px solid var(--color-border, #e2d9c8);
      border-radius: var(--radius-lg, 12px); background: #fff; }
    .viewer-pdf { width: 100%; display: flex; flex-direction: column; align-items: center; gap: 14px; }
    .viewer-pdf .pdf-page { max-width: 100%; line-height: 0; border-radius: 6px; overflow: hidden;
      background: #fff; box-shadow: 0 4px 18px rgba(0,0,0,.16); }
    .viewer-pdf .pdf-page canvas { display: block; max-width: 100%; height: auto; }
    .viewer-zoombar { display: inline-flex; align-items: center; gap: 4px; margin-left: var(--space-2);
      padding: 2px; border-radius: 999px; background: var(--color-surface-2, #f2ede3); }
    .viewer-zoombar button { width: 32px; height: 32px; border: 0; border-radius: 999px; background: transparent;
      cursor: pointer; font-size: 1.1rem; line-height: 1; color: inherit; }
    .viewer-zoombar button:hover { background: rgba(0,0,0,.06); }
    .viewer-zoomlvl { min-width: 3.4rem; text-align: center; font-size: .8rem; font-weight: 600; }
    .viewer-media { width: 100%; display: flex; justify-content: center; align-items: flex-start; }
    .viewer-img { max-width: 100%; height: auto; border-radius: var(--radius-lg, 12px); box-shadow: var(--elevation-2, 0 6px 24px rgba(0,0,0,.12)); }
    .viewer-video { max-width: 100%; border-radius: var(--radius-lg, 12px); background: #000; }
    .viewer-unsupported { padding: var(--space-8); text-align: center; }
    .viewer-sample { margin: 0 var(--space-5) var(--space-3); font-size: .82rem; color: var(--color-text-muted, #7A6A52); }
    .viewer-lock-note { font-size: .8rem; color: var(--color-text-muted, #7A6A52); }
  </style>
</head>
<body>
  <div class="viewer-shell">
    ${bgDecor}
    <header class="viewer-bar">
      <a href="/library" class="btn btn-ghost btn-sm viewer-back">&larr; Library</a>
      <span class="viewer-title" title="${title}">${title}</span>
      <span class="viewer-meta">
        ${themeToggle}
        ${
          kind === 'pdf'
            ? `<span class="viewer-zoombar" role="group" aria-label="التحكم في التكبير">
                 <button type="button" id="pdf-zoom-out" aria-label="تصغير">&minus;</button>
                 <span class="viewer-zoomlvl" id="pdf-zoom-lvl">ملائم</span>
                 <button type="button" id="pdf-zoom-in" aria-label="تكبير">+</button>
               </span>`
            : ''
        }
        <span class="badge badge-primary">${badge}</span>
        <span class="viewer-lock-note">Opened inside the site · subscriber access</span>
      </span>
    </header>
    ${sampleNote}
    <main class="viewer-body">
      ${viewerHtml}
    </main>
  </div>
  ${
    kind === 'pdf'
      ? `<script src="/static/vendor/pdfjs/3.11.174/pdf.min.js"></script>
  <script>
  (function () {
    var host = document.getElementById('viewer-pdf');
    if (!host || !window.pdfjsLib) { return; }
    var src = host.getAttribute('data-src');
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/vendor/pdfjs/3.11.174/pdf.worker.min.js';
    var doc = null, pages = [], fit = 1, factor = 1, isFit = true;
    function fitScale() {
      if (!pages.length || !pages[0].base) return 1;
      var avail = host.clientWidth - 8;
      var s = avail / pages[0].base.width;
      return (isFinite(s) && s > 0) ? s : 1;
    }
    function label() {
      var el = document.getElementById('pdf-zoom-lvl');
      if (el) el.textContent = isFit ? 'ملائم' : Math.round(factor * 100) + '%';
    }
    // Cap per-canvas backing-store area (~16.7M px) to bound memory on very
    // large pages, instead of a blanket dpr cap that would blur every page.
    var MAX_CANVAS_AREA = 16777216;
    function clampDprForArea(dpr, cssW, cssH) {
      if (!(dpr > 0)) dpr = 1;
      var area = cssW * cssH;
      if (area > 0 && area * dpr * dpr > MAX_CANVAS_AREA) dpr = Math.sqrt(MAX_CANVAS_AREA / area);
      return dpr < 1 ? 1 : dpr;
    }
    function renderAll() {
      fit = fitScale();
      var scale = fit * factor;
      // Use the FULL device pixel ratio so pages stay crisp on 3x screens.
      var baseDpr = window.devicePixelRatio || 1;
      pages.forEach(function (p) {
        if (!p.page) return;
        var vp = p.page.getViewport({ scale: scale });
        var dpr = clampDprForArea(baseDpr, vp.width, vp.height);
        var c = p.el.querySelector('canvas') || p.el.appendChild(document.createElement('canvas'));
        c.style.width = Math.floor(vp.width) + 'px';
        c.style.height = Math.floor(vp.height) + 'px';
        c.width = Math.floor(vp.width * dpr);
        c.height = Math.floor(vp.height * dpr);
        var t = p.page.render({ canvasContext: c.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr,0,0,dpr,0,0] : null });
        if (t && t.promise) t.promise.catch(function(){});
      });
      label();
    }
    pdfjsLib.getDocument({ url: src }).promise.then(function (d) {
      doc = d;
      var loaders = [];
      for (var i = 1; i <= d.numPages; i++) {
        (function (n) {
          var el = document.createElement('div');
          el.className = 'pdf-page';
          host.appendChild(el);
          var rec = { el: el, page: null, base: null };
          pages.push(rec);
          loaders.push(d.getPage(n).then(function (pg) { rec.page = pg; rec.base = pg.getViewport({ scale: 1 }); }));
        })(i);
      }
      return Promise.all(loaders);
    }).then(function () { renderAll(); }).catch(function () {
      host.innerHTML = '<iframe class="viewer-frame" src="' + src + '"></iframe>';
    });
    var zi = document.getElementById('pdf-zoom-in'), zo = document.getElementById('pdf-zoom-out');
    if (zi) zi.addEventListener('click', function () { if (isFit) { isFit = false; factor = 1; } factor = Math.min(4, +(factor + 0.25).toFixed(2)); renderAll(); });
    if (zo) zo.addEventListener('click', function () { if (isFit) { isFit = false; factor = 1; } factor = +(factor - 0.25).toFixed(2); if (factor <= 1) { isFit = true; factor = 1; } renderAll(); });
    var rt = null;
    window.addEventListener('resize', function () { if (!isFit) return; clearTimeout(rt); rt = setTimeout(renderAll, 150); });
  })();
  </script>`
      : ''
  }
  <!-- Cosmetic only: drives the theme toggle and recolours illustrations.
       Loaded last; it does not touch the PDF.js pipeline above. -->
  <script src="/static/illustrations.js" defer></script>
</body>
</html>`)
})

export default app
