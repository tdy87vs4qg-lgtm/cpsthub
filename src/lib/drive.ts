// ============================================================================
// تيسير — Google Drive service (SERVER-SIDE ONLY)
//
// Every call to the Google Drive API happens here, inside the Cloudflare
// Worker / Pages Function runtime. The API key and root folder id are read
// exclusively from environment bindings (Cloudflare secrets / vars) and are
// NEVER serialised to the client. The browser only ever receives the
// normalised, safe DriveNode objects returned by listFolder().
//
// Caching: a stale-while-revalidate layer keyed by folder id. If a KV
// namespace binding (DRIVE_CACHE) is present it is used; otherwise an
// in-memory Map is used as a best-effort per-isolate cache.
//
// AUTH: every Drive request goes through resolveDriveAuth(env), which prefers a
// Google SERVICE ACCOUNT (GOOGLE_SERVICE_ACCOUNT_JSON → OAuth2 bearer token,
// scope drive.readonly). That is what makes PRIVATE Drive files readable. The
// plain GOOGLE_API_KEY is kept ONLY as a fallback for when no service account
// is configured (public-file behaviour, unchanged). Neither credential is ever
// sent to the browser or logged.
// ============================================================================

import {
  DRIVE_READONLY_SCOPE,
  getServiceAccountToken,
  hasServiceAccount,
} from './google-auth'

export interface Env {
  // Secrets / vars (names only — values live in Cloudflare, never in code)
  GOOGLE_API_KEY?: string
  // Google SERVICE ACCOUNT key (the full JSON, as a single secret value).
  // PREFERRED credential: it is exchanged for an OAuth2 bearer token so the app
  // can read PRIVATE Drive files (the library folder is shared with the service
  // account's client_email). Read server-side only; NEVER logged, NEVER sent to
  // the browser. When absent the code falls back to GOOGLE_API_KEY.
  GOOGLE_SERVICE_ACCOUNT_JSON?: string
  // Root Drive folder id. `DRIVE_FOLDER_ID` is the canonical name; the legacy
  // `DRIVE_ROOT_FOLDER_ID` is still accepted as a fallback. Both are read
  // server-side only via driveRootId(env) and never sent to the browser.
  DRIVE_FOLDER_ID?: string
  DRIVE_ROOT_FOLDER_ID?: string
  // Secondary (additional) Drive folder that holds the real targets of the
  // shortcut items placed in the main folder. Some entries in the main folder
  // are Drive shortcuts whose `shortcutDetails.targetId` points at a file that
  // physically lives in this folder. It is treated as an ADDITIONAL allowed
  // source alongside the main folder so those targets resolve/preview/download
  // normally. Read server-side only; never sent to the browser. When unset it
  // falls back to the known secondary folder id (see driveSecondaryId).
  SECONDARY_DRIVE_FOLDER_ID?: string
  SITE_ORIGIN?: string
  // Optional KV binding for cross-request caching of Drive listings
  DRIVE_CACHE?: KVNamespace

  // --- Auth (Task 4A) -------------------------------------------------------
  // Secret used to key session-token digests + password ops. Read from env
  // ONLY (Cloudflare secret / .dev.vars) — never hardcoded.
  SESSION_SECRET?: string
  // D1 database: source of truth for `users` + `sessions`.
  DB?: D1Database
  // KV namespace: hot-path session cache (self-evicting via TTL).
  SESSIONS?: KVNamespace

  // --- Admin bootstrap (Task 11 / deploy) -----------------------------------
  // First-admin credentials read from env ONLY (Cloudflare secrets / .dev.vars).
  // On login these idempotently provision (or repair) the single seed admin so
  // production never depends on the hardcoded dev seed rows. Values NEVER reach
  // the browser and are NEVER logged.
  ADMIN_SEED_EMAIL?: string
  ADMIN_SEED_PASSWORD?: string

}

/** A folder or file, normalised and safe to send to the browser. */
export interface DriveNode {
  id: string
  name: string
  kind: 'folder' | 'file'
  /** MIME type for files (folders omit it). */
  mimeType?: string
  /** Coarse category used for the type badge + icon. */
  fileType?: FileType
  /** Human-readable size, e.g. "1.2 MB" (files only). */
  size?: string
  /** ISO date the file was last modified. */
  modified?: string
  /** true when Drive can render a thumbnail for this file (lazy-loaded client-side). */
  hasThumb?: boolean
  /** true when the node is behind the subscription gate. */
  locked: boolean
}

export interface FolderListing {
  folder: { id: string; name: string; isRoot: boolean }
  breadcrumb: Array<{ id: string; name: string }>
  folders: DriveNode[]
  files: DriveNode[]
  /** true when this listing is sample content (no Drive secrets configured). */
  sample: boolean
}

export type FileType =
  | 'lesson'
  | 'summary'
  | 'exercises'
  | 'exam'
  | 'mock'
  | 'book'
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slides'
  | 'image'
  | 'video'
  | 'other'

/** Resolve the configured root folder id, accepting either env var name. */
export function driveRootId(env: Env): string | undefined {
  return env.DRIVE_FOLDER_ID || env.DRIVE_ROOT_FOLDER_ID
}

// Known secondary folder that stores the real targets of the shortcut items in
// the main folder. Used as the default when `SECONDARY_DRIVE_FOLDER_ID` is not
// explicitly provided via env, so shortcut targets resolve out of the box.
const DEFAULT_SECONDARY_FOLDER_ID = '1rLZJwRVGblUvAulzcEFT6T9xZ94ChzkQ'

/**
 * Resolve the secondary (additional) allowed folder id. Prefers the explicit
 * `SECONDARY_DRIVE_FOLDER_ID` env binding; otherwise falls back to the known
 * folder that holds the shortcut targets. Server-side only.
 */
export function driveSecondaryId(env: Env): string {
  return env.SECONDARY_DRIVE_FOLDER_ID || DEFAULT_SECONDARY_FOLDER_ID
}

/**
 * The set of folder ids the API is allowed to serve content from: the main
 * (root) library folder AND the secondary folder that holds the shortcut
 * targets. Used to scope search results so files living in either folder count
 * as "in the library". Returns an empty array when no root is configured.
 */
export function allowedSourceIds(env: Env): string[] {
  const rootId = driveRootId(env)
  if (!rootId) return []
  const ids = [rootId]
  const secondary = driveSecondaryId(env)
  if (secondary && secondary !== rootId) ids.push(secondary)
  return ids
}

const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder'
// A shortcut is a pointer to another Drive file. It has no bytes of its own:
// its `shortcutDetails` hold the real target's id + mime type. We must resolve
// these to the target before listing/previewing/downloading, otherwise Drive's
// `alt=media`/export fails and the viewer shows the "unsupported" message.
const DRIVE_SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files'

