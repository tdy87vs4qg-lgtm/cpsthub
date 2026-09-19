# تيسير (merged)

A single Cloudflare Pages project that combines two experiences:

- **Exterior (تيسير)** — a React + TypeScript + Tailwind + Framer Motion / GSAP,
  Arabic-RTL single-page app that is what visitors see **before** login: home,
  login, signup, and subscription. Its source lives in `frontend/`.
- **Internal drive (تيسير)** — the Hono, server-rendered,
  Google-Drive-style library, authentication, admin approval, and admin console,
  kept **exactly** as it was. Its source lives in `src/` + `public/static/`.

## Task 1 — Smart motion + Dark/Light mode (latest)

Adds an elegant, **mobile-light** motion layer and a full **dark/light theme**
to the exterior (marketing) experience, without touching auth/session logic,
admin approval/lock logic, the admin page, Drive integration/access logic, or
the internal library UI.

- **Smart motion** (all GPU-friendly — transform/opacity only, 200–400ms,
  scroll/mouse handlers rAF-throttled, `prefers-reduced-motion` fully honoured):
  - "Write-in" RTL typewriter reveal on main headings (single `clip-path`
    wipe driven by one rAF loop — no per-glyph DOM, no layout thrash).
  - Subtle scroll-reveal (fade + small slide) on sections via `Reveal`.
  - Refined hover/tap micro-interactions on buttons and cards.
- **Dark / Light mode**:
  - Beautiful animated **sun/moon switch** in the header (`ThemeToggle`) — the
    sliding knob + icon crossfade animate only transform/opacity.
  - Smooth theme crossfade between palettes (short `.4s` colour transitions).
  - Choice **persisted** in `localStorage` (`taysir-theme`) and pre-applied by
    an inline script in `index.html` (no flash of the wrong theme); falls back
    to the OS `prefers-color-scheme`.
  - Both palettes are premium and high-contrast for Arabic RTL. Light mode is
    layered as semantic CSS-token overrides under `html[data-theme="light"]`, so
    the original dark composition stays byte-identical.
  - New files: `frontend/src/components/ThemeProvider.tsx`,
    `frontend/src/components/ThemeToggle.tsx`. The auth cards keep their
    dark-glass identity and the internal library UI is untouched.

## Google Drive connection (out of the box)

The internal library is wired to **Google Drive** and works with no manual step:

- **`.env`** is the source of truth for local runtime values and holds
  `GOOGLE_API_KEY` + `DRIVE_FOLDER_ID`. These are read **server-side only**
  (`src/lib/drive.ts`) and are **never** sent to the browser.
- `scripts/sync-env.mjs` runs automatically before `dev` / `dev:sandbox` /
  `build` (via `predev` / `prebuild`) and projects the server-side keys from
  `.env` into **`.dev.vars`**, which `wrangler pages dev` and the
  `@hono/vite-dev-server` Cloudflare adapter load into the Worker `env`. The
  Vite dev server also reads the same values from `.env` directly
  (`vite.config.ts`).
- With both values present, the library switches from labelled **sample**
  content to the **real Drive folder**: it lists **all folders and files**,
  including **nested subfolders**, and lets users open folders, preview, and
  download. When the key/folder id are missing it falls back to sample mode.
- **Performance**: listings are cached (stale-while-revalidate, per-folder),
  folder contents are fetched **only when a folder is opened**, large folders
  paginate (`pageToken`), thumbnails lazy-load via `IntersectionObserver`, and
  folder/file metadata is prefetched on hover — so navigation and opening files
  feel instant, including on mobile. Auth, admin-approval, the admin page, and
  the design are unchanged.

## Architecture of the merge

The **Hono worker (`src/index.tsx`) is the single backbone**. Routing:

| Path | Served by | Notes |
| --- | --- | --- |
| `/`, `/login`, `/signup`, `/subscription` | تيسير React SPA shell | Client-routed by React Router; the worker returns the built SPA shell so deep links / refreshes work. |
| `/react/*` | static assets | The built SPA's hashed JS/CSS/fonts/images (excluded from the worker via `_routes.json`). |
| `/library`, `/library/view/:id` | Hono (original) | The internal Drive experience — unchanged. |
| `/admin`, `/api/admin/*` | Hono (original) | Admin console + account management — unchanged. |
| `/api/auth/*`, `/api/library/*` | Hono (original) | Auth + Drive proxy — unchanged. |
| `/styleguide` | Hono (original) | Design-system reference — unchanged. |
| `/static/*` | static assets | The internal experience's CSS/JS. |

### Auth wiring (exterior → login → internal drive)

The تيسير login/signup forms (`frontend/src/components/AuthShell.tsx`) POST to the
**existing** endpoints `POST /api/auth/login` and `POST /api/auth/signup`
(`credentials: 'same-origin'`, JSON `{ email, password }`). On success the server
sets the persistent session cookie and the browser hard-navigates to `/library`
(or `/admin` for admins), handing control to the original internal experience —
i.e. **exterior (تيسير) → login → internal drive.**

### Build pipeline

`npm run build` runs, in order:

1. `build:frontend` — installs + builds the React app in `frontend/` into
   `public/react/` (Vite `base: '/react/'`, `outDir: ../public/react`).
2. `build:shell` — `scripts/generate-spa-shell.mjs` snapshots the freshly built
   `public/react/index.html` (with its hashed asset URLs) into
   `src/generated/spa-shell.ts`, which the worker imports and returns for the
   public routes (Workers cannot read files at runtime).
3. `build:server` — bundles the Hono worker to `dist/` and copies `public/` into
   it; `@hono/vite-build` emits `dist/_routes.json` excluding `/react/*` and
   `/static/*` from the worker.

Local dev (sandbox): `npm run build` then `pm2 start ecosystem.config.cjs`
(serves `dist` on port 3000).

---

## تيسير (internal library — original, unchanged below)

The complete Baccalaureate study library — a production-grade educational web platform
built with Hono on Cloudflare Pages.

## Project Overview
- **Name**: تيسير
- **Goal**: One complete, hand-picked library so students stop wasting time and money
  hunting scattered, incomplete resources.
- **Brand**: Refined, editorial, trustworthy academic — never generic AI aesthetics.

## Account System — Signup Fix + Lock-Until-Approved (latest)

**Signup is fixed.** Anyone can now create an account (email + password) and it works
end to end: the account is saved to D1, they are auto-logged-in, and they can log in again
normally later.

- **Root cause of the previous breakage**: `createAccount()` wrapped its `INSERT` in a
  `catch` that mapped **every** SQL error to `EMAIL_TAKEN`. In a deployed environment whose
  migrations were not fully applied (the `0002_approval` migration adding the `approved`
  column had never run), the insert threw *"table users has no column named approved"* — and
  that real error was disguised as "email already in use", so **every** signup appeared to
  fail. Two fixes were made:
  1. **Self-healing schema** — `ensureSchema()` (in `src/lib/users.ts`) idempotently creates
     the `users`/`sessions` tables and adds the `approved` column (grandfathering existing
     rows) at runtime before the first write. Signup/login now work regardless of migration
     state. It is memoised per isolate, so it is a cheap no-op once the schema is correct.
  2. **Honest error handling** — the `INSERT` catch now returns `EMAIL_TAKEN` **only** for a
     genuine UNIQUE/primary-key violation; any other DB failure surfaces as a distinct
     `DB_ERROR` (503) instead of a misleading duplicate-email message.

