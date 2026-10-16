/**
 * DSH proxy preload patch.
 *
 * Node.js native `fetch` (undici) does not honor HTTPS_PROXY/HTTP_PROXY.
 * This preload script installs a global undici dispatcher so every
 * `globalThis.fetch` call — including pi-ai provider requests — goes
 * through the given HTTP proxy.
 *
 * Usage:
 *   NODE_OPTIONS="--require /path/to/proxy-patch.cjs" \
 *   DSH_PROXY_URL="http://proxy.example.com:8118" \
 *   dsh web
 *
 * Environment:
 *   DSH_PROXY_URL      (required) HTTP proxy URL.
 *   DSH_INSTALL_DIR    (optional) DSH package directory. Auto-detected when unset.
 *   DSH_PROXY_PATCH_ALL (optional) "1" forces the patch in every Node process,
 *                       not just the DSH entry point.
 *
 * Notes:
 *   Because NODE_OPTIONS is inherited by child processes, this script is a
 *   no-op unless the current process is the DSH entry point. That prevents
 *   recursion (e.g. `npm` spawned by DSH) and avoids affecting unrelated
 *   Node commands.
 */

const path = require('node:path');

const DSH_BIN_RE = /[/\\]@deepseek-ai[/\\]dsh[/\\]lib[/\\]bin\.js$/;

const entry = process.argv[1] ?? '';
const isDshEntry = DSH_BIN_RE.test(entry);
const forceAll = process.env.DSH_PROXY_PATCH_ALL === '1';

// Not the DSH entry point: leave the process untouched.
if (!isDshEntry && !forceAll) {
  return;
}

const proxyUrl = process.env.DSH_PROXY_URL;
if (!proxyUrl) {
  throw new Error(
    'proxy-patch.cjs: DSH_PROXY_URL is required, e.g. DSH_PROXY_URL="http://proxy.example.com:8118"',
  );
}

function candidateUndiciPaths() {
  const candidates = [];

  // 1. Explicit override.
  if (process.env.DSH_INSTALL_DIR) {
    candidates.push(path.join(process.env.DSH_INSTALL_DIR, 'node_modules', 'undici'));
  }

  // 2. Derive from the DSH entry point: <DSH_INSTALL_DIR>/lib/bin.js
  if (isDshEntry) {
    const dshInstallDir = path.dirname(path.dirname(entry));
    candidates.push(path.join(dshInstallDir, 'node_modules', 'undici'));
  }

  // 3. Bare specifier: works when this file lives inside the DSH tree.
  candidates.push('undici');

  return candidates;
}

let undici;
const failures = [];
for (const candidate of candidateUndiciPaths()) {
  try {
    undici = require(candidate);
    break;
  } catch (error) {
    failures.push(`${candidate}: ${error.message}`);
  }
}

if (!undici) {
  throw new Error(
    'proxy-patch.cjs: cannot locate the undici package. Set DSH_INSTALL_DIR to the DSH package directory.\n' +
      failures.join('\n'),
  );
}

const { ProxyAgent, setGlobalDispatcher } = undici;
setGlobalDispatcher(new ProxyAgent(proxyUrl));
