# DSH 无插件代理方案

## 背景

DSH 的 `llm-pi-ai` 插件（`@deepseek-ai/dsh-llm-pi-ai`）**没有内置 HTTP 代理支持**——provider 配置只有 `api`、`baseURL`、`apiKeyEnv`、`headers`、`retryPolicy`，没有 `proxyHost`/`proxyPort` 字段。

当 `opencode.ai` 等目标直连不可达时，需要代理转发。之前通过 `@superfish058/dsh-llm-proxy` 插件实现，但该插件有版本同步问题（DSH 升级后需手动更新）。本文档提供**无插件**的替代方案。

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

```bash
cat > ~/.dsh/proxy-patch.cjs << 'EOF'
const { ProxyAgent, setGlobalDispatcher } = require('undici');
setGlobalDispatcher(new ProxyAgent('http://192.168.205.176:8118'));
EOF
```

> **代理地址**：`http://192.168.205.176:8118`
> 换代理时修改此地址即可。

#### 2. 启动 DSH

```bash
NODE_OPTIONS="--require /home/liz/.dsh/proxy-patch.cjs" \
  node ~/.npm-global/bin/dsh web
```

#### 3. 验证

```bash
# 测试 fetch 是否走代理
NODE_OPTIONS="--require /home/liz/.dsh/proxy-patch.cjs" \
  node -e "fetch('https://opencode.ai/zen/go/v1/models').then(r => console.log('HTTP', r.status))"
```

预期输出：`HTTP 200`

### 依赖验证

```bash
# undici 在 DSH 运行时中可用
ls ~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/undici/package.json
# → 存在即可用

# Node.js 版本（undici 内置于 Node 18+）
node --version
# → v24.18.0
```

## 方案对比

| 方案 | 原理 | 有效性 | 备注 |
|------|------|--------|------|
| 环境变量 `HTTPS_PROXY` | undici 读环境变量 | ❌ 无效 | Node.js 原生 fetch 不读 |
| `NODE_OPTIONS` + `ProxyAgent` | 替换全局 dispatcher | ✅ 有效 | 推荐 |
| `NODE_OPTIONS` + `EnvHttpProxyAgent` | 读环境变量 + 替换 dispatcher | ✅ 有效 | 需配合环境变量 |
| `@superfish058/dsh-llm-proxy` 插件 | 插件层拦截 | ✅ 有效 | 有版本同步问题 |

## 注意事项

- `NODE_OPTIONS` 只影响当前 Node.js 进程，不影响系统其他进程
- 代理地址硬编码在 `proxy-patch.cjs` 中，换代理需修改脚本
- 如果 DSH 升级后 `undici` 版本变化，需重新验证兼容性
- 此方案只代理 `globalThis.fetch`，不影响 `child_process` 等其他方式的网络请求

## 长期改进方向

1. **DSH 原生支持**：让 `llm-pi-ai` 的 provider 配置支持 `proxyUrl` 字段
2. **undici 环境变量**：Node.js 未来版本可能让原生 fetch 读取 `HTTPS_PROXY`
3. **DSH 暴露 `DSH_INSTALL_DIR`**：让插件能自动定位运行时依赖，避免版本同步问题