// ---------------------------------------------------------------------------
// Drive credential resolution
//
// A DriveAuth is EITHER a service-account bearer token (private files work) OR
// a plain API key (fallback, public files only). Every Drive request builds its
// query params + headers from this object, so both paths share one code path.
// ---------------------------------------------------------------------------
export interface DriveAuth {
  /** OAuth2 access token minted from the service account (preferred). */
  token?: string
  /** Plain API key — used ONLY when no service account is configured. */
  apiKey?: string
}

/**
 * True when the Drive integration has *some* usable credential configured
 * (service account preferred, API key accepted) AND a root folder id. Used to
 * decide between live Drive mode and labelled sample mode.
 */
export function driveCredentialConfigured(env: Env): boolean {
  return hasServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON) || Boolean(env.GOOGLE_API_KEY)
}

/** True when Drive is fully configured: a credential AND a root folder id. */
export function driveConfigured(env: Env): boolean {
  return driveCredentialConfigured(env) && Boolean(driveRootId(env))
}

/**
 * Resolve the credential used for Drive calls. Prefers the service account; if
 * minting its token fails for any reason we degrade to the API key (when one is
 * configured) rather than breaking the library entirely. Returns null when no
 * credential at all is available. Never logs the credential itself.
 */
export async function resolveDriveAuth(env: Env): Promise<DriveAuth | null> {
  if (hasServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON)) {
    try {
      const token = await getServiceAccountToken(
        env.GOOGLE_SERVICE_ACCOUNT_JSON,
        DRIVE_READONLY_SCOPE
      )
      if (token) return { token }
    } catch {
      // Fall through to the API-key fallback below (no secret is surfaced).
    }
  }
  if (env.GOOGLE_API_KEY) return { apiKey: env.GOOGLE_API_KEY }
  return null
}

/** Query params carrying the credential (API-key path only; bearer uses a header). */
function authParams(auth: DriveAuth): Record<string, string> {
  return auth.apiKey && !auth.token ? { key: auth.apiKey } : {}
}

/** Request headers carrying the credential (service-account path only). */
function authHeaders(auth: DriveAuth): Record<string, string> {
  return auth.token ? { Authorization: `Bearer ${auth.token}` } : {}
}

/**
 * Single entry point for every Drive HTTP call, so auth is applied uniformly.
 *
 * Any caller-supplied headers on `init.headers` are PRESERVED and forwarded to
 * Drive — this is how the content route passes the browser's `Range` header
 * through to `alt=media` so Drive answers with a 206 partial body (needed for
 * progressive PDF.js / <video> loading). Only the credential headers are set by
 * us, so a forwarded `Range` can never override or leak auth.
 */
function driveFetch(url: string, auth: DriveAuth, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {})
  for (const [k, v] of Object.entries(authHeaders(auth))) headers.set(k, v)
  return fetch(url, { ...init, headers })
}
const CACHE_TTL_SECONDS = 300 // fresh window
const CACHE_STALE_SECONDS = 3600 // may serve stale up to this while revalidating

// ---------------------------------------------------------------------------
// In-memory fallback cache (per isolate). KV is preferred when available.
// ---------------------------------------------------------------------------
interface CacheEntry {
  storedAt: number
  data: FolderListing
}
const memoryCache = new Map<string, CacheEntry>()

// ---------------------------------------------------------------------------
// Folder-metadata cache (per isolate) — id → { name, parent }.
//
// Navigating in/out of folders repeatedly resolves the same breadcrumb chain.
// Each ancestor previously cost its own serial `driveGetMeta` round trip. We
// remember every folder's name + first parent the moment we learn it (from any
// listing, breadcrumb walk, or lookup) so subsequent navigations build the
// breadcrumb almost entirely from memory — usually zero extra Drive calls.
// ---------------------------------------------------------------------------
interface FolderMeta {
  name: string
  parent?: string
  mimeType?: string
}
const folderMetaCache = new Map<string, FolderMeta>()

// Request de-duplication: collapse concurrent identical `driveGetMeta` calls
// (e.g. two folders that share an ancestor) into a single in-flight fetch.
const metaInflight = new Map<string, Promise<DriveMeta | null>>()

interface DriveMeta {
  id: string
  name: string
  mimeType: string
  parents?: string[]
}

function rememberMeta(meta: DriveMeta | null): void {
  if (!meta) return
  folderMetaCache.set(meta.id, {
    name: meta.name,
    parent: meta.parents?.[0],
    mimeType: meta.mimeType,
  })
}

// Cached file-metadata (viewer chrome). File meta is effectively immutable for
// the life of an isolate, so caching it makes opening/switching files instant.
interface FileMetaEntry {
  storedAt: number
  meta: FileMeta
}
const fileMetaCache = new Map<string, FileMetaEntry>()
const FILE_META_TTL_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List the children of a Drive folder. When no folder id is supplied the
 * configured root folder is used. Returns folders first, then files, both
 * alphabetically. The `locked` flag reflects whether the requesting user is a
 * subscriber (files are locked for everyone except subscribers).
 */
export async function listFolder(
  env: Env,
  folderId: string | undefined,
  opts: { isSubscriber: boolean; ctx?: ExecutionContext } = { isSubscriber: false }
): Promise<FolderListing> {
  const rootId = driveRootId(env)
  const isSubscriber = opts.isSubscriber

  // No secrets configured → serve labelled sample data so the UI is usable.
  if (!driveCredentialConfigured(env) || !rootId) {
    return sampleListing(folderId, isSubscriber)
  }

  const targetId = folderId && folderId !== 'root' ? folderId : rootId
  const cacheKey = `drive:list:${targetId}`

  // 1. Try cache (stale-while-revalidate).
  const cached = await readCache(env, cacheKey)
  const now = Date.now()
  if (cached) {
    const ageSec = (now - cached.storedAt) / 1000
    const listing = applyLock(cached.data, isSubscriber)
    if (ageSec <= CACHE_TTL_SECONDS) {
      return listing // fresh
    }
    if (ageSec <= CACHE_STALE_SECONDS) {
      // Serve stale immediately, refresh in the background.
      const revalidate = fetchAndCache(env, targetId, rootId, cacheKey).catch(() => {})
      if (opts.ctx) opts.ctx.waitUntil(revalidate)
      return listing
    }
  }

  // 2. Cache miss / too stale → fetch live. A credential failure degrades to
  //    sample content instead of an error page.
  const fresh = await fetchAndCache(env, targetId, rootId, cacheKey)
  if (!fresh) return sampleListing(folderId, isSubscriber)
  return applyLock(fresh, isSubscriber)
}