- **Accounts stay permanently active** — a created account is never auto-deactivated or
  expiring. The session cookie is httpOnly, `SameSite=Lax`, ~1-year expiry, and is silently
  renewed on use, so login persists across refresh and full browser restart. (Only an admin
  can `deactivate` an account.)

- **Lock-until-approved (intended, not a bug)** — every new self-signup starts with
  `approved = 0`. Such a user can log in and **browse everything**, but **all files stay
  locked**: clicking a file shows the contact popup (TikTok
  `https://www.tiktok.com/@abderahmane.lovenature`). Only the admin can flip approval from the
  dashboard (`/admin`): **Approve** unlocks every file instantly (no re-login), **Un-approve**
  re-locks instantly. Admins are always entitled regardless of the flag.

**Verified end to end**: new user signs up successfully → logs in → account stays active →
files stay locked (contact popup) → admin approves in the dashboard → files open → admin
un-approves → files re-lock. All confirmed against a fresh DB, a migrated DB, and a
partially-migrated DB (missing the `approved` column) which self-heals.

## Library — Google Drive–style Redesign (latest)
The internal browsing UI at `/library` was rebuilt to **look and behave exactly like
Google Drive**, while keeping the entire server side (listing, gating, viewer) unchanged.

- **Drive layout**: fixed **top app bar** (brand + full-width pill search + account glyph),
  a **left navigation rail** ("My Library" + one entry per top-level subject), and a rounded
  **main panel** with a large breadcrumb and a **list / grid** view toggle. Colours, spacing,
  type, icons, hover states and the scrollbar are tuned to match Drive (`#1a73e8` accent,
  Roboto/Public-Sans, filled folder + coloured file glyphs).
- **List view (default)** — Drive-style rows with a sticky `Name · Type · Modified` header,
  per-type coloured file icons, and an open/lock affordance on the right.
- **Grid view** — Drive-style cards: a compact header (icon + name + lock) over a **150 px
  thumbnail preview** area; folders render as slim chips. Files are grouped under **Folders**
  and **Files** section labels, exactly like Drive.
- **Correct icons per type**: filled grey-blue **folder**; red **PDF/exam/lesson/…**; blue
  **Docs**, green **Sheets**, yellow **Slides**, green **image**, red **video** glyphs.
- **Navigation**: click a folder to open it (nested folders fully supported); working
  **breadcrumb** (each hop clickable) + sidebar; History-API deep links (`?folder=<id>`),
  back/forward, prefetch-on-hover; a **mobile drawer** sidebar with scrim.
- **Lock preserved**: files still carry the server-decided `locked` flag. Approved
  users/admins open files in the in-app viewer (`/library/view/:id`); locked users get the
  Google-Drive-flavoured **contact popup** (→ TikTok). Access is re-decided server-side on
  every request — a forged flag still gets nothing.
- **Fast & light**: lazy-loaded thumbnails (shared `IntersectionObserver`, 400 px pre-margin,
  fade-in over an icon fallback), **skeleton loaders**, and **list/grid virtualization** so the
  480-file *Full Papers Archive* (400+ files) scrolls smoothly with a tiny DOM. Fully
  **responsive** (great on phone: drawer sidebar, condensed columns).
- **Data source unchanged**: everything comes from the existing server-side Google Drive
  endpoints (`/api/library/*`). The Google API key stays strictly server-side.
- **Files**: `src/pages/library.ts`, `public/static/library.css`, `public/static/library.js`
  (self-contained; the rest of the app — auth, admin, viewer, Drive service — is untouched).

## Drive Performance — Instant Navigation (latest)
When the Google Drive API key + folder id are configured, opening a file, switching
between files, and moving in/out of folders are now **fast and light — especially on
mobile**. Auth/session, admin-approval/lock logic, the admin page, and the design are
all **unchanged**.

- **SPA in-app viewer** (`public/static/library.js` + `.gd-viewer-*` overlay): files open,
  switch, and close in an **overlay without a full page reload**, so the folder listing
  (and its client cache) stays mounted underneath — no CSS/font re-download, no re-fetch.
  Uses the History API (Back/Escape/close all work) and keeps a working `?view=<id>`
  deep link. The standalone `/library/view/:id` page remains a no-JS fallback.
- **Large in-page PDF viewer with zoom** (`public/static/library.js`): PDFs render **in-page
  via PDF.js** onto page canvases inside the full-screen overlay, instead of an
  `<object>`/`<iframe>`. This keeps the document **inside the site's own viewer on
  iPhone/Safari** (no hand-off to the system PDF app), fills the full screen width, and
  defaults to **fit-to-width**. A lightweight zoom cluster in the viewer bar (تصغير / تكبير /
  ملاءمة العرض, plus `+` `-` `0` keys) re-renders pages crisply at any scale; images are
  zoom/pan-able too. Fully responsive & Arabic-RTL. PDF.js is loaded lazily only when a PDF
  is opened, and the viewer degrades gracefully to an inline `<iframe>` if the CDN is blocked.
  The `/library/view/:id` fallback page uses the same PDF.js in-page rendering.
- **Client meta cache + hover/idle prefetch**: a file's tiny viewer metadata is cached
  and prefetched on hover and (idle) for the first visible files, so tapping opens instantly;
  content bytes then stream in. Requests are **deduplicated**.
- **Server metadata cache + request dedup** (`src/lib/drive.ts`): folder name/parent are
  remembered per isolate, so **breadcrumbs build from memory** (warm nav ≈ **zero** extra
  Drive calls) instead of a serial `driveGetMeta` per ancestor. Concurrent identical lookups
  collapse into one fetch, a redundant target-folder metadata call was removed, and
  `getFileMeta` is cached. Existing stale-while-revalidate listing cache (KV/in-memory) is kept.
- **Tuned caching headers**: `/file/:id/meta` is now `private, max-age=300, SWR` so re-opening
  a file needs no round trip.

## Persistent File & Listing Cache — Instant Reopen (latest)
Opened files and folder listings are now cached **persistently in IndexedDB**
(`public/static/file-cache.js`, wired into `public/static/library.js`), so reopening a file
or re-entering a folder is **instant even after the browser is fully closed and reopened**.

- **Files stay inside the site's storage only.** Cached bytes live in the origin's IndexedDB
  and are rendered from an **in-memory Blob URL** (`URL.createObjectURL`). Nothing is ever
  written to the phone's **Downloads** folder or saved as a visible file. Blob URLs are
  revoked when the viewer closes or switches files.
- **File-link security is preserved.** The **first** open of any file (and every folder
  listing) still goes **through the Worker**, where the existing server-side
  auth / subscription / device gate runs. Only bytes the server *agreed* to serve are cached.
  A gate refusal (401/402/403) is surfaced (subscribe modal) and never cached.
