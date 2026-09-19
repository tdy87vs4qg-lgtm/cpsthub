// ============================================================================
// تيسير — Route-protection middleware (SERVER-SIDE) — Task 4B
//
// Thin Hono middlewares layered directly on Part A's session-validation helper
// (getSessionUser → validateSession, which itself re-checks status + silently
// renews). EVERY decision here is made on the server from the validated
// session; nothing is ever read from or trusted about the client beyond the
// opaque httpOnly cookie. The resolved user is stashed on the Hono context so
// downstream handlers reuse it without re-validating.
//
// Exposed guards:
//   • requireAuth               — 401 unless a valid, live session exists.
//   • requireRole('admin'|…)    — 401 if unauthenticated, 403 if wrong role.
//   • requireActiveSubscriber   — the file-access gate. NOW A PASS-THROUGH:
//                                 the library is deliberately public, so it
//                                 admits every visitor (see its own note).
//
// Because validateSession already returns null for suspended accounts AND for
// sessions that were revoked (deactivation deletes them from D1+KV), a just-
// deactivated user is rejected here on their very next request. No extra check
// needed — the guard inherits that guarantee from the session engine.
// ============================================================================

import type { Context, Next } from 'hono'
import type { Env } from './drive'
import { getSessionUser, type SessionUser } from './auth'
import type { Role } from './users'

// Typed context variables so handlers can read the authenticated user safely.
export type AuthVars = { user: SessionUser }
export type AuthContext = Context<{ Bindings: Env; Variables: AuthVars }>

/** Standard JSON error envelope so the client always gets a clear reason. */
function deny(
  c: Context,
  status: 401 | 403,
  error: string,
  message: string
) {
  return c.json({ ok: false, error, message }, status)
}

/**
 * requireAuth — rejects (401) unless the request carries a valid, live session.
 * On success the validated user is placed on c.var.user for downstream use.
 */
export async function requireAuth(c: AuthContext, next: Next) {
  const user = await getSessionUser(c)
  if (!user) {
    return deny(c, 401, 'UNAUTHENTICATED', 'You must be signed in to do that.')
  }
  // Defence in depth: validateSession already filters suspended accounts, but
  // we assert it here too so the guarantee is local + obvious.
  if (user.status !== 'active') {
    return deny(c, 403, 'ACCOUNT_SUSPENDED', 'This account has been deactivated.')
  }
  c.set('user', user)
  await next()
}

/**
 * requireRole(role) — must be authenticated AND hold the given role.
 * 401 when not signed in, 403 when signed in but lacking the role. Admins are
 * NOT auto-granted other roles here; pass 'admin' explicitly for admin gates.
 */
export function requireRole(role: Role) {
  return async (c: AuthContext, next: Next) => {
    const user = await getSessionUser(c)
    if (!user) {
      return deny(c, 401, 'UNAUTHENTICATED', 'You must be signed in to do that.')
    }
    if (user.status !== 'active') {
      return deny(c, 403, 'ACCOUNT_SUSPENDED', 'This account has been deactivated.')
    }
    if (user.role !== role) {
      return deny(
        c,
        403,
        'FORBIDDEN',
        role === 'admin'
          ? 'Administrator privileges are required.'
          : `This action requires the '${role}' role.`
      )
    }
    c.set('user', user)
    await next()
  }
}

/**
 * requireActiveSubscriber — THE FILE-ACCESS GATE, NOW FULLY OPEN.
 *
 * The library is public on purpose: the platform is free and has no visitor
 * accounts, so there is no subscription, approval or sign-in left to check
 * before serving file content. This middleware consequently admits EVERY
 * request — anonymous or not — and simply calls next().
 *
 * It is intentionally kept as a middleware rather than removed so that the
 * file-access decision still has exactly one home: every content route and the
 * viewer page continue to funnel through here, which is where a future gate
 * (e.g. an abuse guard) would be reintroduced without re-plumbing callers.
 *
 * No user is placed on the context: there may not be one, and every downstream
 * handler behind this guard serves the same bytes to everybody regardless.
 * (requireAuth / requireRole are UNCHANGED and still protect the admin area.)
 */
export async function requireActiveSubscriber(_c: AuthContext, next: Next) {
  await next()
}
