// ============================================================================
// تيسير — Auth helper (SERVER-SIDE)
//
// This is the single seam the rest of the app talks to for "who is this
// request?". Task 3 shipped an interim version that just checked for the
// presence of a cookie; Task 4A replaces it with REAL session validation
// backed by D1 (source of truth) + KV (hot-path cache) via src/lib/session.ts.
//
// Public surface (kept stable so later parts + existing callers plug in):
//   • SESSION_COOKIE                    — cookie name
//   • getSessionUser(c)  → SessionUser|null   (validates + silently renews)
//   • isSubscriber(c)    → boolean            (any live, active account)
//   • setSessionCookie(c, token, exp)         — persistent (~1yr) httpOnly cookie
//   • clearSessionCookie(c)                   — logout
//   • getSessionSecret(env)                   — reads SESSION_SECRET from env
//
// SECURITY: no secrets are hardcoded. The session secret is read from the env
// binding SESSION_SECRET only. Cookies are httpOnly + SameSite=Lax and Secure
// in production (auto-detected from the request scheme so local http dev works).
//
// NOTE (scope): This part builds the auth FOUNDATION only — data model, login,
// persistent session, validation helper, logout. Role-based route protection
// (Part B) and file-access gating (Part C) are intentionally NOT here.
// `isSubscriber` still means "has a live, active session"; Part C will layer
// the richer file-access rules on top of `getSessionUser`.
// ============================================================================

import type { Context, Env as HonoEnv } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Env } from './drive'
import {
  validateSession,
  SESSION_TTL_SECONDS,
  type SessionUser,
} from './session'

/** Name of the session cookie (httpOnly, Secure in prod, SameSite=Lax). */
export const SESSION_COOKIE = 'bac_session'

/**
 * Name of the DURABLE device-id cookie (httpOnly, Secure in prod, SameSite=Lax,
 * ~1yr). This is the PRIMARY, server-owned device signal for single-device
 * binding: because it is httpOnly it is NOT wiped when a page clears
 * localStorage, and it survives ITP/private-mode localStorage eviction that
 * used to regenerate the client fingerprint and cause a false DEVICE_BLOCKED.
 * localStorage remains only a secondary hint (see AuthShell.getDeviceFingerprint).
 */
export const DEVICE_COOKIE = 'bac_device'

/** One year, in seconds — shared lifetime for the session + device cookies. */
export const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365

export type { SessionUser } from './session'

/**
 * Read the session secret from the environment. Never hardcoded. In dev, if it
 * is unset we fall back to a clearly-labelled ephemeral value so the app still
 * boots — but sessions won't survive a secret change, which is the desired
 * "please configure me" behaviour rather than a silent insecure default.
 */
export function getSessionSecret(env: Env): string {
  return env.SESSION_SECRET || 'dev-insecure-session-secret-set-SESSION_SECRET'
}

/**
 * Resolve the authenticated user for this request, or null.
 * Validates the cookie against KV/D1 and silently renews the session's expiry.
 * This is the helper later parts (route protection, file gating) reuse.
 */
export async function getSessionUser<E extends HonoEnv = { Bindings: Env }>(
  c: Context<E>
): Promise<SessionUser | null> {
  const token = getCookie(c, SESSION_COOKIE)
  const secret = getSessionSecret((c.env as unknown) as Env)
  return validateSession((c.env as unknown) as Env, token, secret)
}

/**
 * Whether the current request belongs to a live, active account.
 * (Task 3's callers used this as "is a subscriber?"; it now reflects a REAL
 * validated session instead of mere cookie presence.)
 */
export async function isSubscriber<E extends HonoEnv = { Bindings: Env }>(
  c: Context<E>
): Promise<boolean> {
  const user = await getSessionUser(c)
  return user !== null && user.status === 'active'
}

/**
 * Whether the current request may OPEN FILES.
 *
 * Under the open-signup + admin-approval model, merely having a live session is
 * no longer enough to unlock files: a self-registered account can log in and
 * browse everything, but every file stays locked until an admin approves it.
 * File access therefore requires an active account that is EITHER an admin
 * (always entitled) OR an approved subscriber. This is the single seam the
 * `locked` flag and the content guard both key off.
 */
export async function isApproved<E extends HonoEnv = { Bindings: Env }>(
  c: Context<E>
): Promise<boolean> {
  const user = await getSessionUser(c)
  if (!user || user.status !== 'active') return false
  return user.role === 'admin' || user.approved === true
}

/**
 * Robustly decide whether the response cookies must carry the `Secure` flag.
 *
 * Behind the Cloudflare proxy the Worker often sees the request URL as plain
 * `http:` even though the browser↔edge hop is HTTPS, so relying solely on
 * `new URL(c.req.url).protocol === 'https:'` (the old logic) would DROP the
 * Secure flag in production — and some browsers then refuse to persist / send
 * the cookie reliably, contributing to the "logged out on return" symptom.
 *
 * We therefore detect https from, in priority order:
 *   1. The forwarded-proto headers Cloudflare sets (`x-forwarded-proto`,
 *      `cf-visitor: {"scheme":"https"}`).
 *   2. A configured `SITE_ORIGIN` that is https (authoritative for prod).
 *   3. The request URL scheme (covers direct https + local http dev).
 * Local `http://localhost` dev correctly resolves to NOT secure, so the cookie
 * still works there.
 *
 * Exported (was module-private) so other server-side cookie writers reuse the
 * exact same detection instead of re-implementing it.
 */
