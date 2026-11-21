/* PAC 判定回归测试：node tools/test_pac.js */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.resolve(__dirname, '..');
const noop = () => {};
const apiCalls = [];
const chromeStub = {
  storage: { local: { get: async () => ({}), set: async () => {} } },
  proxy: {
    settings: {
      // 严格模拟真实 Chrome/Edge bindings：
      // 1) 拒绝 scope 属性  2) details 必需  3) callback 必须是 function
      clear: async (d, cb) => {
        apiCalls.push(['clear', d, typeof cb]);
        if (d == null) throw new Error("missing required 'details'");
        if ('scope' in d) throw new Error("Unexpected property 'scope'");
        if (typeof cb !== 'function') throw new Error('optional function callback does not match required signature');
        cb();
      },
      set: async (d, cb) => {
        apiCalls.push(['set', d, typeof cb]);
        if (d == null) throw new Error("missing required 'details'");
        if ('scope' in d) throw new Error("Unexpected property 'scope'");
        if (typeof cb !== 'function') throw new Error('optional function callback does not match required signature');
        cb();
      },
      get: async (d, cb) => {
        apiCalls.push(['get', d, typeof cb]);
        if (d == null) throw new Error("missing required 'details'");
        if ('scope' in d) throw new Error("Unexpected property 'scope'");
        if (typeof cb !== 'function') throw new Error('optional function callback does not match required signature');
        const res = { value: { mode: 'pac_script' }, levelOfControl: 'controlled_by_this_extension' };
        cb(res);
        return res;
      },
      onChange: { addListener: noop }
    }
  },
  alarms: { create: async () => {}, onAlarm: { addListener: noop } },
  action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
  runtime: {
    onInstalled: { addListener: noop }, onStartup: { addListener: noop },
    onMessage: { addListener: noop }
  }
};

// 探测桩：Cloudflare trace 返回日本出口（NRT 东京），myip.ipip.net 返回深圳本机
const fetchStub = async (url) => {
  if (String(url).indexOf('cloudflare.com/cdn-cgi/trace') >= 0) {
    return { ok: true, status: 200,
      text: async () => 'fl=408f307\nh=www.cloudflare.com\nip=198.51.100.77\ncolo=NRT\nloc=JP\nwarp=off\n' };
  }
  if (String(url).indexOf('myip.ipip.net') >= 0) {
    return { ok: true, status: 200,
      text: async () => '当前 IP：203.0.113.45  来自于：中国 广东 深圳  移动' };
  }
  throw new Error('stubbed offline');
};
const ctx = {
  console, setTimeout, clearTimeout, AbortController,
  fetch: fetchStub,
  chrome: chromeStub
};
vm.createContext(ctx);
ctx.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'data-cn.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), ctx);

const cfg = {
  enabled: true, mode: 'smart', proxyHost: '127.0.0.1', proxyPort: 7897,
  forceDirect: ['mycorp.example'], forceProxy: ['netflix.com'],
  dnsCheck: true, cnDomainList: true, failOpen: true
};
const pac = vm.runInContext('buildPac(' + JSON.stringify(cfg) + ')', ctx);
if (!/function FindProxyForURL/.test(pac)) throw new Error('PAC 缺少 FindProxyForURL');
// Chrome 要求 pacScript.data 必须为纯 ASCII，否则报 pacScript.data supports only ASCII code
const nonAscii = pac.split('').filter((c) => c.charCodeAt(0) > 127);
if (nonAscii.length) throw new Error('PAC 含非 ASCII 字符 ' + nonAscii.length + ' 个: ' + nonAscii.slice(0, 10).join(''));
console.log('PASS  PAC 纯 ASCII 校验 (长度 ' + pac.length + ')');

const dns = {
  'www.baidu.com': '110.242.68.66',      // 中国联通
  'www.google.com': '142.250.72.142',    // 美国
  'github.com': '140.82.114.4',          // 美国
  'taobao.com': '110.242.68.3',
  'www.somethingabc.com': '8.8.8.8',
  'cn-host.example': '1.0.1.1',          // APNIC CN 段
  'v6.example': ctx.CN_V6_CSV.split(',')[0].split('/')[0]
};
dns[dns['v6.example']] = dns['v6.example']; // IP 字面量：Chrome 的 dnsResolve 会原样返回
let dnsCalls = 0;
const pacCtx = { dnsResolve: (h) => { dnsCalls++; return dns[h] || '8.8.8.8'; } };
vm.createContext(pacCtx);
vm.runInContext(pac, pacCtx);
const decide = (url, host) => pacCtx.FindProxyForURL(url, host);