// ---------------------------------------------------------------------------
// Global search (Task 8) — searches file AND folder names across the whole
// library. Works in both sample mode (walks the in-memory SAMPLE_TREE) and
// live Drive mode (a single Drive query with a `name contains` filter across
// the whole drive, then a client-side substring check so results are precise).
// Files carry the same per-request `locked` flag as /list so the client can
// render a lock + open the subscribe modal for non-subscribers.
// ---------------------------------------------------------------------------

/** A single search hit — a file or folder, plus the folder it lives in so the
 *  UI can show where it was found and link folders for navigation. */
export interface SearchHit extends DriveNode {
  /** Id of the parent folder (used to navigate to a folder result). */
  parentId: string
  /** Human-readable path of the parent folder, e.g. "Library / Mathematics". */
  parentPath: string
}

export interface SearchResult {
  query: string
  folders: SearchHit[]
  files: SearchHit[]
  /** true when results come from sample content (no Drive secrets). */
  sample: boolean
  /** true when the result set was capped (more matches exist). */
  truncated: boolean
}

const SEARCH_MAX_RESULTS = 60

/**
 * Search the whole library by file/folder name. Returns folders first, then
 * files, both alphabetically, each annotated with the folder they live in.
 */
export async function searchLibrary(
  env: Env,
  rawQuery: string,
  opts: { isSubscriber: boolean } = { isSubscriber: false }
): Promise<SearchResult> {
  const query = (rawQuery || '').trim()
  const isSubscriber = opts.isSubscriber
  const q = query.toLowerCase()

  if (!q) {
    return { query, folders: [], files: [], sample: !driveConfigured(env), truncated: false }
  }

  if (!driveConfigured(env)) {
    return sampleSearch(q, query, isSubscriber)
  }

  return driveSearch(env, q, query, isSubscriber)
}

/** Sample-mode search: walk the in-memory tree (includes the big archive). */
function sampleSearch(q: string, query: string, isSubscriber: boolean): SearchResult {
  const folders: SearchHit[] = []
  const files: SearchHit[] = []
  const match = (name: string) => name.toLowerCase().indexOf(q) !== -1

  const walk = (node: SampleFolder, path: string[]) => {
    // Folder name match (skip the synthetic root).
    if (node.id !== 'root' && match(node.name)) {
      const parent = findSample(SAMPLE_TREE, node.parent)
      folders.push({
        id: node.id,
        name: node.name,
        kind: 'folder',
        locked: false,
        parentId: node.parent || 'root',
        parentPath: path.join(' / ') || 'Library',
      })
    }

    // Files inside this folder.
    const rawFiles = node.id === 's-archive' ? bigArchiveFiles() : node.files || []
    const here = [...path, node.id === 'root' ? 'Library' : node.name]
    // Match against the SORTED order so ids line up with sampleListing / viewer.
    const sorted = rawFiles
      .map((f, i) => ({ f, i }))
      .sort((a, b) => byName({ name: a.f.name } as DriveNode, { name: b.f.name } as DriveNode))
    for (const { f, i } of sorted) {
      if (!match(f.name)) continue
      const isImage = /\.(png|jpe?g|gif|webp)$/i.test(f.name)
      const mimeType = isImage ? 'image/png' : 'application/pdf'
      files.push({
        id: `${node.id}-f${i}`,
        name: f.name,
        kind: 'file',
        mimeType,
        fileType: classify(f.name, mimeType),
        size: f.size,
        modified: f.modified,
        hasThumb: true,
        locked: !isSubscriber,
        parentId: node.id,
        parentPath: here.join(' / '),
      })
    }

    for (const child of node.children || []) {
      walk(child, [...path, node.id === 'root' ? 'Library' : node.name])
    }
  }

  walk(SAMPLE_TREE, [])

  return capResults(folders, files, query, true)
}

/** Live Drive search: one query across the drive with a `name contains`
 *  filter, then a precise client-side substring check + parent resolution. */