export function isSecureRequest(c: Context<{ Bindings: Env }>): boolean {
  const xfProto = (c.req.header('x-forwarded-proto') || '').split(',')[0]?.trim().toLowerCase()
  if (xfProto) return xfProto === 'https'

  const cfVisitor = c.req.header('cf-visitor') || ''
  if (cfVisitor.includes('"scheme":"https"')) return true
  if (cfVisitor.includes('"scheme":"http"')) return false

  const origin = (c.env as unknown as Env).SITE_ORIGIN
  if (origin) {
    try {
      return new URL(origin).protocol === 'https:'
    } catch {
      /* ignore malformed origin */
    }
  }

  try {
    return new URL(c.req.url).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Set the PERSISTENT session cookie (~1 year). It survives refresh, tab close
 * and full browser restart, and is silently renewed server-side on each use —
 * there is no inactivity/idle logout. httpOnly so JS can't read it; SameSite
 * Lax so it rides top-level navigations; Secure whenever served over https
 * (robustly detected via forwarded/proto headers + SITE_ORIGIN, not just the
 * proxied request scheme). Both a long Max-Age AND a matching absolute Expires
 * are sent so mobile browsers (notably iOS Safari) keep the cookie for the full
 * window regardless of which attribute they honour.
 */
export function setSessionCookie(
  c: Context<{ Bindings: Env }>,
  token: string,
  expiresAt: string
): void {
  const secure = isSecureRequest(c)
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    // Absolute expiry ~1yr out; combined with server-side silent renewal the
    // session effectively never lapses for an active user.
    expires: new Date(expiresAt),
    maxAge: SESSION_TTL_SECONDS,
  })
}

/**
 * Re-issue (slide forward) the session cookie for a request that has already
 * been confirmed to carry a VALID, live session. Mirrors the server-side
 * sliding session so the cookie's absolute Expires/Max-Age is pushed ~1yr out
 * again on active use — fixing the "cookie is never re-issued during normal
 * use" defect where the absolute Expires stayed frozen at login time and
 * lifetime-trimming browsers eventually lost it.
 *
 * IMPORTANT: only call this once a live session is confirmed. It never mints a
 * new server session — it just refreshes the cookie's client-side lifetime
 * using the same opaque token the browser already sent.
 */
export function reissueSessionCookie(
  c: Context<{ Bindings: Env }>,
  token: string
): void {
  const expiresAt = new Date(Date.now() + COOKIE_MAX_AGE_SECONDS * 1000).toISOString()
  setSessionCookie(c, token, expiresAt)
}

/** Clear the session cookie (logout). Server-side invalidation is separate. */
export function clearSessionCookie(c: Context<{ Bindings: Env }>): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

// ---------------------------------------------------------------------------
// Durable device-id cookie (single-device binding, primary signal)
//
// The device fingerprint used by single-device binding must be STABLE across
// reloads, private mode and localStorage eviction. localStorage alone is
// volatile (ITP / storage pressure wipe it), which regenerated the fingerprint
// and caused returning users to hit DEVICE_BLOCKED. To fix this the server owns
// a durable, httpOnly device-id cookie set on first login: JS cannot clear it,
// it rides every request, and it becomes the primary fingerprint source, with
// the client-computed value only a secondary hint.
// ---------------------------------------------------------------------------

/** Read the durable device-id cookie, or undefined when none is set yet. */
export function getDeviceCookie(c: Context<{ Bindings: Env }>): string | undefined {
  const v = getCookie(c, DEVICE_COOKIE)
  return v && v.length >= 8 ? v : undefined
}

/**
 * Ensure a durable device-id cookie exists, returning its value. If the request
 * already carries one it is re-issued (sliding its ~1yr lifetime forward) and
 * returned unchanged so the device identity is STABLE. Otherwise a fresh opaque
 * id is minted, set, and returned. httpOnly + Secure(prod) + SameSite=Lax so it
 * survives refresh/return and cannot be read or wiped by page JS.
 */
export function ensureDeviceCookie(c: Context<{ Bindings: Env }>): string {
  const existing = getDeviceCookie(c)
  const id = existing || 'dev_' + crypto.randomUUID().replace(/-/g, '')
  const secure = isSecureRequest(c)
  setCookie(c, DEVICE_COOKIE, id, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    expires: new Date(Date.now() + COOKIE_MAX_AGE_SECONDS * 1000),
    maxAge: COOKIE_MAX_AGE_SECONDS,
  })
  return id
}
