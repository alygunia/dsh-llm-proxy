# DSH 无插件代理方案

## 背景

DSH 的 `llm-pi-ai` 插件（`@deepseek-ai/dsh-llm-pi-ai`）**没有内置 HTTP 代理支持**——provider 配置只有 `api`、`baseURL`、`apiKeyEnv`、`headers`、`retryPolicy`，没有 `proxyHost`/`proxyPort` 字段。

当目标 API 直连不可达时，需要代理转发。本文档提供**不依赖代理插件**的替代方案。

## 核心问题

pi-ai 的 provider 实现使用 `globalThis.fetch`（Node.js 原生 fetch / undici）。

**Node.js 原生 `fetch` 不读取 `HTTPS_PROXY`/`HTTP_PROXY` 环境变量**——这是与 `curl`、`node-fetch`、`got` 等库的关键区别。

因此：
- ❌ 环境变量方案（`export HTTPS_PROXY=...`）**无效**
- ✅ undici `setGlobalDispatcher` 方案**有效**

## 方案：NODE_OPTIONS + undici ProxyAgent

### 原理

1. undici 的 `ProxyAgent` 创建代理 dispatcher
2. `setGlobalDispatcher` 替换 undici 的全局 dispatcher
3. 之后所有 `globalThis.fetch` 调用自动走代理

### 步骤

#### 1. 创建代理补丁脚本

把下面的脚本保存为任意路径，例如 `/path/to/proxy-patch.cjs`：

```js
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
```

> **为什么要用绝对路径找 undici？**
> 直接写 `require('undici')` 时，Node.js 从补丁文件所在目录的 `node_modules`
> 查找，那里通常没有 `undici`。脚本因此按以下顺序尝试：`DSH_INSTALL_DIR`
> → 从 DSH 入口 `<DSH_INSTALL_DIR>/lib/bin.js` 反推 → 裸 `undici`。

> **为什么要判断入口？**
> `NODE_OPTIONS` 会被子进程继承。如果无条件打补丁，DSH 派生的 `npm` 等
> Node 子进程也会加载本脚本，造成递归甚至死循环。脚本只在
> `process.argv[1]` 指向 `<DSH_INSTALL_DIR>/lib/bin.js` 时生效。

#### 2. 启动 DSH

```bash
NODE_OPTIONS="--require /path/to/proxy-patch.cjs" \
DSH_PROXY_URL="http://proxy.example.com:8118" \
dsh web
```

> **建议把 `NODE_OPTIONS` 写在命令前而不是 `export` 到全局**，这样只影响
> 本次 DSH 进程。即使误导出到全局，脚本的入口判断也会让其他 Node 进程
> 保持原样。

#### 3. 验证

```bash
# 强制全局模式，验证代理链路是否可用
NODE_OPTIONS="--require /path/to/proxy-patch.cjs" \
DSH_PROXY_PATCH_ALL=1 \
DSH_PROXY_URL="http://proxy.example.com:8118" \
node -e "fetch('https://example.com/health').then(r => console.log('HTTP', r.status))"
# 预期输出：HTTP 200
```

| 环境变量 | 必填 | 说明 |
|----------|------|------|
| `DSH_PROXY_URL` | 是 | HTTP 代理地址，如 `http://proxy.example.com:8118` |
| `DSH_INSTALL_DIR` | 否 | DSH 包安装目录，默认自动探测 |
| `DSH_PROXY_PATCH_ALL` | 否 | 设为 `1` 时对所有 Node 进程生效（仅用于验证） |

#### 4.（可选）确认 DSH 安装目录

DSH 运行时自带 `undici`。脚本默认自动探测，如需手动指定：

```bash
# 方式 A：从 dsh 命令的软链接反推
DSH_INSTALL_DIR="$(cd "$(dirname "$(readlink -f "$(command -v dsh)")")/.." && pwd)"

# 方式 B：从 npm 全局根目录推导
DSH_INSTALL_DIR="$(npm root -g)/@deepseek-ai/dsh"

# 验证
ls "$DSH_INSTALL_DIR/node_modules/undici/package.json"
```

### 依赖验证

```bash
# undici 在 DSH 运行时中可用
ls "$DSH_INSTALL_DIR/node_modules/undici/package.json"
# → 存在即可用

# Node.js 版本（undici 内置于 Node 18+）
node --version
```

## 方案对比

| 方案 | 原理 | 有效性 | 备注 |
|------|------|--------|------|
| 环境变量 `HTTPS_PROXY` | undici 读环境变量 | ❌ 无效 | Node.js 原生 fetch 不读 |
| `NODE_OPTIONS` + `ProxyAgent` | 替换全局 dispatcher | ✅ 有效 | 推荐 |
| `NODE_OPTIONS` + `EnvHttpProxyAgent` | 读环境变量 + 替换 dispatcher | ✅ 有效 | 需配合环境变量 |
| 第三方代理插件 | 插件层拦截 | ✅ 有效 | 有版本同步问题 |

## 注意事项

- **不要全局 `export NODE_OPTIONS`**：它会被子进程继承。本方案脚本已加入
  入口判断来兜底，但写成命令行前缀更清晰
  （`NODE_OPTIONS="..." DSH_PROXY_URL="..." dsh web`）
- **不要在补丁里 `spawn`/`exec` Node 子进程**：子进程会继承 `NODE_OPTIONS`
  并再次加载补丁，可能递归。本方案脚本不 spawn 任何进程
- 代理地址通过 `DSH_PROXY_URL` 传入，换代理只需改环境变量
- 如果 DSH 升级后 `undici` 版本变化，需重新验证兼容性
- 此方案只代理 `globalThis.fetch`，不影响 `child_process` 等其他方式的网络请求

## 故障排查

### 症状：`Error: Cannot find module 'undici'`

**原因**：补丁里写了裸 `require('undici')`，而补丁所在目录的 `node_modules` 里没有。

**解决**：使用本方案脚本（自动按 `DSH_INSTALL_DIR` → DSH 入口反推 → 裸 `undici`
顺序查找），或显式设置 `DSH_INSTALL_DIR`。

### 症状：命令卡住不返回 / 进程数量暴增

**原因**：补丁里 `spawn`/`exec` 了 Node 子进程，子进程继承 `NODE_OPTIONS` 后
再次加载补丁，形成递归。

**解决**：不要在补丁里 spawn 子进程；本方案脚本已规避。

### 症状：其他 Node 命令报 `DSH_PROXY_URL is required`

**原因**：`NODE_OPTIONS` 被导出到全局，且补丁未做入口判断。

**解决**：使用本方案脚本（非 DSH 入口时自动 no-op），或把 `NODE_OPTIONS`
写成命令前缀而不是 `export`。

## 长期改进方向

1. **DSH 原生支持**：让 `llm-pi-ai` 的 provider 配置支持 `proxyUrl` 字段
2. **undici 环境变量**：Node.js 未来版本可能让原生 fetch 读取 `HTTPS_PROXY`
3. **DSH 暴露安装目录环境变量**：让插件能自动定位运行时依赖，避免版本同步问题
