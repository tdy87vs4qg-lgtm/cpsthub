#!/usr/bin/env node
// ============================================================================
// تيسير — .env → .dev.vars synchroniser
//
// The single source of truth for local runtime values is `.env`. Wrangler
// (`wrangler pages dev`) and the @hono/vite-dev-server Cloudflare adapter read
// their Worker `env` bindings from `.dev.vars`, so this tiny script projects
// the relevant keys out of `.env` into `.dev.vars`. It runs automatically
// before `dev`/`build` (see package.json `predev` / `prebuild`) so the app
// works out of the box with zero manual steps — the code effectively reads the
// values from `.env`.
//
// Only server-side, non-browser keys are copied. Values are NEVER logged.
// ============================================================================
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = join(root, '.env')
const devVarsPath = join(root, '.dev.vars')

// Keys projected from .env into the Worker dev bindings (.dev.vars).
//
// GOOGLE_SERVICE_ACCOUNT_JSON is the PREFERRED Drive credential (it lets the
// app read PRIVATE Drive files); GOOGLE_API_KEY remains as a fallback. Both are
// copied verbatim and NEVER logged.
const KEYS = [
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_API_KEY',
  'DRIVE_FOLDER_ID',
  'SECONDARY_DRIVE_FOLDER_ID',
  'SITE_ORIGIN',
  'SESSION_SECRET',
  'ADMIN_SEED_EMAIL',
  'ADMIN_SEED_PASSWORD',
]

if (!existsSync(envPath)) {
  console.warn('[sync-env] no .env found — skipping (.dev.vars left untouched)')
  process.exit(0)
}

/** Minimal, dependency-free .env parser (KEY=VALUE, ignores # comments). */
function parseEnv(text) {
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

const env = parseEnv(readFileSync(envPath, 'utf8'))

const header = [
  '# AUTO-GENERATED from .env by scripts/sync-env.mjs — do not edit by hand.',
  '# `.env` is the source of truth; this file feeds `wrangler pages dev`.',
  '# Server-side only — these values are NEVER sent to the browser.',
  '',
]

const lines = []
for (const key of KEYS) {
  const val = env[key]
  if (val === undefined || val === '') continue
  // `.dev.vars` is line-oriented: a value containing real newlines would break
  // parsing. The service-account JSON is stored as a single line (its PEM keeps
  // `\n` as a two-character escape), so collapse any stray newlines defensively.
  lines.push(`${key}=${val.replace(/\r?\n/g, '\\n')}`)
}

writeFileSync(devVarsPath, header.concat(lines).join('\n') + '\n', 'utf8')
console.log(`[sync-env] wrote ${lines.length} keys to .dev.vars from .env`)
