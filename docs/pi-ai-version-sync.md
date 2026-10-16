# DSH 升级后同步 profile 里 pi-ai 版本的操作说明

## 背景

`dsh-llm-proxy` 插件通过 `import("@earendil-works/pi-ai/providers/all")` 加载 pi-ai 内置模型 catalog，用于：
- 动态显示 provider 的全部模型（如 `opencode-go` 的 30 个模型）
- 解析无显式 `baseURL` 的 provider 的 host（用于代理路由）

pi-ai 包位于 **DSH 运行时**（`~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai`），**不在 profile 的 `node_modules` 里**。插件的 `findPackageDir` 无法自动定位到 DSH 运行时（`process.execPath` 是 node 二进制，`process.argv[1]` 是 symlink，向上都找不到 DSH 安装目录），所以需要在 **profile 里也装一份 pi-ai**，让 `import()` 能从 profile 目录解析成功。

**问题**：profile 里的 pi-ai 版本是独立的。DSH 运行时升级时如果 pi-ai 也升级了，profile 里的版本会落后，导致模型列表和行为不一致。

## 当前配置

- **profile 目录**：`~/.dsh/profiles/web`
- **包管理器**：pnpm
- **pi-ai 依赖**：`"@earendil-works/pi-ai": "^0.87.1"`（范围版本，npm/pnpm 自动取兼容范围内最新）
- **DSH 运行时 pi-ai 位置**：`~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai`

## 操作步骤

### 1. 确认 DSH 运行时里 pi-ai 的新版本

DSH 升级后，先查看运行时里 pi-ai 的版本：

```bash
node -e 'console.log(require("/home/liz/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/package.json").version)'
```

记下版本号（例如 `0.90.0`）。

### 2. 更新 profile 里的 pi-ai 依赖版本

编辑 `~/.dsh/profiles/web/package.json`，把 `@earendil-works/pi-ai` 的版本范围改为覆盖运行时版本：

```json
{
  "dependencies": {
    "@earendil-works/pi-ai": "^0.90.0",
    ...
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
cd ~/.dsh/profiles/web
pnpm install
```

**如果 pnpm 直连 npm registry 不通**（之前确认 `registry.npmmirror.com` ETIMEDOUT），用代理：

```bash
cd ~/.dsh/profiles/web
https_proxy=http://192.168.205.176:8118 http_proxy=http://192.168.205.176:8118 pnpm install --registry=https://registry.npmmirror.com
```

### 4. 验证版本一致

确认 profile 里安装的 pi-ai 版本和 DSH 运行时一致：

```bash
# profile 里的版本
node -e 'console.log(require("/home/liz/.dsh/profiles/web/node_modules/@earendil-works/pi-ai/package.json").version)'

# DSH 运行时的版本
node -e 'console.log(require("/home/liz/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/package.json").version)'
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
cd ~/.dsh/profiles/web
node -e '
(async () => {
  const mod = await import("@earendil-works/pi-ai/providers/all");
  const models = mod.getBuiltinModels("opencode-go");
  console.log("opencode-go 模型数:", models.length);
  console.log("前 5 个:", models.slice(0,5).map(m=>m.id).join(", "));
})();
'
```

应输出 30 个模型（或 pi-ai 新版本里的数量）。

## 故障排查

### 症状：模型列表不更新 / 代理路由失效

**可能原因**：
1. profile 里 pi-ai 版本落后于 DSH 运行时
2. profile 里没装 pi-ai（`node_modules/@earendil-works/pi-ai` 不存在）

**解决**：
- 执行上面 1-5 步
- 确认 `~/.dsh/profiles/web/node_modules/@earendil-works/pi-ai` 存在
- 确认版本和 DSH 运行时一致

### 症状：pnpm install 卡住 / ETIMEDOUT

**原因**：npm registry 直连不通

**解决**：
- 用代理：`https_proxy=http://192.168.205.176:8118 http_proxy=http://192.168.205.176:8118 pnpm install`
- 或换 registry：`pnpm install --registry=https://registry.npmmirror.com`（配合代理）

## 长期改进方向（需要改插件源码）

当前方案需要在 profile 里维护一份 pi-ai 依赖，DSH 升级后要手动同步。更彻底的解法是让插件的 `findPackageDir` 能自动定位 DSH 运行时里的 pi-ai，这样 profile 里就不需要装 pi-ai 了。

**障碍**：
- `process.execPath` 是 node 二进制（`~/.nvm/versions/node/vX/bin/node`），向上找不到 DSH 安装目录
- `process.argv[1]` 是 `~/.npm-global/bin/dsh`（symlink），向上也找不到
- `import.meta.url` 是插件自身路径（在 profile 里），向上找不到 DSH 运行时

**可能的改进**：
1. DSH 运行时暴露一个环境变量（如 `DSH_INSTALL_DIR`），指向 DSH 包的实际安装目录
2. 插件 `findPackageDir` 增加从 `DSH_INSTALL_DIR` 找 pi-ai 的逻辑
3. 这样 profile 里就不需要装 pi-ai，版本天然和 DSH 运行时一致

## 参考

- pi-ai 包位置：`~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai`
- 插件 catalog 加载逻辑：`lib/catalog.js`（`importCatalog` / `findPackageDir` / `resolutionRoots`）
- profile 目录：`~/.dsh/profiles/web`
- 代理：`http://192.168.205.176:8118`（npm registry 直连不通时使用）