async function driveSearch(
  env: Env,
  q: string,
  query: string,
  isSubscriber: boolean
): Promise<SearchResult> {
  const rootId = driveRootId(env)!
  const auth = await resolveDriveAuth(env)
  // No usable credential → behave like sample mode instead of throwing.
  if (!auth) return sampleSearch(q, query, isSubscriber)

  // Drive's `contains` is a prefix-ish token match; we still substring-filter
  // locally for correctness. Escape single quotes in the query for the API.
  const safe = query.replace(/'/g, "\\'")
  const params = new URLSearchParams({
    q: `name contains '${safe}' and trashed = false`,
    ...authParams(auth),
    fields:
      'files(id,name,mimeType,size,modifiedTime,hasThumbnail,thumbnailLink,parents,shortcutDetails(targetId,targetMimeType)),nextPageToken',
    orderBy: 'folder,name',
    pageSize: '200',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    corpora: 'allDrives',
  })

  const raw: Array<{
    id: string
    name: string
    mimeType: string
    size?: string
    modifiedTime?: string
    hasThumbnail?: boolean
    thumbnailLink?: string
    parents?: string[]
    shortcutDetails?: { targetId?: string; targetMimeType?: string }
  }> = []

  let pageToken: string | undefined
  let pages = 0
  do {
    if (pageToken) params.set('pageToken', pageToken)
    const res = await driveFetch(`${DRIVE_API}?${params.toString()}`, auth)
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Drive search failed (${res.status}): ${body.slice(0, 200)}`)
    }
    const json = (await res.json()) as { files?: any[]; nextPageToken?: string }
    if (json.files) raw.push(...json.files)
    pageToken = json.nextPageToken
    pages++
  } while (pageToken && pages < 3)

  // Keep only items that actually live under one of the allowed source folders
  // (the main library folder OR the secondary folder that holds the shortcut
  // targets) so search is scoped to the library, not the whole drive — then
  // match the substring.
  const underRoot = await scopeToRoot(env, raw, allowedSourceIds(env), auth)

  const folders: SearchHit[] = []
  const files: SearchHit[] = []
  const nameCache: Record<string, string> = { [rootId]: 'Library' }

  for (const item of underRoot) {
    if (item.name.toLowerCase().indexOf(q) === -1) continue
    const parentId = item.parents?.[0] || rootId
    const parentPath = await resolvePath(parentId, rootId, auth, nameCache)
    if (item.mimeType === DRIVE_FOLDER_MIME) {
      folders.push({
        id: item.id,
        name: item.name,
        kind: 'folder',
        locked: false,
        parentId,
        parentPath,
      })
    } else if (item.mimeType === DRIVE_SHORTCUT_MIME) {
      // Shortcut hit → present it as the real target (same as the folder
      // listing) so opening the result goes straight to the target file.
      const targetId = item.shortcutDetails?.targetId
      if (!targetId) continue
      const targetMime = item.shortcutDetails?.targetMimeType || 'application/octet-stream'
      files.push({
        id: targetId,
        name: item.name,
        kind: 'file',
        mimeType: targetMime,
        fileType: classify(item.name, targetMime),
        size: item.size ? humanSize(Number(item.size)) : undefined,
        modified: item.modifiedTime,
        hasThumb: Boolean(item.hasThumbnail || item.thumbnailLink),
        locked: !isSubscriber,
        parentId,
        parentPath,
      })
    } else {
      files.push({
        id: item.id,
        name: item.name,
        kind: 'file',
        mimeType: item.mimeType,
        fileType: classify(item.name, item.mimeType),
        size: item.size ? humanSize(Number(item.size)) : undefined,
        modified: item.modifiedTime,
        hasThumb: Boolean(item.hasThumbnail || item.thumbnailLink),
        locked: !isSubscriber,
        parentId,
        parentPath,
      })
    }
  }

  return capResults(folders, files, query, false)
}

/** Restrict raw Drive hits to those that live somewhere under one of the
 *  allowed source folders (main library folder OR the secondary shortcut-target
 *  folder). Walks each item's parent chain (cached) until it reaches an allowed
 *  root or gives up. */
async function scopeToRoot(
  env: Env,
  items: Array<{ id: string; parents?: string[] }>,
  rootIds: string[],
  auth: DriveAuth
): Promise<any[]> {
  const parentOf: Record<string, string | undefined> = {}
  // Seed every allowed source folder as "under" itself so any parent chain that
  // reaches the main folder OR the secondary folder is accepted.
  const isUnder: Record<string, boolean> = {}
  for (const id of rootIds) isUnder[id] = true
  const rootSet = new Set(rootIds)

  async function under(id: string | undefined, guard = 0): Promise<boolean> {
    if (!id || guard > 12) return false
    if (id in isUnder) return isUnder[id]
    let parent = parentOf[id]
    if (parent === undefined) {
      const meta = await driveGetMeta(id, auth)
      parent = meta?.parents?.[0]
      parentOf[id] = parent
    }
    const result = await under(parent, guard + 1)
    isUnder[id] = result
    return result
  }

  const out: any[] = []
  for (const item of items as any[]) {
    if (rootSet.has(item.id)) continue
    if (await under(item.parents?.[0])) out.push(item)
  }
  return out
}

/** Build a "Library / Subject / Chapter" path for a parent folder id. */
async function resolvePath(
  folderId: string,
  rootId: string,
  auth: DriveAuth,
  nameCache: Record<string, string>
): Promise<string> {
  const names: string[] = []
  let current: string | undefined = folderId
  let guard = 0
  while (current && guard < 12) {
    guard++
    if (current === rootId) {
      names.unshift('Library')
      break
    }
    let name = nameCache[current]
    let parent: string | undefined
    const meta = await driveGetMeta(current, auth)
    if (meta) {
      name = name || meta.name
      nameCache[current] = name
      parent = meta.parents?.[0]
    }
    names.unshift(name || 'Folder')
    if (!parent) break
    current = parent
  }
  if (names[0] !== 'Library') names.unshift('Library')
  return names.join(' / ')
}

/** Sort, cap, and package a set of folder + file hits. */
function capResults(
  folders: SearchHit[],
  files: SearchHit[],
  query: string,
  sample: boolean
): SearchResult {
  folders.sort(byName)
  files.sort(byName)
  const total = folders.length + files.length
  let truncated = false
  if (total > SEARCH_MAX_RESULTS) {
    truncated = true
    // Keep all folders (usually few), then fill remaining budget with files.
    const filesBudget = Math.max(0, SEARCH_MAX_RESULTS - folders.length)
    files.splice(filesBudget)
    folders.splice(SEARCH_MAX_RESULTS)
  }
  return { query, folders, files, sample, truncated }
}

// ---------------------------------------------------------------------------
// Live Drive fetch + normalisation
// ---------------------------------------------------------------------------
async function fetchAndCache(
  env: Env,
  targetId: string,
  rootId: string,
  cacheKey: string
): Promise<FolderListing | null> {
  // Service-account bearer token when configured, else the API-key fallback.
  const auth = await resolveDriveAuth(env)
  if (!auth) return null

  // `buildBreadcrumb` already resolves the target folder's own metadata (name +
  // parents) as the first step of its walk and caches it, so we no longer issue
  // a separate `driveGetMeta(targetId)` — one fewer serial round trip per nav.
  const [children, breadcrumb] = await Promise.all([
    driveListChildren(targetId, auth),
    buildBreadcrumb(targetId, rootId, auth),
  ])

  // Learn every child folder's name/parent for future breadcrumb builds so
  // navigating into them costs no extra metadata fetch.
  for (const item of children) {
    if (item.mimeType === DRIVE_FOLDER_MIME) {
      folderMetaCache.set(item.id, { name: item.name, parent: targetId, mimeType: item.mimeType })
    }
  }

  const meta = folderMetaCache.get(targetId)
  const folders: DriveNode[] = []
  const files: DriveNode[] = []

  for (const item of children) {
    if (item.mimeType === DRIVE_FOLDER_MIME) {
      folders.push({ id: item.id, name: item.name, kind: 'folder', locked: false })
    } else if (item.mimeType === DRIVE_SHORTCUT_MIME) {
      // Shortcut → present it as the real target so opening/previewing/
      // downloading goes straight to the target file through the worker. We use
      // the target's id + mime type (from shortcutDetails) but keep the item's
      // display name (Drive names shortcuts after their target). A shortcut with
      // no target id is skipped rather than shown as a broken entry.
      const targetId2 = item.shortcutDetails?.targetId
      if (!targetId2) continue
      const targetMime = item.shortcutDetails?.targetMimeType || 'application/octet-stream'
      files.push({
        id: targetId2,
        name: item.name,
        kind: 'file',
        mimeType: targetMime,
        fileType: classify(item.name, targetMime),
        size: item.size ? humanSize(Number(item.size)) : undefined,
        modified: item.modifiedTime,
        // Thumbnail is proxied by target id; advertise it when the shortcut row
        // exposed one (Drive often surfaces the target's thumbnail here).
        hasThumb: Boolean(item.hasThumbnail || item.thumbnailLink),
        locked: true, // default gated; unlocked per-request for subscribers
      })
    } else {
      files.push({
        id: item.id,
        name: item.name,
        kind: 'file',
        mimeType: item.mimeType,
        fileType: classify(item.name, item.mimeType),
        size: item.size ? humanSize(Number(item.size)) : undefined,
        modified: item.modifiedTime,
        hasThumb: Boolean(item.hasThumbnail || item.thumbnailLink),
        locked: true, // default gated; unlocked per-request for subscribers
      })
    }
  }

  const listing: FolderListing = {
    folder: {
      id: targetId,
      name: targetId === rootId ? 'Library' : meta?.name || 'Folder',
      isRoot: targetId === rootId,
    },
    breadcrumb,
    folders: folders.sort(byName),
    files: files.sort(byName),
    sample: false,
  }

  await writeCache(env, cacheKey, listing)
  return listing
}

async function driveListChildren(folderId: string, auth: DriveAuth) {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    ...authParams(auth),
    fields:
      'files(id,name,mimeType,size,modifiedTime,hasThumbnail,thumbnailLink,shortcutDetails(targetId,targetMimeType)),nextPageToken',
    orderBy: 'folder,name',
    pageSize: '1000',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  })

  const results: Array<{
    id: string
    name: string
    mimeType: string
    size?: string
    modifiedTime?: string
    hasThumbnail?: boolean
    thumbnailLink?: string
    shortcutDetails?: { targetId?: string; targetMimeType?: string }
  }> = []

  let pageToken: string | undefined
  do {
    if (pageToken) params.set('pageToken', pageToken)
    const res = await driveFetch(`${DRIVE_API}?${params.toString()}`, auth)
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Drive list failed (${res.status}): ${body.slice(0, 200)}`)
    }
    const json = (await res.json()) as { files?: any[]; nextPageToken?: string }
    if (json.files) results.push(...json.files)
    pageToken = json.nextPageToken
  } while (pageToken)

  return results
}

