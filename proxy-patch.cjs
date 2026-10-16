const { ProxyAgent, setGlobalDispatcher } = require('/home/liz/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/undici');
setGlobalDispatcher(new ProxyAgent('http://192.168.205.176:8118'));
