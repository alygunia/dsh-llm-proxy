/**
 * dsh-llm-proxy — pi-ai built-in model catalog access.
 *
 * The proxy card's model selector must stay in sync with the official DSH
 * model list. The official selector resolves models through the llm adapter
 * (dsh-llm-pi-ai), which falls back to the installed pi-ai built-in catalog
 * (`@earendil-works/pi-ai`) whenever a provider profile declares no explicit
 * `models` — e.g. the `xiaomi` profile carrying only `apiKeyEnv`, yet the
 * official list shows all six MiMo models. The same catalog supplies the
 * `baseUrl` of a route a profile names without one (`zai-coding-cn`).
 *
 * This module mirrors that fallback: `listModels` / `resolveProxyHosts` /
 * `syncRetryPolicy` read the same catalog, so the card's list and proxy
 * matching agree with the official selector. The catalog is loaded lazily
 * (dynamic import) and the read is synchronous after `ensureCatalog()`
 * settles, keeping the existing sync call paths unchanged.
 *
 * Resolution is deliberately NOT `require.resolve`: a profile installs plugins
 * into its own directory, so pi-ai is never on this module's own chain, and
 * pi-ai's exports map declares only `types` and `import` conditions — every
 * subpath is `ERR_PACKAGE_PATH_NOT_EXPORTED` to CommonJS resolution. The
 * package directory is therefore located by walking the `node_modules` chain
 * up from the host's own entry points (the profile directory, the dsh CLI
 * entry, this module, the node binary), and the catalog subpath is mapped
 * through the package's own exports map. Without this every catalog-backed
 * provider resolves to an empty host and silently cannot be proxied.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The package whose built-in catalog the official adapter falls back to. */
const PI_AI_PACKAGE = '@earendil-works/pi-ai'

/** Bare specifier of the catalog entry point. */
const PI_AI_CATALOG = `${PI_AI_PACKAGE}/providers/all`

/** The same subpath as the package's exports map spells it. */
const CATALOG_SUBPATH = './providers/all'

/** Conventional build location, used when the exports map cannot be read. */
const CATALOG_FALLBACK = ['dist', 'providers', 'all.js']

let loaded = null // { getBuiltinModels, available } once the catalog is available
let loading = null // in-flight import promise (dedupes concurrent calls)

/** Synchronous catalog read for one provider; null when not loaded yet. */
export function catalogBuiltinModels(providerId) {
  if (loaded === null) return null
  try {
    return loaded.getBuiltinModels(providerId)
  } catch {
    return []
  }
}

/** Whether the pi-ai built-in catalog actually loaded (false = degraded reads). */
export function catalogAvailable() {
  return loaded?.available === true
}

/**
 * Files to start the `node_modules` walk from, in the order they are tried:
 * the running profile, then the dsh CLI entry point, this module, and finally
 * the node binary.
 * @returns absolute paths of existing files, when known.
 */
function resolutionRoots() {
  const roots = []
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.length > 0) roots.push(join(profileDir, 'package.json'))
  if (typeof process.argv[1] === 'string' && process.argv[1].length > 0) roots.push(process.argv[1])
  try {
    roots.push(fileURLToPath(import.meta.url))
  } catch {
    /* an unreadable self URL only drops one candidate */
  }
  if (typeof process.execPath === 'string' && process.execPath.length > 0) roots.push(process.execPath)
  return roots
}

/**
 * Locate the installed pi-ai package directory.
 * @returns the absolute package directory, or null when no candidate chain has it.
 */
function findPackageDir() {
  const suffix = PI_AI_PACKAGE.split('/')
  for (const root of resolutionRoots()) {
    let dir = dirname(root)
    for (;;) {
      const candidate = join(dir, 'node_modules', ...suffix)
      if (existsSync(join(candidate, 'package.json'))) return candidate
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

/**
 * Resolve the catalog entry file through the package's own exports map, so a
 * relocated build directory keeps working.
 * @param packageDir - the located pi-ai package directory.
 * @returns the absolute catalog file path.
 */
function catalogFile(packageDir) {
  const fallback = join(packageDir, ...CATALOG_FALLBACK)
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    const exports = manifest?.exports
    const key = Object.keys(exports ?? {}).find((name) => name === CATALOG_SUBPATH
      || (name.endsWith('/*') && CATALOG_SUBPATH.startsWith(name.slice(0, -1))))
    if (key === undefined) return fallback
    const target = exports[key]?.import ?? exports[key]?.default
    if (typeof target !== 'string') return fallback
    return join(packageDir, target.replace('*', CATALOG_SUBPATH.slice(key.length - 1)))
  } catch {
    return fallback
  }
}

/**
 * Import pi-ai's catalog: this module's own chain first (a hoisted install, or
 * a deployment that adds the dependency), then the located package file.
 * @returns the loaded module, or null when no candidate answers.
 */
async function importCatalog() {
  try {
    return await import(PI_AI_CATALOG)
  } catch {
    /* not on this module chain — locate the host's copy instead */
  }
  const packageDir = findPackageDir()
  if (packageDir === null) return null
  try {
    return await import(pathToFileURL(catalogFile(packageDir)).href)
  } catch {
    return null
  }
}

/**
 * Ensure the pi-ai built-in catalog is loaded. Idempotent and safe to call
 * from any async path; never rejects (an unavailable catalog degrades to the
 * placeholder behaviour, and callers report it through
 * {@link catalogAvailable}).
 */
export async function ensureCatalog() {
  if (loaded !== null || loading !== null) return loading ?? loaded
  loading = importCatalog()
    .then((mod) => {
      loaded = typeof mod?.getBuiltinModels === 'function'
        ? { getBuiltinModels: mod.getBuiltinModels, available: true }
        : { getBuiltinModels: () => [], available: false }
      return loaded
    })
    .catch(() => {
      loaded = { getBuiltinModels: () => [], available: false }
      return loaded
    })
    .finally(() => {
      loading = null
    })
  return loading
}

/**
 * Test hook: swap the catalog face. Pass a fake `getBuiltinModels(providerId)`
 * or null/undefined to simulate an unavailable pi-ai install.
 */
export function __setCatalogForTest(getBuiltinModels) {
  loaded = getBuiltinModels === null || getBuiltinModels === undefined
    ? { getBuiltinModels: () => [], available: false }
    : { getBuiltinModels, available: true }
  loading = null
}

/** Test hook: reset module state between tests. */
export function __resetCatalogForTest() {
  loaded = null
  loading = null
}