- **Tied to a STABLE identity (`user.id` only).** Every cache entry is stamped with a
  `sessionKey` derived from the gated `/api/auth/me` snapshot using **`user.id` alone** —
  the volatile `role` / `approved` fields are deliberately **excluded** so a routine approval
  or role change between sessions can no longer invalidate a valid user's own cache and force a
  re-download. The cache is wiped only when a **genuinely different `user.id`** binds, on
  **logout**, or on a hard auth failure (401/403) during a content fetch. Entries whose
  `sessionKey` doesn't match the live user are ignored and purged, so a stale cache can never
  serve a different/invalid user.
- **Durable writes across sessions.** On first open the full file bytes are written to
  IndexedDB, and the write is tracked as a *pending write* that only settles once its
  transaction has **committed**. `FileCache.flush()` is wired to `pagehide` /
  `visibilitychange` / `beforeunload`, so closing or backgrounding the browser right after
  opening a file (very common on iPhone) can no longer strand a half-written entry — the file
  is guaranteed persisted and **opens instantly on every later session**.
- **Cache-first reads with a safety fallback.** Later opens read the blob from IndexedDB
  **first** and render instantly; the Worker is only hit on a genuine cache miss. A stored blob
  that is empty / unreadable is treated as a miss (dropped, then re-fetched through the gated
  Worker) so a bad entry can never produce a **blank/broken second-open** page.
- **Storage stays bounded.** LRU-ish eviction by count + total bytes for files (`~60` files /
  `~120 MB`) and by count for listings, so device storage never fills up. Cached listings paint
  navigation instantly on a cold start and are revalidated through the Worker in the background.
- **Graceful degradation.** If IndexedDB is unavailable the viewer falls back to streaming from
  the gated content URL — identical to the previous behaviour.

## Home Page — Arabic RTL Premium Redesign
The public landing page (`/`) was redesigned as a fully Arabic, right-to-left (RTL)
premium experience:
- **First view = credibility**: the four founders and their Baccalaureate averages lead
  the page — عبد الرؤوف سالمي 17.42 · ليتيسيا يحياوي 18.32 · عبد الله إسحاق 18.92 · إيناس بن أمغار 18.75.
- **Platform section**: confident Arabic copy describing the complete curated library
  (lessons, summaries, exercise series with full solutions, exams and mock/bac papers with
  corrections — 400+ files) that saves students time and money.
- **Clear actions everywhere**: `تسجيل الدخول` (Login) opens a modal that posts to the
  existing `POST /api/auth/login`; `إنشاء حساب` (Sign up) opens a modal that routes to the
  founder on TikTok, matching the admin-provisioned account model.
- **Design**: clean modern Arabic type (Tajawal + IBM Plex Sans Arabic), a calm mature
  palette (deep petrol `#12312E` on warm off-white `#F6F4EE`), strong grid, generous
  whitespace, subtle scroll-reveal motion. No cheesy gradients, glassmorphism, or emoji.
- **Files**: `src/pages/home.ts`, `public/static/home.css`, `public/static/home.js`
  (self-contained; the rest of the app is unchanged).

## Progress

| Task | Deliverable | Status |
|------|-------------|--------|
| 1 | Design system (tokens, components, style guide) | ✅ Done |
| 2 | Landing / home page | ✅ Done |
| 3 | Library browser with Google Drive integration | ✅ Done |
| 4A | Auth foundation: data model, login, persistent session | ✅ Done |
| 4B | Roles + admin-only account creation + route-protection middleware | ✅ Done |
| 4C | File-access gating (server-proxied viewer + subscription-modal hook) | ✅ Done |
| 5 | Library + Google Drive (server-side listing, KV cache, full library UX) | ✅ Done |
| 8 | Global search across file + folder names (locked items still gated) | ✅ Done |
| 9 (1/3) | Admin dashboard page (server-side protected) + subscriber stats overview | ✅ Done |
| 9 (2/3) | Admin account list + **create & edit** subscriber forms (UI + wiring) | ✅ Done |
| 9 (3/3) | Admin **deactivate / reactivate** + **reset device** controls (UI + wiring) | ✅ Done |
| 11 | **Deploy prep** — Cloudflare Pages/Workers + D1/KV, env-driven admin bootstrap, secrets | ✅ Done |

### Task 11 — Deploy prep (this task)
Makes the app **deploy-ready for Cloudflare** (Pages + Workers Functions + D1 + KV) with every
credential read from the environment and the Google API key kept strictly server-side.

- **Secrets from env** — `GOOGLE_API_KEY`, `DRIVE_ROOT_FOLDER_ID`, `SESSION_SECRET`,
  `ADMIN_SEED_EMAIL`, `ADMIN_SEED_PASSWORD`. `DRIVE_ROOT_FOLDER_ID` ships as a non-secret
  `vars` entry (`1hZNdWjagdi7Zo3TNaWHk4S2Ztae3q7Pv`); the other four are Cloudflare Pages
  secrets. Nothing is hardcoded and the API key never reaches the browser.
- **Env-driven admin bootstrap** — new `seedAdminFromEnv()` in `src/lib/users.ts`, hooked into
  `POST /api/auth/login`. On the first login with `ADMIN_SEED_EMAIL` it idempotently provisions
  (or repairs) the single seed **admin** in D1, so production never relies on the dev `seed.sql`
  rows. Idempotent, race-safe (`UNIQUE(email_lower)`), and a no-op once the admin already matches.
- **Tooling** — added `typescript` + `@cloudflare/workers-types` devDependencies, a `typecheck`
  (`tsc --noEmit`, now passing cleanly) and a `deploy:prod` script; refreshed
  `.env.example` / `.dev.vars.example` / `wrangler.jsonc` docs.

### Task 9 (Step 3/3) — Deactivate, reactivate & reset device
Completes the admin console with the **account lifecycle controls**, layered onto the account
list from Step 2. All three run through a single shared **confirmation dialog** and call the
admin-only, server-guarded endpoints.

- **Deactivate** (per active row, red button → `POST /api/admin/accounts/:id/deactivate`):
  suspends the account **and instantly revokes every live session** (D1 + KV), so the user is
  locked out on their very next request. Hidden on the admin's own row — the server also
  enforces `CANNOT_SUSPEND_SELF`.
- **Reactivate** (per suspended row, green button → `POST /api/admin/accounts/:id/reactivate`):
  re-enables login. Old sessions stay revoked; the user simply signs in again.
- **Reset device** (per row → `POST /api/admin/accounts/:id/reset-device`, **new this step**):
  destroys **all** of the account's live sessions via `revokeAllUserSessions` **without**
  changing its status — the account stays `active` and the person can sign in again on a fresh
  device. This is the "I switched phones/laptops" support action. Hidden on the admin's own row.
- **Everything privileged stays on the server.** The buttons only carry the admin's intent over
  the opaque httpOnly cookie; every action is re-authorised (`requireRole('admin')`), the
  self-guards are re-checked, and session revocation happens server-side.
- **Files touched**: `src/lib/users.ts` (new `resetUserDevice`), `src/routes/admin.ts` (new
  `POST …/reset-device` route), `src/pages/admin.ts` (row buttons + confirmation modal),
  `public/static/admin.js` (row-action delegation + confirm flow). Stat cards are recomputed
  from the fresh list after each action so they never go stale.

