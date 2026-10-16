# DSH 升级后同步 profile 里 pi-ai 版本的操作说明

## 背景

`dsh-llm-proxy` 插件通过 `import("@earendil-works/pi-ai/providers/all")` 加载 pi-ai 内置模型 catalog，用于：

- 动态显示 provider 的全部模型（如某个 provider 的全部内置模型）
- 解析无显式 `baseURL` 的 provider 的 host（用于代理路由）

pi-ai 包位于 **DSH 运行时**（`<DSH_INSTALL_DIR>/node_modules/@earendil-works/pi-ai`），**不在 profile 的 `node_modules` 里**。插件的 `findPackageDir` 无法自动定位到 DSH 运行时（`process.execPath` 是 node 二进制，`process.argv[1]` 是 symlink，向上都找不到 DSH 安装目录），所以需要在 **profile 里也装一份 pi-ai**，让 `import()` 能从 profile 目录解析成功。

**问题**：profile 里的 pi-ai 版本是独立的。DSH 运行时升级时如果 pi-ai 也升级了，profile 里的版本会落后，导致模型列表和行为不一致。

## 当前配置

| 项 | 值 |
|----|-----|
| profile 目录 | `<PROFILE_DIR>`（如 `~/.dsh/profiles/<name>`） |
| 包管理器 | pnpm |
| pi-ai 依赖 | `"@earendil-works/pi-ai": "^0.x.y"`（范围版本，自动取兼容范围内最新） |
| DSH 运行时 pi-ai | `<DSH_INSTALL_DIR>/node_modules/@earendil-works/pi-ai` |

## 操作步骤

### 1. 确认 DSH 运行时里 pi-ai 的新版本

DSH 升级后，先查看运行时里 pi-ai 的版本：

```bash
DSH_INSTALL_DIR="$(npm root -g)/@deepseek-ai/dsh"
node -e "console.log(require('$DSH_INSTALL_DIR/node_modules/@earendil-works/pi-ai/package.json').version)"
```

记下版本号（例如 `0.90.0`）。

### 2. 更新 profile 里的 pi-ai 依赖版本

编辑 `<PROFILE_DIR>/package.json`，把 `@earendil-works/pi-ai` 的版本范围改为覆盖运行时版本：

```json
{
  "dependencies": {
    "@earendil-works/pi-ai": "^0.90.0"
  }
}
```

**规则**：

- 如果运行时版本是 `0.90.0`，profile 里写 `^0.90.0`（覆盖 0.90.x）
- 如果运行时版本跨了 major（如 `1.0.0`），profile 里写 `^1.0.0`
- 始终保持 profile 的版本范围 **包含** 运行时版本

### 3. 安装/更新依赖

在 profile 目录用 pnpm 安装：

```bash
cd <PROFILE_DIR>
pnpm install
```

**如果 pnpm 直连 npm registry 不通**，用代理：

```bash
cd <PROFILE_DIR>
https_proxy=<PROXY_URL> http_proxy=<PROXY_URL> pnpm install
```

### 4. 验证版本一致

确认 profile 里安装的 pi-ai 版本和 DSH 运行时一致：

```bash
# profile 里的版本
node -e "console.log(require('<PROFILE_DIR>/node_modules/@earendil-works/pi-ai/package.json').version)"

# DSH 运行时的版本
node -e "console.log(require('<DSH_INSTALL_DIR>/node_modules/@earendil-works/pi-ai/package.json').version)"
```

两个版本号应该一致（或在兼容范围内）。

### 5. 重启 DSH

```bash
# 停止当前 dsh web
pkill -f "dsh web"

# 重新启动
dsh web
```

## 验证 catalog 加载成功

重启后，确认插件能加载 pi-ai catalog：

```bash
cd <PROFILE_DIR>
node -e '
(async () => {
  const mod = await import("@earendil-works/pi-ai/providers/all");
  const models = mod.getBuiltinModels("<PROVIDER_ID>");
  console.log("模型数:", models.length);
  console.log("前 5 个:", models.slice(0,5).map(m=>m.id).join(", "));
})();
'
```

应输出该 provider 在 pi-ai 新版本里的模型数量。

## 故障排查

### 症状：模型列表不更新 / 代理路由失效

**可能原因**：

1. profile 里 pi-ai 版本落后于 DSH 运行时
2. profile 里没装 pi-ai（`node_modules/@earendil-works/pi-ai` 不存在）

**解决**：

- 执行上面 1-5 步
- 确认 `<PROFILE_DIR>/node_modules/@earendil-works/pi-ai` 存在
- 确认版本和 DSH 运行时一致

### 症状：pnpm install 卡住 / ETIMEDOUT

**原因**：npm registry 直连不通

**解决**：

- 用代理：`https_proxy=<PROXY_URL> http_proxy=<PROXY_URL> pnpm install`
- 或换 registry：`pnpm install --registry=<REGISTRY_URL>`（配合代理）

## 长期改进方向（需要改插件源码）

当前方案需要在 profile 里维护一份 pi-ai 依赖，DSH 升级后要手动同步。更彻底的解法是让插件的 `findPackageDir` 能自动定位 DSH 运行时里的 pi-ai，这样 profile 里就不需要装 pi-ai 了。

**障碍**：

- `process.execPath` 是 node 二进制，向上找不到 DSH 安装目录
- `process.argv[1]` 是 `bin/dsh` symlink，向上也找不到
- `import.meta.url` 是插件自身路径（在 profile 里），向上找不到 DSH 运行时

**可能的改进**：

1. DSH 运行时暴露一个环境变量（如 `DSH_INSTALL_DIR`），指向 DSH 包的实际安装目录
2. 插件 `findPackageDir` 增加从该环境变量找 pi-ai 的逻辑
3. 这样 profile 里就不需要装 pi-ai，版本天然和 DSH 运行时一致

## 占位符说明

| 占位符 | 说明 | 示例 |
|--------|------|------|
| `<DSH_INSTALL_DIR>` | DSH 包安装目录 | `/usr/lib/node_modules/@deepseek-ai/dsh` |
| `<PROFILE_DIR>` | DSH profile 目录 | `~/.dsh/profiles/<name>` |
| `<PROVIDER_ID>` | provider 标识 | `example-provider` |
| `<PROXY_URL>` | HTTP 代理地址 | `http://proxy.example.com:8118` |
| `<REGISTRY_URL>` | npm registry 地址 | `https://registry.npmjs.org` |

## 参考

- 插件 catalog 加载逻辑：`lib/catalog.js`（`importCatalog` / `findPackageDir` / `resolutionRoots`）