async function driveGetMeta(fileId: string, auth: DriveAuth): Promise<DriveMeta | null> {
  // De-duplicate concurrent identical lookups (shared ancestors resolve once).
  const existing = metaInflight.get(fileId)
  if (existing) return existing

  const run = (async (): Promise<DriveMeta | null> => {
    const params = new URLSearchParams({
      ...authParams(auth),
      fields: 'id,name,mimeType,parents',
      supportsAllDrives: 'true',
    })
    const res = await driveFetch(`${DRIVE_API}/${fileId}?${params.toString()}`, auth)
    if (!res.ok) return null
    const meta = (await res.json()) as DriveMeta
    rememberMeta(meta)
    return meta
  })()

  metaInflight.set(fileId, run)
  try {
    return await run
  } finally {
    metaInflight.delete(fileId)
  }
}

// ---------------------------------------------------------------------------
// Thumbnail proxy (SERVER-SIDE) — resolves a Drive file's thumbnailLink using
// the server-held API key, fetches the image, and streams the raw bytes back.
// The browser only ever sees /api/library/thumb/:id — never the Drive URL or
// the API key. Thumbnails are small so we cache them at the edge.
// ---------------------------------------------------------------------------
export interface ThumbResult {
  body: ArrayBuffer
  contentType: string
}

export async function getThumbnail(
  env: Env,
  fileId: string,
  size = 400
): Promise<ThumbResult | null> {
  if (!fileId) return null
  const auth = await resolveDriveAuth(env)
  if (!auth) return null

  // 1. Resolve the (short-lived) thumbnailLink from Drive metadata.
  const params = new URLSearchParams({
    ...authParams(auth),
    fields: 'id,thumbnailLink,hasThumbnail',
    supportsAllDrives: 'true',
  })
  const metaRes = await driveFetch(
    `${DRIVE_API}/${encodeURIComponent(fileId)}?${params.toString()}`,
    auth
  )
  if (!metaRes.ok) return null
  const meta = (await metaRes.json()) as { thumbnailLink?: string; hasThumbnail?: boolean }
  if (!meta.thumbnailLink) return null

  // Drive thumbnailLinks accept a size suffix (=s<size>); normalise it.
  const link = meta.thumbnailLink.replace(/=s\d+$/, '') + `=s${size}`

  // 2. Fetch the actual image bytes server-side. Thumbnails of PRIVATE files
  //    require the bearer token, so the same auth is attached here too.
  const imgRes = await driveFetch(link, auth)
  if (!imgRes.ok) return null
  const body = await imgRes.arrayBuffer()
  const contentType = imgRes.headers.get('content-type') || 'image/jpeg'
  return { body, contentType }
}

// ---------------------------------------------------------------------------
// File-content proxy (SERVER-SIDE) — Task 4C
//
// Streams the actual bytes of a Drive file through the Worker so the browser
// never sees a raw Drive URL or the API key. Binary files (PDF, images, video)
// are fetched via the Drive `alt=media` endpoint; Google-native docs (Docs,
// Sheets, Slides) are EXPORTED to a viewable format (PDF) since they have no
// direct media. The caller (route) is responsible for gating access with
// requireActiveSubscriber — this function performs NO access control itself.
// ---------------------------------------------------------------------------
export interface FileContent {
  body: ReadableStream | ArrayBuffer
  contentType: string
  /** Safe, human-readable filename for the Content-Disposition header. */
  filename: string
  /** Byte length when known (helps the viewer/range logic). */
  size?: number
  /**
   * Upstream status: 206 when Drive honoured a forwarded Range request, 200
   * otherwise. The route mirrors this so the browser/PDF.js sees a real partial
   * response instead of a full body.
   */
  status?: number
  /** Drive's `Content-Range` for a 206 (e.g. `bytes 0-65535/1048576`). */
  contentRange?: string
  /** Drive's `Accept-Ranges` (`bytes`) when range requests are supported. */
  acceptRanges?: string
}

/** Public, safe metadata for the viewer chrome (title, type). No secrets. */
export interface FileMeta {
  id: string
  name: string
  mimeType: string
  fileType: FileType
  size?: string
  modified?: string
  /** Rendering hint for the in-app viewer. */
  viewerKind: 'pdf' | 'image' | 'video' | 'text' | 'unsupported'
  /** true for sample-mode ids (no Drive configured). */
  sample: boolean
}

// Google-native mime types → the format we export them to for viewing.
const GOOGLE_EXPORT: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.presentation': { mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.drawing': { mime: 'image/png', ext: 'png' },
}

/** Map a mime type to a coarse viewer rendering strategy. */
export function viewerKindFor(mime: string, name = ''): FileMeta['viewerKind'] {
  const n = name.toLowerCase()
  if (mime === 'application/pdf' || n.endsWith('.pdf')) return 'pdf'
  if (mime in GOOGLE_EXPORT) return 'pdf' // native docs export to pdf/png → viewable
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('text/') || /\.(txt|md|csv)$/.test(n)) return 'text'
  return 'unsupported'
}

/**
 * Fetch safe metadata for a single file (title, mime, type). Returns null when
 * the file can't be found. Never leaks the API key or any Drive URL.
 */