const cases = [
  ['www.baidu.com', 'DIRECT', '中国域名 DNS 命中 CN IP'],
  ['taobao.com', 'DIRECT', '内置中国域名库'],
  ['cn-host.example', 'DIRECT', '海外域名但解析到 CN IP'],
  ['1.0.1.1', 'DIRECT', 'IP 字面量命中 CN CIDR'],
  [dns['v6.example'], 'DIRECT', 'IPv6 字面量命中 CN 网段'],
  ['v6.example', 'DIRECT', 'DNS 返回 CN IPv6'],
  ['www.happy.gov.cn', 'DIRECT', '.cn 后缀直连'],
  ['mycorp.example', 'DIRECT', '自定义强制直连'],
  ['localhost', 'DIRECT', '本地地址'],
  ['192.168.1.9', 'DIRECT', '内网地址'],
  ['www.google.com', 'PROXY 127.0.0.1:7897', '海外域名走代理'],
  ['github.com', 'PROXY 127.0.0.1:7897', '海外 IP 走代理'],
  ['netflix.com', 'PROXY 127.0.0.1:7897', '自定义强制代理']
];

let fail = 0;
for (const [host, expected, label] of cases) {
  const got = decide('https://' + host + '/', host);
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(24)} ${host.padEnd(30)} -> ${got}`);
}

// .cn 域名应在 DNS 之前命中，不调用 dnsResolve
const before = dnsCalls;
decide('https://gov.cn/', 'gov.cn');
if (dnsCalls !== before) { console.log('FAIL  .cn 域名不应触发 DNS 查询'); fail++; }
else console.log('PASS  .cn 域名在 DNS 之前命中，未触发查询');

// 真实走一遍 apply()/get()，严格校验签名：无 scope + 有 details + 有 callback
(async () => {
  const directCfg = { enabled: true, mode: 'smart', proxyHost: '127.0.0.1', proxyPort: 7897,
    forceDirect: [], forceProxy: [], dnsCheck: true, cnDomainList: true, failOpen: true };
  try {
    // 先埋一个陈旧错误，验证写入成功后会被清空（"能用却报错"的根因）
    vm.runInContext("lastError = 'STALE ERROR'", ctx);
    await ctx.apply(directCfg);
    await ctx.proxyGet();
    const bad = apiCalls.filter(([m, d]) => d && 'scope' in d);
    const noCb = apiCalls.filter(([m, d, cbType]) => cbType !== 'function');
    if (bad.length) { console.log('FAIL  proxy API 仍传 scope: ' + JSON.stringify(bad)); fail++; }
    else console.log('PASS  proxy API 调用无 scope 参数');
    if (noCb.length) { console.log('FAIL  proxy API 缺少 callback: ' + JSON.stringify(noCb)); fail++; }
    else console.log(`PASS  proxy API 均带 details + callback (${apiCalls.length} 次)`);
    const cleared = vm.runInContext('lastError', ctx);
    if (cleared) { console.log('FAIL  写入成功后 lastError 未清空: ' + cleared); fail++; }
    else console.log('PASS  写入成功后清空 lastError（修复"能用却报错"）');

    // IP 双通道探测：出口 JP / 本机 CN 应判为「代理已生效」
    const info = await ctx.ipInfo();
    const ipOk = info.exit.ip === '198.51.100.77' && info.exit.countryZh === '日本' &&
      info.exit.city === '东京' && info.exit.colo === 'NRT' &&
      info.local.ip === '203.0.113.45' && /已真实生效/.test(info.verdict);
    if (!ipOk) { console.log('FAIL  IP 双通道探测判定错误: ' + JSON.stringify(info)); fail++; }
    else console.log(`PASS  IP 双通道探测 (出口 ${info.exit.ip}/${info.exit.countryZh} · 本机 ${info.local.ip} · ${info.verdict})`);
  } catch (e) {
    console.log('FAIL  apply()/get() 抛错（签名仍不兼容）: ' + e.message); fail++;
  }

  console.log(`\nCN v4=${ctx.CN_V4_CSV.split(',').length} v6=${ctx.CN_V6_CSV.split(',').length} domains=${ctx.CN_DOMAIN_CSV.split(',').length}`);
  console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})();