### Task 9 (Step 2/3) — Create & edit account logic
Grows the admin console into a working **account-management UI** on top of the
already-protected `/admin` page. This step adds **strictly** the create + edit paths — no
deactivate/reactivate controls yet (those are Step 3).

- **Account list** — a table on `/admin` populated client-side from the admin-only
  `GET /api/admin/accounts` (same-origin, cookie-authenticated). Each row shows email, role,
  status and created date; the signed-in admin's own row is labelled **"You"**.
- **Create form** ("New subscriber" → modal): posts to `POST /api/admin/accounts`, creating a
  brand-new **subscriber** (role selectable subscriber/admin). There is still **no public
  self-signup** — this admin form is the only path to a new account.
- **Edit form** (per-row "Edit" → modal): sends only the **changed** fields to
  `PATCH /api/admin/accounts/:id` (email / password / role). Leaving the password blank keeps
  it unchanged; changing it revokes that user's sessions server-side.
- **Everything privileged stays on the server.** The forms only carry the admin's intent over
  the opaque httpOnly session cookie; validation, email-uniqueness, PBKDF2 hashing, the
  self-demotion guard (`CANNOT_DEMOTE_SELF`) and session revocation are all re-decided
  server-side by the pre-existing Task 4B endpoints (`src/routes/admin.ts` + `src/lib/users.ts`).
  The client-side self-demotion lock is only a courtesy; the server enforces it regardless.