export async function getFileMeta(env: Env, fileId: string): Promise<FileMeta | null> {
  // Sample mode → synthesise metadata from the sample tree ids.
  if (!driveConfigured(env)) {
    const s = sampleFileById(fileId)
    if (!s) return null
    return {
      id: fileId,
      name: s.name,
      mimeType: s.mimeType,
      fileType: classify(s.name, s.mimeType),
      size: s.size,
      modified: s.modified,
      viewerKind: viewerKindFor(s.mimeType, s.name),
      sample: true,
    }
  }

  // File metadata is effectively immutable for the isolate's lifetime — cache
  // it so opening and rapidly switching between files is instant (no round trip).
  const cached = fileMetaCache.get(fileId)
  if (cached && Date.now() - cached.storedAt < FILE_META_TTL_MS) {
    return cached.meta
  }

  const auth = await resolveDriveAuth(env)
  if (!auth) return null
  const params = new URLSearchParams({
    ...authParams(auth),
    fields: 'id,name,mimeType,size,modifiedTime,shortcutDetails(targetId,targetMimeType)',
    supportsAllDrives: 'true',
  })
  const res = await driveFetch(
    `${DRIVE_API}/${encodeURIComponent(fileId)}?${params.toString()}`,
    auth
  )
  if (!res.ok) return null
  let meta = (await res.json()) as {
    id: string
    name: string
    mimeType: string
    size?: string
    modifiedTime?: string
    shortcutDetails?: { targetId?: string; targetMimeType?: string }
  }

  // If the id points at a shortcut, transparently resolve to its target so the
  // viewer chrome shows the target's real name/type and the content endpoint
  // (called with the same id) can fetch real bytes. If the target can't be read
  // we return null → the route renders a graceful "file unavailable" message.
  if (meta.mimeType === DRIVE_SHORTCUT_MIME) {
    const targetId = meta.shortcutDetails?.targetId
    if (!targetId) return null
    const tParams = new URLSearchParams({
      ...authParams(auth),
      fields: 'id,name,mimeType,size,modifiedTime',
      supportsAllDrives: 'true',
    })
    const tRes = await driveFetch(
      `${DRIVE_API}/${encodeURIComponent(targetId)}?${tParams.toString()}`,
      auth
    )
    if (!tRes.ok) return null
    meta = (await tRes.json()) as typeof meta
  }

  const exported = GOOGLE_EXPORT[meta.mimeType]
  const effectiveMime = exported ? exported.mime : meta.mimeType
  const result: FileMeta = {
    id: meta.id,
    name: meta.name,
    mimeType: effectiveMime,
    fileType: classify(meta.name, meta.mimeType),
    size: meta.size ? humanSize(Number(meta.size)) : undefined,
    modified: meta.modifiedTime,
    viewerKind: viewerKindFor(meta.mimeType, meta.name),
    sample: false,
  }
  fileMetaCache.set(fileId, { storedAt: Date.now(), meta: result })
  return result
}

/**
 * Fetch the raw bytes of a file for in-app viewing. Binary files stream via
 * `alt=media`; Google-native docs are exported to PDF/PNG. The API key is used
 * server-side only; the returned stream is piped straight back to the client
 * from the route (nothing is ever buffered server-side). Returns null when the
 * file is missing/unsupported.
 *
 * `range` is the browser's raw `Range` header value when present. It is
 * forwarded verbatim to Drive so the viewer can pull just the bytes it needs;
 * Drive's 206 status + `Content-Range` / `Content-Length` / `Accept-Ranges` are
 * handed back to the route unchanged. With no `range`, behaviour is byte-for-byte
 * identical to before: a full 200 body.
 */
export async function getFileContent(
  env: Env,
  fileId: string,
  range?: string | null
): Promise<FileContent | null> {
  if (!fileId) return null
  const auth = await resolveDriveAuth(env)
  if (!auth) return null

  // Resolve the file's mime + name so we know whether to export or stream.
  const metaParams = new URLSearchParams({
    ...authParams(auth),
    fields: 'id,name,mimeType,size,shortcutDetails(targetId,targetMimeType)',
    supportsAllDrives: 'true',
  })
  const metaRes = await driveFetch(
    `${DRIVE_API}/${encodeURIComponent(fileId)}?${metaParams.toString()}`,
    auth
  )
  if (!metaRes.ok) return null
  let meta = (await metaRes.json()) as {
    id?: string
    name: string
    mimeType: string
    size?: string
    shortcutDetails?: { targetId?: string; targetMimeType?: string }
  }

  // A shortcut has no bytes of its own — follow it to the real target and fetch
  // that instead. If the target is unreadable we return null and the route
  // surfaces a clear Arabic "file unavailable" message (no crash).
  let effectiveId = fileId
  if (meta.mimeType === DRIVE_SHORTCUT_MIME) {
    const targetId = meta.shortcutDetails?.targetId
    if (!targetId) return null
    const tParams = new URLSearchParams({
      ...authParams(auth),
      fields: 'id,name,mimeType,size',
      supportsAllDrives: 'true',
    })
    const tRes = await driveFetch(
      `${DRIVE_API}/${encodeURIComponent(targetId)}?${tParams.toString()}`,
      auth
    )
    if (!tRes.ok) return null
    meta = (await tRes.json()) as typeof meta
    effectiveId = targetId
  }

  const exported = GOOGLE_EXPORT[meta.mimeType]
  let url: string
  let outMime: string
  let outName = meta.name

  if (exported) {
    // Google-native doc → export to a viewable format.
    const p = new URLSearchParams({
      ...authParams(auth),
      mimeType: exported.mime,
      supportsAllDrives: 'true',
    })
    url = `${DRIVE_API}/${encodeURIComponent(effectiveId)}/export?${p.toString()}`
    outMime = exported.mime
    if (!new RegExp(`\\.${exported.ext}$`, 'i').test(outName)) outName += `.${exported.ext}`
  } else {
    // Binary file → stream the media bytes directly.
    const p = new URLSearchParams({
      ...authParams(auth),
      alt: 'media',
      supportsAllDrives: 'true',
    })
    url = `${DRIVE_API}/${encodeURIComponent(effectiveId)}?${p.toString()}`
    outMime = meta.mimeType || 'application/octet-stream'
  }

  // Forward the caller's Range header (when any) so Drive can answer with a
  // partial body. Nothing else about the request changes, so a plain (rangeless)
  // open still gets the exact same full 200 stream as before.
  const fwdHeaders: Record<string, string> = {}
  if (range) fwdHeaders.Range = range

  const res = await driveFetch(url, auth, { headers: fwdHeaders })
  // 200 (full) and 206 (partial) are both success; res.ok covers both.
  if (!res.ok || !res.body) return null
  const contentType = res.headers.get('content-type') || outMime
  const len = res.headers.get('content-length')
  return {
    // Always a stream — the bytes are never buffered inside the Worker.
    body: res.body,
    contentType,
    filename: sanitizeFilename(outName),
    // For a 206 this is the PARTIAL length (Drive's own Content-Length), which
    // is exactly what the route must echo back.
    size: len ? Number(len) : res.status === 206 ? undefined : meta.size ? Number(meta.size) : undefined,
    status: res.status === 206 ? 206 : 200,
    contentRange: res.headers.get('content-range') || undefined,
    // Drive advertises byte ranges on alt=media; default to that when it 206s
    // so the browser knows it can seek even if the header was omitted.
    acceptRanges: res.headers.get('accept-ranges') || (res.status === 206 ? 'bytes' : undefined),
  }
}

