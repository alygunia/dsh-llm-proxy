# scripts — LLM relay 按 provider 分流代理

把**单个上游**的流量走代理（或直连），其余 provider 不受影响。DSH 侧只改该 provider 的 `baseURL`，随时切换、DSH 无感知。

## 文件

| 文件 | 说明 |
|------|------|
| `llm-relay.cjs` | relay 本体，零依赖，要求 **Node ≥ 24**（`NODE_USE_ENV_PROXY`） |
| `llm-relay-opencode-go.service` | systemd **user** unit 实例（opencode-go 专用） |
| `proxy-switch.sh` | 代理开关：`on`（经代理）/ `off`（直连）/ `status` |
| `proxy-state` | 运行状态文件（`proxy`/`direct`），不入库 |

## 原理（三句话）

1. 该 provider 的 `baseURL` 指向本地 relay，relay 进程带代理 env → 只有这一路流量走代理。
2. 走不走代理由 `proxy-state` + 重启 relay 切换。undici 在**进程启动时**快照代理 env，运行中改 env 无效，所以 `direct` 态 relay 会用剥掉代理 env 的环境 re-exec 自己一次——日志里 `proxy=off` 即真实出口无代理。
3. 透传时 relay 必须剥掉上游的 `content-encoding`/`content-length`（fetch 已解压），否则下游二次解压报 `incorrect header check`。

## 部署（已有实例：llm-relay-opencode-go）

```bash
# 1. unit 进 systemd（repo 为唯一事实源，用 symlink）
ln -sf "$(git rev-parse --show-toplevel)/scripts/llm-relay-opencode-go.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now llm-relay-opencode-go

# 2. DSH 里该 provider 的 baseURL 指向 relay（注意保留 /v1）
#    baseURL: http://127.0.0.1:8100/v1

# 3. 验证
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8100/v1/models
journalctl --user -u llm-relay-opencode-go -n 1 --no-pager -o cat
```

注意 unit 的 `ExecStart` 写的是本机 repo 绝对路径，换机器/换目录后部署前先改它。

## 日常使用

```bash
scripts/proxy-switch.sh status      # 当前模式（状态文件 + relay 最近日志）
scripts/proxy-switch.sh on          # 切到经代理
scripts/proxy-switch.sh off         # 切到直连
```

- 切换 = 写状态文件 + 重启 relay（约 0.5s），在途请求会断一次，DSH retryPolicy 会自动重放。
- 修改本目录 unit 后：`systemctl --user daemon-reload && systemctl --user restart llm-relay-opencode-go`。

## 新增一个走 relay 的上游

复制一份 unit（改 `Description`、`--listen` 端口、`--upstream`、代理 env），再 symlink + `enable --now`。

**路径拼接是最容易踩的坑**：`target = --upstream + req.url`，DSH 的 `baseURL` 以 `/v1` 结尾，客户端请求 `/v1/chat/completions`，所以 `--upstream` **不带** `/v1`，否则拼成 `/v1/v1`：

```
DSH baseURL = http://127.0.0.1:<port>/v1   ->  req.url = /v1/chat/completions
--upstream  = https://api.example.com      ->  target  = https://api.example.com/v1/chat/completions ✅
```

新实例的开关：`RELAY_UNIT=<新unit名> scripts/proxy-switch.sh ...`（注意状态文件是共享的 `proxy-state`，多实例要分别开关时给每个实例配 `--state <文件>`）。

## 排障

| 症状 | 原因 / 判别 |
|------|------------|
| 404 / 路径错 | `--upstream` 带了 `/v1` → 拼成 `/v1/v1` |
| `incorrect header check` | relay 转发了上游压缩头（见原理 3，勿回退） |
| 日志 `mode=direct` 但出口仍走代理 | 旧版 bug（进程内 delete env 无效）；现已 re-exec。判别法：临时起一个 `--upstream https://ipinfo.io` 的 relay，`curl 127.0.0.1:<port>/ip` 看出端口 |
| 上游 400 缺 header | 如 opencode 需要 `x-opencode-session`，由 DSH 客户端头透传，relay 不改写 |
| 开机后 relay 起不来 | unit symlink 在数据盘上，挂载晚于登录会话；`Restart=always` 会重试到盘就位 |