- **Files touched**: `src/pages/admin.ts` (list + two modal forms), `public/static/admin.js`
  (fetch/render/submit logic), `src/index.tsx` (passes the admin's id to the page). The stats
  cards are recomputed from the fresh list after each create/edit so they never go stale.

### Task 9 (Step 1/3) — Admin dashboard page + stats overview
Introduces the **admin-only console page** at `GET /admin` (`src/pages/admin.ts`), the UI
that later steps of Task 9 will grow into a full management console. This step ships **only**
a read-only **stats overview** — no buttons, no forms, no mutating controls yet.

- **Server-side protection**: the `/admin` route (in `src/index.tsx`) resolves the session on
  the server via `getSessionUser` and requires a **live, active `admin` account** *before any
  dashboard markup is produced*. Being a page (not a JSON API), unauthorized visitors are
  **redirected** rather than shown a JSON error: not-signed-in / suspended → `/?login=1`;
  a signed-in **subscriber** → `/library`. The client is never trusted.
- **Stats overview**: two cards — **Total subscribers** and **Active subscribers** — computed
  entirely server-side by `getSubscriberStats()` (`src/lib/users.ts`) with a single aggregate
  D1 query (`role = 'subscriber'`; active = `status = 'active'`). Admins are excluded from the
  counts. Only the final numbers reach the browser. Styled with the existing design system
  (tokens.css + components.css).

### Task 8 — Global library search
Adds a **search bar** in the library toolbar that searches **file *and* folder names
across the whole library** (not just the current folder) and shows results grouped into
**Folders** and **Files**, each labelled with the folder path where it was found.

- **Server-side** endpoint `GET /api/library/search?q=<query>` (in `src/routes/library.ts`,
  backed by `searchLibrary()` in `src/lib/drive.ts`). It works in **sample mode** (walks the
  in-memory tree, including the 480-file archive) and in **live Drive mode** (a single
  `name contains` Drive query, scoped to the configured root, then a precise substring match).
  The Google API key never leaves the server.
- **Locked items still show a lock and open the Subscribe modal**: each file result carries
  the same per-request `locked` flag as `/list`, so non-subscribers see the lock badge and
  clicking opens the shared subscribe modal — access remains enforced server-side.
- **Fast**: debounced (150 ms) input, client-side result cache, out-of-order-response guard,
  and a 60-result cap (`truncated` flag) so huge queries stay snappy. Clicking a folder
  result navigates into it; clearing the search (× button, Clear, or Esc) restores browsing.

## Currently Completed Features

### Task 5 — Library + Google Drive (this task)
Task 5 consolidates and hardens the whole library-over-Drive stack so it meets its
brief end-to-end. Everything is server-side and secret-safe.

1. **Server-side Drive listing endpoint** (`src/lib/drive.ts` + `src/routes/library.ts`):
   `GET /api/library/list?folder=<id>` runs entirely inside the Cloudflare Worker.
   It lists folders + files starting from `DRIVE_ROOT_FOLDER_ID` using `GOOGLE_API_KEY`,
   both read **only** from env bindings — the key is **never** serialised to the client.
   **Nested folders** are fully supported (any folder id can be listed; the breadcrumb is
   rebuilt by walking `parents` up to the root). The browser only ever receives normalised,
   safe `DriveNode` objects — **no raw Drive download URLs, no `webContentLink`, no API key**.
   File bytes and thumbnails are exposed only through the same-origin, gated proxies
   (`/api/library/file/:id/content`, `/api/library/thumb/:id`).
2. **KV-cached Drive listings (short TTL)** — the `DRIVE_CACHE` KV namespace caches each
   folder listing keyed by folder id with a **stale-while-revalidate** policy: **fresh for
   5 min**, **served-stale up to 1 h** while a background `waitUntil` refresh runs. This
   keeps navigation instant and spares the Drive API quota. When the binding is absent it
   degrades gracefully to a per-isolate in-memory cache. `DRIVE_CACHE` is now a first-class
   binding in `wrangler.jsonc`.
3. **Library page** (`/library`): **breadcrumb + folder navigation** (History-API deep
   links via `?folder=<id>`, back/forward, breadcrumb hops, a subjects sidebar), **file
   cards / rows** each showing **title**, a **content-type badge** (Lesson / Summary /
   Exercises / Exam / Mock exam / Book / …) and a **thumbnail**. **Guests / non-subscribers
   see a lock icon**; clicking a locked file opens the **subscription modal** (→ TikTok);
   **subscribers** are taken to the in-app **viewer** (Task 7). A **grid / list toggle**
   (persisted in `localStorage`) switches layouts.
4. **Performance**: **lazy-loaded thumbnails** via a shared `IntersectionObserver`
   (250 px pre-margin, fade-in over an icon fallback so there's never an empty box),
   **skeleton loaders** while a folder loads, and **list virtualization** — folders with
   120+ items are windowed (only cards/rows near the viewport are in the DOM, with
   top/bottom spacers preserving scroll height), so the **480-file _Full Papers Archive_**
   (400+ files) stays smooth with a tiny DOM.
5. **No hardcoded secrets** — `GOOGLE_API_KEY` + `DRIVE_ROOT_FOLDER_ID` live only in env /
   Cloudflare secrets. Without them the library renders clearly-labelled **sample** content
   (incl. the 480-file archive) so the whole UI + subscriber path is exercisable in dev.

### Foundation (Tasks 1–4C)
- **Design system** (`/styleguide`): full token set (color, type, spacing, radii,
  elevation, motion) + component library (buttons, inputs, cards, badges, lock states,
  tooltips, modals, skeletons).
- **Landing page** (`/`): hero + product mockup, value props, "what's inside", founders,
  how-it-works, CTA band, footer, and the shared Subscribe modal (→ TikTok).
- **Library browser** (`/library`) — **Task 3**:
  - Dynamic listing of a Google Drive folder tree, fetched from a **server-side** API
    that proxies the Google Drive API. The API key + root folder id are read from
    environment bindings and are **never** sent to the browser.
  - Premium e-library UI: subject **sidebar**, **breadcrumb** navigation
    (subjects → chapters → files), a toolbar with **search** + **grid/list** view toggle.
  - **Nested folders** with History-API navigation (back/forward + deep links via
    `?folder=<id>`), breadcrumb back, and prefetch-on-hover for instant drill-down.
  - **File cards / rows** with title, type icon, and a **content type badge**
    (Lesson / Summary / Exercises / Exam / Mock exam / Book / …).
  - Every file shows a **lock icon** for non-subscribers; subscribers see files unlocked.
    Clicking a locked file opens the Subscribe modal (→ TikTok). Access is decided on
    the **server**, so the client can't forge it.
  - **Skeleton loaders**, lazy rendering, per-folder client cache mirroring the server's
    stale-while-revalidate cache, and an in-folder search that filters instantly.
  - **Lazy-loaded thumbnails**: unlocked files show a real preview streamed through a
    **server-side proxy** (`/api/library/thumb/:id`) — the Drive `thumbnailLink` and API
    key are resolved and fetched on the server, never exposed to the browser. Images load
    on demand via an `IntersectionObserver` (250px pre-margin) and fade in over an icon
    fallback, so there is never an empty box. Thumbnails are subscriber-gated (they are
    content) and edge-cached.
  - **List virtualization** for large folders: folders with 120+ items are windowed —
    only the cards/rows near the viewport are in the DOM, with top/bottom spacers
    preserving scroll height. A 480-file *Full Papers Archive* ships in sample mode to
    prove the 400+ path scrolls smoothly with a tiny DOM.
  - **Sample-data fallback**: when Drive secrets aren't configured, a clearly-labelled
    sample tree renders (incl. the 480-file archive + SVG placeholder previews) so the UI
    is fully browsable in dev.
- **File-access gating + server-proxied viewer** — **Task 4C**:
  - **Everyone browses, only subscribers open.** Guests and non-subscribers see every
    title + thumbnail via `/api/library/list`, but each file carries a server-decided
    `locked` flag; the file **content** itself is a separate, gated resource.
  - **`requireActiveSubscriber` on all content endpoints** (`src/routes/library.ts`): both
    `GET /api/library/file/:id/meta` and `GET /api/library/file/:id/content` sit behind the
    Task 4B guard. A guest / non-subscriber / revoked session is blocked **server-side** —
    **no bytes are ever emitted** on the deny path. The client is never trusted: a forged
    `locked:false` still gets nothing, because access is re-decided from the validated
    session on every request.
  - **Clean "subscription required" response**: locked content returns a dedicated
    `402 { ok:false, error:'SUBSCRIPTION_REQUIRED', message, locked:true }` envelope the UI
    keys off to open the Subscribe modal (Task 5). Suspended accounts keep their own
    `ACCOUNT_SUSPENDED` signal.
  - **Per-item locked/unlocked flag** flows through the listing so the UI shows a **lock**
    on locked files and an **open** affordance on unlocked ones.
  - **Server-proxied in-app viewer** (`/library/view/:id`): gated by `requireActiveSubscriber`
    (non-subscribers are redirected to `/library?locked=1`, which auto-opens the Subscribe
    modal). Files are **streamed through the Worker** (`getFileContent` in `src/lib/drive.ts`)
    — the browser never sees a raw Drive URL or the API key, and there are **no downloads**
    (rendered inline: PDF/native-docs → embedded PDF, images/video inline, text inline).
    Google-native docs (Docs/Sheets/Slides) are **exported to PDF** server-side for viewing.
  - **Sample-mode parity**: when Drive secrets aren't configured, the viewer + content
    endpoints serve labelled placeholder bytes (branded SVG for images, a text document
    otherwise) so the whole subscriber path is exercisable in dev.
  - **No hardcoded secrets** anywhere — the Drive API key + folder id are read from env only.
- **Auth foundation** (`/api/auth/*`) — **Task 4A**:
  - **Login** (`POST /api/auth/login`): verifies email + password against **D1**,
    passwords hashed with **PBKDF2** (SHA-256, 210k iterations, per-user salt) via the
    Workers-native Web Crypto API — no third-party deps. **No public self-signup**;
    accounts are admin-provisioned (dashboard lands in Task 4B).
  - **Persistent session** (~1 year): a `bac_session` **httpOnly / SameSite=Lax /
    Secure-in-prod** cookie that survives refresh, tab close and full browser restart,
    with **silent server-side renewal** (sliding window) on every use — never an
    inactivity/idle logout.
  - **Server-side validation helper** (`getSessionUser` / `isSubscriber` in
    `src/lib/auth.ts`): reads the cookie, validates the session against **KV** (hot path)
    backed by **D1** (source of truth), and returns the user. This is the seam Task 3's
    library gating and all later parts reuse.
  - **Logout** (`POST /api/auth/logout`): invalidates the session **server-side**
    (deletes it from KV + D1) then clears the cookie — a stolen/old cookie is dead
    immediately, not merely unset in the browser.
  - **Session snapshot** (`GET /api/auth/me`): safe booleans + `{ id, email, role }`; also
    silently renews the session.
  - **Security**: only a keyed **HMAC digest** of the session token is stored at rest
    (raw token lives only in the cookie); uniform failure responses (no user
    enumeration); constant-time password compare; KV-backed **rate limiting** on login;
    input validation; CORS locked to `SITE_ORIGIN`. `SESSION_SECRET` is read from env
    only — never hardcoded.
  - **Scope note**: Part A is the auth **foundation**. Part B (below) is now done. **Part C**
    (file-access gating + subscription-modal hook) is **still pending**.
- **Roles, admin-only account management + route protection** — **Task 4B**:
  - **Two roles fully wired**: `subscriber` (will view files) and `admin`. The role lives on
    `users.role` and flows through the session snapshot (`SessionUser.role`) so every guard
    and endpoint reads it server-side.
  - **Admin-only account creation / edit / (de)activation** (`/api/admin/*`,
    `src/routes/admin.ts` + `src/lib/users.ts`): only an authenticated **admin** can create,
    edit, deactivate and reactivate accounts. **Still NO public self-signup anywhere** — the
    only path to a new account is an admin calling `POST /api/admin/accounts`. (The admin
    **UI** arrives in Task 9; this task ships the protected endpoints + logic.)
  - **Route-protection middleware** (`src/lib/guards.ts`), built directly on Part A's
    session-validation helper:
    - `requireAuth` — 401 unless a valid, live session exists.
    - `requireRole('admin')` — 401 unauthenticated / 403 wrong role.
    - `requireActiveSubscriber` — a live session on an **active** account entitled to the
      library (subscriber or admin).
    All checks are **server-side**; the client is never trusted beyond the opaque httpOnly
    cookie. Errors are clear JSON envelopes (`{ ok:false, error, message }`).
  - **Instant deactivation** (`deactivateUser` → `revokeAllUserSessions`): suspending an
    account flips `status → suspended` **and** deletes every one of that user's sessions
    from **both D1 and KV**, so a deactivated account is rejected by the middleware on its
    very next request — the KV hot-cache snapshot can't keep it alive. Password change /
    admin-demotion also revoke sessions. Editing status via deactivate/reactivate keeps
    session revocation impossible to forget.
  - **Self-lockout guards**: an admin cannot demote or deactivate **their own** account.
  - **Security**: passwords always PBKDF2-hashed before hitting D1; email uniqueness
    enforced (checked + DB `UNIQUE` backstop); role/password/email validated server-side;
    CORS locked to `SITE_ORIGIN`. No secrets hardcoded.

## Functional Entry URIs
| Path | Method | Params | Description |
|------|--------|--------|-------------|
| `/` | GET | — | Public landing page |
| `/styleguide` | GET | — | Living design-system reference |
| `/library` | GET | `?folder=<driveFolderId>` (optional) | E-library browser (deep-linkable) |
| `/library/view/:id` | GET | `id` = Drive file id | **Subscriber-gated** server-proxied in-app viewer (streams bytes, no downloads, no raw Drive links). Non-subscribers → `redirect /library?locked=1` |
| `/admin` | GET | — | **Admin-only page (Task 9).** Server-side protected dashboard: subscriber **stats overview** (total + active) **plus the full account-management UI** — account list + **New subscriber** (create) + per-row **Edit** forms **(Step 2)** and per-row **Deactivate / Reactivate** + **Reset device** controls **(Step 3)**, all wired to `/api/admin/accounts*`. Not signed in / suspended → `redirect /?login=1`; subscriber → `redirect /library`. |
| `/api/library/list` | GET | `?folder=<driveFolderId>` (optional) | **Server-side** Drive listing → `{ folder, breadcrumb, folders[], files[], subscriber, sample }` (files carry `hasThumb`) |
| `/api/library/thumb/:id` | GET | `id` = Drive file id | **Server-proxied** thumbnail (subscriber-gated); resolves Drive `thumbnailLink` + streams image bytes. Sample mode returns a branded SVG placeholder. Edge-cached. |
| `/api/library/config` | GET | — | Bootstrap: `{ subscriber, driveConfigured }` (booleans only) |
| `/api/library/file/:id/meta` | GET | `id` = Drive file id | **Subscriber-gated (4C).** Safe file metadata `{ ok, file:{ name, mimeType, fileType, viewerKind, sample } }`. Locked → `402 SUBSCRIPTION_REQUIRED`. |
| `/api/library/file/:id/content` | GET | `id` = Drive file id | **Subscriber-gated (4C).** Streams file bytes **through the Worker** (inline, no download, no raw Drive URL / API key). Locked → `402 SUBSCRIPTION_REQUIRED` (no bytes). |
| `/api/auth/login` | POST | JSON `{ email, password }` | Verify credentials → sets persistent `bac_session` cookie; `{ ok, user:{ id, email, role } }`. Rate-limited. **No signup.** |
| `/api/auth/logout` | POST | — | Invalidates the session **server-side** (KV + D1) and clears the cookie |
| `/api/auth/me` | GET | — | Current session: `{ authenticated, user?:{ id, email, role } }` (also silently renews) |
| `/api/admin/accounts` | GET | — | **Admin only.** List all accounts `{ ok, accounts[] }` |
| `/api/admin/accounts` | POST | JSON `{ email, password, role?, status? }` | **Admin only.** Create an account (subscriber by default) → `201 { ok, account }`. No self-signup. |
| `/api/admin/accounts/:id` | GET | `id` = account id | **Admin only.** Fetch one account |
| `/api/admin/accounts/:id` | PATCH | JSON `{ email?, password?, role? }` | **Admin only.** Edit account (revokes sessions on password/role change) |
| `/api/admin/accounts/:id/deactivate` | POST | `id` | **Admin only.** Suspend + **instantly revoke all sessions** |
| `/api/admin/accounts/:id/reactivate` | POST | `id` | **Admin only.** Re-enable login |
| `/api/admin/accounts/:id/reset-device` | POST | `id` | **Admin only.** Revoke **all** the account's sessions **without** suspending it (device reset) → `{ ok, account }` |
| `/static/*` | GET | — | Static assets (css, js, favicon) |

All `/api/admin/*` endpoints sit behind `requireRole('admin')` — server-side, on every
request. Error envelope: `{ ok:false, error, message }` with codes like `UNAUTHENTICATED`
(401), `FORBIDDEN` / `ACCOUNT_SUSPENDED` / `CANNOT_DEMOTE_SELF` / `CANNOT_SUSPEND_SELF`
(403), `NOT_FOUND` (404), `EMAIL_TAKEN` (409), `INVALID_EMAIL` / `WEAK_PASSWORD` /
`INVALID_ROLE` (400).

## Data Architecture
- **File source**: Google Drive, listed via the Drive API **server-side only**
  (`src/lib/drive.ts`). Folders + files are normalised into safe `DriveNode` objects.
- **Access control**: `src/lib/auth.ts` validates the `bac_session` cookie **server-side**
  against a real session store and returns the account (`getSessionUser` / `isSubscriber`).
  Files stay `locked` for everyone except an active, authenticated subscriber.
- **Accounts + sessions (Task 4A)**:
  - **D1** (`DB` binding) is the source of truth — see `migrations/0001_auth.sql`:
    - `users(id, email, email_lower, password_hash, role, status, created_at)` — PBKDF2
      password hashes; `role ∈ {subscriber, admin}`; `status ∈ {active, suspended}`.
    - `sessions(token, user_id, created_at, expires_at)` — `token` is the **HMAC digest**
      of the raw cookie token (raw token never stored); FK → `users(id)` cascade.
  - **KV** (`SESSIONS` binding) caches each live session (self-evicting via ~1yr TTL) so a
    gated request needs **zero D1 reads** on the hot path; also stores auth rate-limit
    counters. D1 remains authoritative (lets the admin enumerate/revoke sessions later).
  - **Crypto** (`src/lib/crypto.ts`): Web-Crypto PBKDF2 hashing/verify, random tokens,
    HMAC token digests, constant-time compare. No Node APIs, no deps → runs on the edge.
  - **Account management (Task 4B)** — `src/lib/users.ts` owns all account CRUD +
    validation (create/edit/deactivate/reactivate); `src/lib/session.ts` gains
    `revokeAllUserSessions(userId)` which enumerates a user's session digests from **D1**
    (authoritative) and deletes them from **both D1 and KV** for instant lock-out.
  - **Guards (Task 4B)** — `src/lib/guards.ts`: `requireAuth`, `requireRole(role)`,
    `requireActiveSubscriber`, all layered on `getSessionUser`.
- **Caching (Task 5)**: stale-while-revalidate per folder id — Cloudflare **KV**
  (`DRIVE_CACHE` binding, now first-class in `wrangler.jsonc`) when present, per-isolate
  in-memory fallback otherwise. Fresh 5 min, stale-served up to 1 h while a background
  `waitUntil` refresh runs. Cache stores only the normalised, safe listing (never the API
  key or any raw Drive URL); the per-request `locked` flag is applied on top after a fresh
  session check, so a cached listing can never leak content to a non-subscriber.
- **Secrets / bindings (names only — values live in Cloudflare, never in code)**:
  - `GOOGLE_API_KEY` — Google Drive API key (secret; server-side only)
  - `SESSION_SECRET` — random 32+ byte secret keying session-token digests (secret, Task 4A)
  - `ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD` — first-admin bootstrap credentials (secret,
    Task 11) — env-driven admin provisioning; see `seedAdminFromEnv` in `src/lib/users.ts`.
  - `DRIVE_ROOT_FOLDER_ID` — root library folder id (non-secret `vars` entry in `wrangler.jsonc`)
  - `SITE_ORIGIN` — canonical origin for CORS lock (optional non-secret var)
  - `DB` — D1 database binding (`users` + `sessions`)
  - `SESSIONS` — KV namespace binding (session hot-cache + rate-limit counters); also the
  store `revokeAllUserSessions` clears for instant deactivation.
  - `DRIVE_CACHE` — KV namespace binding (Task 5): short-TTL, stale-while-revalidate cache
  of Drive folder listings keyed by folder id. Optional; falls back to in-memory.

## Environment Variables
Names only; see `.env.example` and `.dev.vars.example`. **Never commit values.** All are read
**server-side only** and are never serialised to the browser.

| Name | Type | Purpose |
|------|------|---------|
| `GOOGLE_API_KEY` | **secret** | Google Drive API key. Server-side only — never sent to the client. |
| `SESSION_SECRET` | **secret** | Random 32+ byte secret keying session-token HMAC digests. |
| `ADMIN_SEED_EMAIL` | **secret** | Email of the first admin, provisioned on first login. |
| `ADMIN_SEED_PASSWORD` | **secret** | Password of the first admin (used only to bootstrap). |
| `DRIVE_ROOT_FOLDER_ID` | var | Root library folder id (not sensitive; shipped in `wrangler.jsonc` `vars` = `1hZNdWjagdi7Zo3TNaWHk4S2Ztae3q7Pv`). |
| `SITE_ORIGIN` | var | Canonical origin for the CORS lock (optional). |

**Production secrets** (values live only in Cloudflare, never in the repo):
```bash
wrangler pages secret put GOOGLE_API_KEY
wrangler pages secret put SESSION_SECRET       # openssl rand -base64 48
wrangler pages secret put ADMIN_SEED_EMAIL
wrangler pages secret put ADMIN_SEED_PASSWORD
```
`DRIVE_ROOT_FOLDER_ID` ships as a non-secret `vars` entry in `wrangler.jsonc`; override it in
the Cloudflare dashboard per-environment if needed.

**Local dev**: copy `.dev.vars.example` → `.dev.vars` and fill values (git-ignored).

**Admin bootstrap (env-driven, no hardcoded accounts).** On the login path, when the submitted
email equals `ADMIN_SEED_EMAIL`, `seedAdminFromEnv()` (`src/lib/users.ts`) idempotently:
creates the account as an **active admin** if it doesn't exist, or promotes/repairs an existing
account (role→admin, status→active, password aligned to the current secret). It runs only for the
seed email, makes **zero writes** once the admin already matches, and is race-safe via the
`UNIQUE(email_lower)` constraint. This means production never ships the dev `seed.sql` rows —
the first admin comes entirely from Cloudflare secrets.

- **D1**: `wrangler d1 create bacyeswecan-production`, paste the `database_id` into
  `wrangler.jsonc`, then `npm run db:migrate:prod` (local uses `--local` automatically).
- **KV**: `wrangler kv namespace create SESSIONS` **and** `wrangler kv namespace create
  DRIVE_CACHE`, pasting each returned `id` + `preview_id` into `wrangler.jsonc`.
  `DRIVE_CACHE` is optional — without it the Drive listing cache falls back to an
  in-memory per-isolate cache.

## User Guide
- Visit `/library` — it now looks and works like **Google Drive**.
- Use the left **navigation rail** ("My Library" + subjects) or the **breadcrumb** at the top
  to move between folders. **Click any folder** to open it; nested folders are fully supported.
- Toggle **List / Grid** view (top-right); your choice is remembered.
- Use the **search box** in the top bar to search files *and* folders across the whole
  library; results are grouped into Folders and Files with the path where each was found.
- Files show a **lock** for non-approved users. Click one → the contact popup opens with a
  direct TikTok link (`@abderahmane.lovenature`). Once an admin approves your account, files
  unlock and open **inside the site** (no downloads, no external Drive links).
- On a phone, tap the **☰ menu** to open the sidebar drawer.

## Development
```bash
npm install
npm run db:migrate:local           # apply D1 schema to local SQLite
npm run db:seed:local              # OPTIONAL dev users (see seed.sql — NOT for prod)
npm run build                      # vite build → dist/
pm2 start ecosystem.config.cjs     # wrangler pages dev dist on :3000
curl http://localhost:3000/api/library/list
```
Without Drive secrets, the library shows labelled **sample** content. `.dev.vars` must
contain a `SESSION_SECRET` for auth to work locally.

**Dev-only seed accounts** (from `seed.sql` — never ship these):
| Email | Password | Role |
|-------|----------|------|
| `admin@bacyeswecan.dev` | `AdminPass123!` | admin |
| `student@bacyeswecan.dev` | `StudentPass123!` | subscriber |

Quick auth smoke test:
```bash
curl -c cj.txt -X POST localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"student@bacyeswecan.dev","password":"StudentPass123!"}'
curl -b cj.txt localhost:3000/api/auth/me          # authenticated:true
curl -b cj.txt -X POST localhost:3000/api/auth/logout
```

Admin account-management smoke test (Task 4B):
```bash
# Log in as admin
curl -c admin.txt -X POST localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@bacyeswecan.dev","password":"AdminPass123!"}'
# Create a subscriber (admin-only; no public signup)
curl -b admin.txt -X POST localhost:3000/api/admin/accounts \
  -H 'Content-Type: application/json' \
  -d '{"email":"new@bacyeswecan.dev","password":"NewPass1234"}'
# List accounts, then deactivate one (instantly kills its sessions)
curl -b admin.txt localhost:3000/api/admin/accounts
curl -b admin.txt -X POST localhost:3000/api/admin/accounts/<ID>/deactivate
# A subscriber cookie hitting an admin route → 403 FORBIDDEN
```

## Deployment
- **Platform**: Cloudflare Pages + Workers (Functions), D1 (SQLite) and KV.
- **Status**: 🚀 Deploy-ready (Task 11) — build passes, typecheck clean, all secrets read from env.
- **Tech Stack**: Hono + TypeScript + Vite + hand-written CSS design system (no CSS
  framework), Fraunces + Public Sans via Google Fonts

### Deploy to Cloudflare Pages (Task 11)
```bash
# 1. Install + provision resources (one time)
npm install
wrangler d1 create bacyeswecan-production          # paste database_id → wrangler.jsonc
wrangler kv namespace create SESSIONS              # paste id + preview_id → wrangler.jsonc
wrangler kv namespace create DRIVE_CACHE           # paste id + preview_id → wrangler.jsonc

# 2. Apply the schema to the production D1
npm run db:migrate:prod

# 3. Set the four secrets (values never touch the repo)
wrangler pages secret put GOOGLE_API_KEY
wrangler pages secret put SESSION_SECRET           # openssl rand -base64 48
wrangler pages secret put ADMIN_SEED_EMAIL
wrangler pages secret put ADMIN_SEED_PASSWORD
# DRIVE_ROOT_FOLDER_ID is a non-secret var already in wrangler.jsonc.

# 4. Build + deploy
npm run build
npm run deploy               # or: npm run deploy:prod  (pins --project-name taysir)

# 5. First admin: just log in once with ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD.
#    The account is provisioned automatically (no seed.sql in production).
```

- **Last Updated**: 2026-07-19 (**Library cleanup + subscription-based file access**):
  Removed obsolete placeholder/error copy that could still surface to users —
  the *"Showing example content — connect Google Drive…"* sample banner
  (`#lib-sample-note`, now permanently suppressed in `src/pages/library.ts` +
  `public/static/library.js`), the *"This folder is empty / There are no files
  or folders here"* empty state, and the *"Couldn't load this folder / Please
  try again"* error state (both now render as clean, silent nodes; a transient
  list failure is retried **silently** in the background instead of showing an
  error). **Access model clarified & enforced server-side**: any logged-in user
  browses every folder/file normally via `/api/library/list`; only *opening /
  downloading* a file is gated. Non-subscribers hitting the gated content
  endpoints (`/api/library/file/:id/{meta,content}`) get **HTTP 402
  `SUBSCRIPTION_REQUIRED`** with a clear Arabic message — «هذا الملف متاح
  للمشتركين فقط. للاشتراك تواصل مع المالك عبر تيك توك…» + the owner's TikTok —
  and **no bytes are ever served** (enforced by `requireActiveSubscriber` in
  `src/lib/guards.ts`, not by hiding a button). The subscribe modal + client
  block message are now Arabic/RTL. Authentication/session, admin-approval/lock
  logic, admin page, Drive browsing, the PBKDF2=100,000 hashing fix, and the
  design are all unchanged.
- **Previously Updated**: 2026-07-11 (Task 11 — **deploy prep**: env-driven **admin bootstrap**
  (`ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD` → `seedAdminFromEnv` in `src/lib/users.ts`, hooked
  into `POST /api/auth/login`), `DRIVE_ROOT_FOLDER_ID` shipped as a non-secret `vars` entry,
  refreshed `.env.example` / `.dev.vars.example` / `wrangler.jsonc` secret docs, added
  `typecheck` + `deploy:prod` scripts and `typescript` / `@cloudflare/workers-types`
  devDependencies. `GOOGLE_API_KEY` stays strictly server-side.)
- **Previously Updated**: 2026-07-10 (Task 9 Step 3/3: admin **deactivate / reactivate** + **reset
  device** controls — per-row buttons on `/admin` gated behind a shared confirmation dialog and
  wired to the admin-only `POST /api/admin/accounts/:id/{deactivate,reactivate,reset-device}`
  endpoints. New this step: `resetUserDevice` (revokes all sessions without suspending) in
  `src/lib/users.ts` and its `POST …/reset-device` route in `src/routes/admin.ts`; UI in
  `src/pages/admin.ts` + `public/static/admin.js`. Self-deactivation guard stays server-side.)
- **Previously Updated**: 2026-07-10 (Task 9 Step 2/3: admin **create & edit** account UI —
  account list + "New subscriber" (create) and per-row "Edit" forms on `/admin`, wired to the
  admin-only `POST/PATCH /api/admin/accounts[/:id]` endpoints; validation/hashing/uniqueness/
  self-demotion guard/session revocation all server-side.)
- **Previously Updated**: 2026-07-08 (Task 5: Library + Google Drive — server-side Drive listing
  endpoint (`/api/library/list`) proxying folders/files from `DRIVE_ROOT_FOLDER_ID` with
  `GOOGLE_API_KEY`, read from env only and never sent to the client; nested folders; no raw
  Drive download URLs ever returned; **KV-cached listings** (`DRIVE_CACHE`, short-TTL SWR),
  now a first-class binding; full library UX — breadcrumb + folder nav, file cards/rows with
  title + type badge + thumbnail, lock icon → subscription modal for guests / viewer for
  subscribers, grid/list toggle, lazy thumbnails, skeleton loaders, and list virtualization
  keeping the 480-file archive smooth. No hardcoded secrets.)

## Features Not Yet Implemented
- Custom domain binding + production smoke test against real Google Drive credentials
  (the code path is complete; it just needs live secrets + a Pages project).

## Recommended Next Steps
1. Run the **Deploy to Cloudflare Pages (Task 11)** steps above with real credentials, then
   log in once with the `ADMIN_SEED_*` account to bootstrap the first admin.
2. **Task 9 is complete** (Steps 1–3). The admin console covers stats, create, edit,
   deactivate, reactivate and reset-device. A natural follow-up is an admin **audit log** of
   these lifecycle actions, and surfacing per-account **active session count** in the list.
3. After first login, consider **rotating** `ADMIN_SEED_PASSWORD` in Cloudflare (the next
   bootstrap login re-aligns the hash) or removing the seed secrets once more admins exist.

## AUTH CHANGE — Open signup + admin approval (this task)
The account model changed from **admin-provisioned only** to **open self-signup, locked until admin approval**.

- **Open signup** (`POST /api/auth/signup`, JSON `{ email, password }`): anyone creates their
  own account. It is created immediately and permanently as an active `subscriber`, and the
  user is auto-logged-in (persistent ~1yr cookie). The home page "إنشاء حساب" modal is now a
  real signup form (`public/static/home.js`).
- **Starts LOCKED**: every new self-signup has `approved = 0`. The user can log in and browse
  the whole library, but every FILE is locked — clicking one opens the subscribe/contact popup
  linking to TikTok `https://www.tiktok.com/@abderahmane.lovenature`.
- **`approved` status** (new `users.approved` column, migration `0002_approval.sql`, default 0).
  File access (`locked` flag + the content guard `requireActiveSubscriber`) is now keyed on
  **approved OR admin**, not merely "active session". `isApproved()` in `src/lib/auth.ts`.
- **Admin approve / un-approve** (`POST /api/admin/accounts/:id/approve` · `/unapprove`):
  only the admin sets approval, from the /admin dashboard (new "Access" column + Approve /
  Un-approve buttons + "Awaiting approval" stat card). Approval takes effect instantly WITHOUT
  logging the user out (`refreshUserSessions` rewrites the cached session snapshot).
- **Persistent session** unchanged: users stay logged in after refresh / browser restart.
- **Admins** are always entitled regardless of the flag. Existing accounts were grandfathered
  approved by the migration so nobody who already had access lost it.

Dev accounts (seed.sql): admin@bacyeswecan.dev / AdminPass123! (admin, approved);
student@bacyeswecan.dev / StudentPass123! (approved); pending@bacyeswecan.dev /
StudentPass123! (locked — awaiting approval).