/** Build sample file bytes (a small branded PDF/SVG/text) for dev mode. */
export function sampleFileContent(fileId: string): FileContent | null {
  const s = sampleFileById(fileId)
  if (!s) return null
  const kind = viewerKindFor(s.mimeType, s.name)
  if (kind === 'image') {
    const svg = new TextEncoder().encode(samplePreviewSvg(s.name))
    return {
      body: svg.buffer as ArrayBuffer,
      contentType: 'image/svg+xml; charset=utf-8',
      filename: sanitizeFilename(s.name.replace(/\.[^.]+$/, '') + '.svg'),
      size: svg.byteLength,
    }
  }
  // Everything else (pdf/text/other) → a readable text document so the
  // subscriber path is fully exercised without real Drive bytes.
  const text = sampleDocText(s.name)
  const bytes = new TextEncoder().encode(text)
  return {
    body: bytes.buffer as ArrayBuffer,
    contentType: 'text/plain; charset=utf-8',
    filename: sanitizeFilename(s.name.replace(/\.[^.]+$/, '') + '.txt'),
    size: bytes.byteLength,
  }
}

/** Strip anything unsafe from a filename before it hits a header. */
function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, '').replace(/[^\w.\-() ]+/g, '_').slice(0, 160) || 'file'
}

function sampleDocText(name: string): string {
  return [
    'تيسير — sample document',
    '='.repeat(40),
    '',
    `Title: ${name}`,
    '',
    'This is placeholder content served in SAMPLE mode (no Google Drive',
    'secrets are configured). In production the in-app viewer streams the real',
    'file bytes through the Worker — the browser never sees a raw Drive URL or',
    'the API key, and only active subscribers can load it.',
    '',
    'Access to this content is enforced server-side by requireActiveSubscriber.',
  ].join('\n')
}

function samplePreviewSvg(name: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1000" width="800" height="1000" role="img" aria-label="Sample preview">
  <rect width="800" height="1000" fill="#F5F1E8"/>
  <rect x="80" y="80" width="640" height="840" rx="10" fill="#ffffff" stroke="#7A6A52" stroke-opacity="0.3" stroke-width="3"/>
  <text x="400" y="180" text-anchor="middle" font-family="Public Sans, system-ui, sans-serif" font-size="26" fill="#3A2E1E">Sample preview</text>
  <text x="400" y="230" text-anchor="middle" font-family="Public Sans, system-ui, sans-serif" font-size="16" fill="#7A6A52">${(name || '').replace(/[<&>]/g, '')}</text>
  <g fill="none" stroke="#7A6A52" stroke-opacity="0.4" stroke-width="6" stroke-linecap="round">
    <path d="M180 340 h440 M180 400 h440 M180 460 h340 M180 560 h440 M180 620 h300"/>
  </g>
</svg>`
}

/** Walk up via `parents` from the target to the root to build a breadcrumb.
 *  Each ancestor's name/parent is served from the in-memory folder-metadata
 *  cache when known, so a warmed navigation typically issues ZERO Drive calls;
 *  only genuinely unknown levels fall back to a (deduped) metadata fetch. */
async function buildBreadcrumb(
  targetId: string,
  rootId: string,
  auth: DriveAuth
): Promise<Array<{ id: string; name: string }>> {
  const trail: Array<{ id: string; name: string }> = []
  let currentId: string | undefined = targetId
  let guard = 0

  while (currentId && guard < 12) {
    guard++
    if (currentId === rootId) {
      trail.unshift({ id: currentId, name: 'Library' })
      break
    }
    let cached = folderMetaCache.get(currentId)
    if (!cached) {
      const meta = await driveGetMeta(currentId, auth)
      if (!meta) break
      cached = { name: meta.name, parent: meta.parents?.[0], mimeType: meta.mimeType }
    }
    trail.unshift({ id: currentId, name: cached.name })
    currentId = cached.parent
    if (!currentId) break
  }

  // Ensure root is always first even if the walk stopped early.
  if (trail.length === 0 || trail[0].id !== rootId) {
    trail.unshift({ id: rootId, name: 'Library' })
  }
  return trail
}

// ---------------------------------------------------------------------------
// Cache helpers (KV preferred, in-memory fallback)
// ---------------------------------------------------------------------------
async function readCache(env: Env, key: string): Promise<CacheEntry | null> {
  if (env.DRIVE_CACHE) {
    const raw = await env.DRIVE_CACHE.get(key)
    if (raw) {
      try {
        return JSON.parse(raw) as CacheEntry
      } catch {
        return null
      }
    }
    return null
  }
  return memoryCache.get(key) ?? null
}

async function writeCache(env: Env, key: string, data: FolderListing): Promise<void> {
  const entry: CacheEntry = { storedAt: Date.now(), data }
  if (env.DRIVE_CACHE) {
    await env.DRIVE_CACHE.put(key, JSON.stringify(entry), {
      expirationTtl: CACHE_STALE_SECONDS,
    })
    return
  }
  memoryCache.set(key, entry)
}

/**
 * Read the ROOT folder's child folder NAMES out of the existing cache.
 *
 * Strictly read-only and names-only: it never calls Google, never widens what
 * is cached, and never returns an id, link, thumbnail, mime type, size or
 * breadcrumb — only plain strings. It exists so a public, credential-free
 * surface can show what the library is *called* without exposing anything a
 * logged-out visitor could use to reach file content.
 *
 * A cold cache is reported as `stale: true` (names empty) so the caller may
 * decide to warm it in the background; it deliberately does NOT fetch here,
 * because this runs on an unauthenticated path.
 *
 * This function never throws — any internal problem degrades to empty names
 * with `stale: false`, which makes it structurally impossible for a broken
 * cache to trigger a background-refresh storm.
 */
export async function readCachedRootFolderNames(
  env: Env
): Promise<{ names: string[]; stale: boolean }> {
  try {
    const rootId = driveRootId(env)
    if (!rootId) return { names: [], stale: true }

    const entry = await readCache(env, `drive:list:${rootId}`)
    if (!entry) return { names: [], stale: true }

    const listing = entry.data
    const raw = [
      ...(listing?.folders ?? []),
      ...(listing?.files ?? []).filter((f) => f?.mimeType === DRIVE_FOLDER_MIME),
    ].map((f) => f?.name)

    const names: string[] = []
    for (const name of raw) {
      if (typeof name !== 'string') continue
      const trimmed = name.trim()
      if (!trimmed) continue
      names.push(trimmed.slice(0, 120))
      if (names.length >= 64) break
    }

    const stale =
      names.length === 0 || Date.now() - entry.storedAt > CACHE_TTL_SECONDS * 1000

    return { names, stale }
  } catch {
    return { names: [], stale: false }
  }
}

// ---------------------------------------------------------------------------
// Lock application — files are gated for non-subscribers
// ---------------------------------------------------------------------------
function applyLock(listing: FolderListing, isSubscriber: boolean): FolderListing {
  return {
    ...listing,
    files: listing.files.map((f) => ({ ...f, locked: !isSubscriber })),
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function byName(a: DriveNode, b: DriveNode) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

function humanSize(bytes: number): string {
  if (!bytes || bytes < 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`
}

