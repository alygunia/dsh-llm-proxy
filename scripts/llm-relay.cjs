// llm-relay.cjs — 单文件 LLM relay：把这一个上游的流量走代理，其余 provider 直连。
// 用法（零依赖，Node ≥24）：
//   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 \
//     node llm-relay.cjs --listen 8100 --upstream https://api.b.ai
//
// 路径拼接（最容易踩的坑）：target = UPSTREAM + req.url，而 DSH 的 baseURL 通常以 /v1 结尾，
// 客户端实际请求 /v1/chat/completions，所以 --upstream 要去掉末尾的 /v1，否则拼成 /v1/v1：
//   DSH baseURL = http://127.0.0.1:8100/v1   ->  req.url = /v1/chat/completions
//   --upstream  = https://api.b.ai           ->  target  = https://api.b.ai/v1/chat/completions ✅
// 多个需代理的上游 = 起多个 relay 实例（一个进程很轻）。
const http = require('node:http');
const { Readable } = require('node:stream');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const arg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};
const LISTEN = Number(arg('--listen', 8100));
const UPSTREAM = (arg('--upstream', '') || '').replace(/\/+$/, '');
if (!UPSTREAM) {
  console.error('usage: node llm-relay.cjs --listen <port> --upstream https://host [--state <file>]');
  process.exit(1);
}

// 代理开关：undici 只在进程启动时读代理 env，运行中改 env 无效，
// 所以开关 = 状态文件 + 重启进程（毫秒级读文件）。
// 状态文件缺省在脚本同目录 proxy-state，内容 proxy|direct；
// direct = 启动时剥掉代理 env（进程照常带 NODE_USE_ENV_PROXY，只是没有代理地址）。
// 没有状态文件时跟随启动环境里的代理设置（默认行为不变）。
const STATE_FILE = arg('--state', path.join(__dirname, 'proxy-state'));
let mode = process.env.HTTPS_PROXY ? 'proxy' : 'direct';
if (existsSync(STATE_FILE)) {
  const s = readFileSync(STATE_FILE, 'utf8').trim().toLowerCase();
  if (['direct', 'off', '0', 'false'].includes(s)) {
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    mode = 'direct';
  } else if (['proxy', 'on', '1', 'true'].includes(s)) {
    mode = process.env.HTTPS_PROXY ? 'proxy' : 'direct'; // 没配代理 env 时开了也没用
  } else {
    console.warn(`warn: unrecognized state "${s}" in ${STATE_FILE}, following startup env`);
  }
}

http.createServer(async (req, res) => {
  const target = UPSTREAM + req.url;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : req;
  try {
    const up = await fetch(target, { method: req.method, headers, body, duplex: 'half' });
    // 流式透传：SSE/chunked 响应逐块转发，不缓冲整包。
    // 关键：fetch 已自动解压 body，必须剥掉上游的 content-encoding / content-length，
    // 否则下游会拿「已解压的字节 + 声明 gzip 的头」去二次解压 → incorrect header check。
    const h = {};
    for (const [k, v] of up.headers) {
      if (k === 'transfer-encoding' || k === 'content-encoding' || k === 'content-length') continue;
      h[k] = v;
    }
    res.writeHead(up.status, h);
    if (up.body) Readable.fromWeb(up.body).pipe(res);
    else res.end();
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { relay_message: String(e.cause || e) } }));
  }
}).listen(LISTEN, '127.0.0.1', () =>
  console.log(`relay :${LISTEN} -> ${UPSTREAM} mode=${mode} proxy=${process.env.HTTPS_PROXY || 'off'}`));