/** Classify a file into a coarse content type for the badge + icon. */
function classify(name: string, mime: string): FileType {
  const n = name.toLowerCase()
  // Content-driven categories first (match the library taxonomy).
  if (/(mock|blanc|elite|prep)/.test(n)) return 'mock'
  if (/(exam|bac|devoir|composition|assessment|sujet)/.test(n)) return 'exam'
  if (/(serie|série|exercise|exercice|td)/.test(n)) return 'exercises'
  if (/(summary|résumé|resume|fiche|synth)/.test(n)) return 'summary'
  if (/(lesson|cours|lecon|leçon|chapitre|chapter)/.test(n)) return 'lesson'
  if (/(book|livre|manuel)/.test(n)) return 'book'
  // MIME-driven fallback.
  if (mime.includes('pdf') || n.endsWith('.pdf')) return 'pdf'
  if (mime.includes('presentation') || /\.(ppt|pptx)$/.test(n)) return 'slides'
  if (mime.includes('spreadsheet') || /\.(xls|xlsx|csv)$/.test(n)) return 'sheet'
  if (mime.includes('document') || /\.(doc|docx)$/.test(n)) return 'doc'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  return 'other'
}

// ---------------------------------------------------------------------------
// Sample content (clearly labelled) — used ONLY when Drive secrets are absent
// so the library UI is fully browsable in local/dev without credentials.
// ---------------------------------------------------------------------------
interface SampleFolder {
  id: string
  name: string
  parent: string
  children?: SampleFolder[]
  files?: Array<{ name: string; size: string; modified: string }>
}

// The library starts completely empty. No auto-generated demo/placeholder
// folders or files are seeded here — real content is added later through the
// upload/Drive mechanism. This is only the fallback shape used when no Google
// Drive secrets are configured; it intentionally contains nothing.
const SAMPLE_TREE: SampleFolder = {
  id: 'root',
  name: 'Library',
  parent: '',
  children: [],
  files: [],
}

/** No demo content is generated. The archive starts empty; real files are
 *  added later through the upload/Drive mechanism. */
function bigArchiveFiles(): Array<{ name: string; size: string; modified: string }> {
  return []
}

function findSample(node: SampleFolder, id: string): SampleFolder | null {
  if (node.id === id) return node
  for (const c of node.children || []) {
    const hit = findSample(c, id)
    if (hit) return hit
  }
  return null
}

function sampleBreadcrumb(id: string): Array<{ id: string; name: string }> {
  const trail: Array<{ id: string; name: string }> = []
  let current: SampleFolder | null = findSample(SAMPLE_TREE, id)
  while (current) {
    trail.unshift({ id: current.id, name: current.id === 'root' ? 'Library' : current.name })
    if (current.parent === '') break
    current = findSample(SAMPLE_TREE, current.parent)
  }
  if (trail.length === 0) trail.push({ id: 'root', name: 'Library' })
  return trail
}

/**
 * Resolve a sample file id (e.g. "s-math-func-f0") back to its name/mime/size
 * by re-deriving the folder's file list. Used by the sample-mode viewer +
 * content endpoints so dev mode behaves like production.
 */
function sampleFileById(
  fileId: string
): { name: string; mimeType: string; size?: string; modified?: string } | null {
  const m = /^(.*)-f(\d+)$/.exec(fileId)
  if (!m) return null
  const folderId = m[1]
  const idx = Number(m[2])
  const node = findSample(SAMPLE_TREE, folderId)
  if (!node) return null
  const rawFiles = node.id === 's-archive' ? bigArchiveFiles() : node.files || []
  // rawFiles are sorted by name in the listing; ids are assigned pre-sort, so
  // reproduce the same indexing used in sampleListing (pre-sort order).
  const f = rawFiles[idx]
  if (!f) return null
  const isImage = /\.(png|jpe?g|gif|webp)$/i.test(f.name)
  return {
    name: f.name,
    mimeType: isImage ? 'image/png' : 'application/pdf',
    size: f.size,
    modified: f.modified,
  }
}

function sampleListing(folderId: string | undefined, isSubscriber: boolean): FolderListing {
  const id = folderId && folderId !== 'root' ? folderId : 'root'
  const node = findSample(SAMPLE_TREE, id) || SAMPLE_TREE

  const folders: DriveNode[] = (node.children || []).map((c) => ({
    id: c.id,
    name: c.name,
    kind: 'folder',
    locked: false,
  }))

  // The archive folder is intentionally large to exercise virtualization.
  const rawFiles = node.id === 's-archive' ? bigArchiveFiles() : node.files || []

  const files: DriveNode[] = rawFiles.map((f, i) => {
    const isImage = /\.(png|jpe?g|gif|webp)$/i.test(f.name)
    const mimeType = isImage ? 'image/png' : 'application/pdf'
    return {
      id: `${node.id}-f${i}`,
      name: f.name,
      kind: 'file',
      mimeType,
      fileType: classify(f.name, mimeType),
      size: f.size,
      modified: f.modified,
      // Sample data advertises thumbnails so the lazy-load path is exercised in
      // dev; the thumb endpoint returns a labelled placeholder for sample ids.
      hasThumb: true,
      locked: !isSubscriber,
    }
  })

  return {
    folder: { id: node.id, name: node.id === 'root' ? 'Library' : node.name, isRoot: node.id === 'root' },
    breadcrumb: sampleBreadcrumb(node.id),
    folders: folders.sort(byName),
    files: files.sort(byName),
    sample: true,
  }
}
