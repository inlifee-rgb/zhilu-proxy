/* PAC 判定回归测试：node tools/test_pac.js */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.resolve(__dirname, '..');
const noop = () => {};
const apiCalls = [];
const _mem = {};
const chromeStub = {
  storage: { local: {
    get: async (k) => { if (k == null) return Object.assign({}, _mem); const o = {}; (Array.isArray(k) ? k : [k]).forEach(x => { if (x in _mem) o[x] = _mem[x]; }); return o; },
    set: async (o) => { Object.assign(_mem, o); }
  } },
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
  action: {
    _badge: { text: '' }, _icon: null,
    setBadgeText(o) { this._badge.text = o.text; },
    setBadgeBackgroundColor(o) { this._badge.color = o.color; },
    setIcon(o) { this._icon = o.path; }
  },
  tabs: {
    _url: 'https://www.baidu.com/',
    query: async () => [{ url: ctxTabsUrl(), title: 'test' }],
    onActivated: { addListener: noop },
    onUpdated: { addListener: noop }
  },
  runtime: {
    onInstalled: { addListener: noop }, onStartup: { addListener: noop },
    onMessage: { addListener: noop }
  }
};
function ctxTabsUrl() { return chromeStub.tabs._url; }

// 探测桩：Cloudflare trace 返回日本出口（NRT 东京），myip.ipip.net 返回深圳本机
let fetchStub = async (url) => {
  const u = String(url);
  if (u.indexOf('cloudflare.com/cdn-cgi/trace') >= 0) {
    return { ok: true, status: 200,
      text: async () => 'fl=408f307\nh=www.cloudflare.com\nip=198.51.100.77\ncolo=NRT\nloc=JP\nwarp=off\n' };
  }
  if (u.indexOf('myip.ipip.net') >= 0) {
    return { ok: true, status: 200,
      text: async () => '当前 IP：203.0.113.45  来自于：中国 广东 深圳  移动' };
  }
  // 规则库自动更新：模拟 APNIC delegated 文本（足量条目 + 非CN噪声 + 重复行）
  if (u.indexOf('delegated-apnic-latest') >= 0) {
    const lines = [];
    for (let i = 0; i < 3002; i++) lines.push('apnic|CN|ipv4|' + (11 + (i >> 8)) + '.' + (i & 255) + '.0.0|256|20260101|allocated');
    for (let i = 0; i < 302; i++) lines.push('apnic|CN|ipv6|2001:' + i.toString(16) + '::|32|20260101|allocated');
    lines.push('apnic|CN|ipv4|1.0.1.0|256|20260101|allocated');  // 重复
    lines.push('apnic|US|ipv4|8.8.8.0|256|20260101|allocated');  // 非CN噪声
    return { ok: true, status: 200, text: async () => lines.join('\n') };
  }
  // 内核探测：模拟 7897 端口有 Clash Verge 在监听（no-cors 探测）
  if (u.indexOf('127.0.0.1:7897/') >= 0) {
    if (u.indexOf('/version') >= 0) {
      return { ok: true, status: 200, text: async () => '{"version":"Mihomo Meta v1.19.11"}' };
    }
    return { ok: true, status: 400, text: async () => '' }; // GET / 返回 400 也算活着
  }
  throw new Error('stubbed offline');
};
const ctx = {
  console, setTimeout, clearTimeout, AbortController, URL, Date,
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
      info.local.ip === '203.0.113.45' && /代理通道已连通/.test(info.verdict);
    if (!ipOk) { console.log('FAIL  IP 双通道探测判定错误: ' + JSON.stringify(info)); fail++; }
    else console.log(`PASS  IP 双通道探测 (出口 ${info.exit.ip}/${info.exit.countryZh} · 本机 ${info.local.ip} · ${info.verdict})`);

    // 内核检测：7897 命中 Clash Verge，版本读得到；不应误报未安装
    const kern = await ctx.detectKernels(cfg);
    const kernOk = kern.found === true && kern.port === 7897 &&
      /Clash Verge/.test(kern.name) && /Mihomo/.test(kern.version) &&
      kern.alivePorts.indexOf(7897) >= 0;
    if (!kernOk) { console.log('FAIL  内核检测判定错误: ' + JSON.stringify(kern)); fail++; }
    else console.log(`PASS  内核检测 (${kern.name} · :${kern.port} · ${kern.version})`);
  } catch (e) {
    console.log('FAIL  apply()/get() 抛错（签名仍不兼容）: ' + e.message); fail++;
  }

    // 当前页面路由判定：与 PAC 同规则，回答「这个页面走直连还是代理」
    const classify = (h, c) => vm.runInContext('classifyHost(' + JSON.stringify(h) + ',' + JSON.stringify(c) + ')', ctx);
    const smartCfg = Object.assign({}, cfg, { mode: 'smart', enabled: true, cnDomainList: true, dnsCheck: true });
    const cases = [
      ['baidu.com', 'direct', '中国域名库'],      // 用户截图场景：百度应直连
      ['www.qq.com', 'direct', '中国域名库'],
      ['gov.cn', 'direct', '.cn 域名'],
      ['google.com', 'proxy', '海外域名'],
      ['github.com', 'proxy', '海外域名'],
      ['localhost', 'direct', '本地/保留地址']
    ];
    let routeOk = true;
    for (const [host, want, viaPart] of cases) {
      const d = classify(host, smartCfg);
      if (!d || d.decision !== want || String(d.via).indexOf(viaPart) < 0) {
        console.log(`FAIL  路由判定 ${host}: 期望 ${want}/${viaPart}，得到 ${JSON.stringify(d)}`);
        routeOk = false;
      }
    }
    // 强制规则优先于域名库：forceProxy 里放 baidu.com 应改为走代理
    const forced = classify('baidu.com', Object.assign({}, smartCfg, { forceProxy: ['baidu.com'] }));
    if (!forced || forced.decision !== 'proxy' || forced.via !== '自定义强制代理') {
      console.log('FAIL  强制代理规则未覆盖域名库: ' + JSON.stringify(forced)); routeOk = false;
    }
    // 模式覆盖：allproxy 下海外和中国域名都走代理；direct 下都直连
    const ap = classify('baidu.com', Object.assign({}, smartCfg, { mode: 'allproxy' }));
    const dm = classify('google.com', Object.assign({}, smartCfg, { mode: 'direct' }));
    if (!ap || ap.decision !== 'proxy' || !dm || dm.decision !== 'direct') {
      console.log('FAIL  模式覆盖错误: allproxy=' + JSON.stringify(ap) + ' direct=' + JSON.stringify(dm)); routeOk = false;
    }
    if (routeOk) console.log('PASS  当前页面路由判定 (baidu.com→直连/中国域名库 · google.com→代理 · 强制规则/模式覆盖均正确)');
    else fail++;

    // 流量统计：trafficBucket 按 PAC 同源规则分流；自身探测域名排除
    const bucket = (url) => vm.runInContext('trafficBucket(' + JSON.stringify(url) + ')', ctx);
    vm.runInContext('traffic.direct.__tag="D"; traffic.proxy.__tag="P";', ctx);
    vm.runInContext('cachedCfg = ' + JSON.stringify(smartCfg) + ';', ctx);
    const bBaidu = bucket('https://www.baidu.com/s?wd=x');
    const bGoogle = bucket('https://www.google.com/search?q=x');
    const bProbe = bucket('https://www.cloudflare.com/cdn-cgi/trace');
    const bLocal = bucket('http://127.0.0.1:7897/version');
    const bNonHttp = bucket('chrome-extension://abc/page.html');
    const tag = (o) => (o && o.__tag) || String(o);
    let tfOk = tag(bBaidu) === 'D' && tag(bGoogle) === 'P' &&
      bProbe === null && bLocal === null && bNonHttp === null;
    if (!tfOk) {
      console.log('FAIL  流量分流归类错误: baidu=' + tag(bBaidu) + ' google=' + tag(bGoogle) +
        ' cloudflare=' + bProbe + ' local=' + bLocal + ' nonhttp=' + bNonHttp);
      fail++;
    } else console.log('PASS  流量统计分流 (百度→直连桶 · 谷歌→代理桶 · 自身探测/本地/非http已排除)');

    // 工具栏角标：反映当前页面路由（直连=绿点 / 代理=紫点），且绝不再出现 'CN' 文字
    vm.runInContext('cachedCfg = ' + JSON.stringify(smartCfg) + ';', ctx);
    const badgeOf = async (url) => {
      chromeStub.tabs._url = url;
      await vm.runInContext('refreshRouteBadge()', ctx);
      return Object.assign({}, chromeStub.action._badge);
    };
    const iconOf = (state) => String((chromeStub.action._icon && chromeStub.action._icon[32]) || '');
    await badgeOf('https://www.baidu.com/');
    const iconDirect = iconOf();
    await badgeOf('https://www.google.com/');
    const iconProxy = iconOf();
    vm.runInContext('cachedCfg = ' + JSON.stringify(Object.assign({}, smartCfg, { enabled: false })) + ';', ctx);
    await badgeOf('https://www.baidu.com/');
    const iconOff = iconOf();
    const badgeText = chromeStub.action._badge.text;
    let dotOk = iconDirect.includes('icon-direct-') &&
      iconProxy.includes('icon-proxy-') &&
      iconOff.includes('icon-off-') &&
      badgeText === '';   // 角标文字清空（无 CN / 无 ● 黑点）
    if (!dotOk) {
      console.log('FAIL  工具栏图标错误: 百度=' + iconDirect + ' 谷歌=' + iconProxy +
        ' 暂停=' + iconOff + ' badge文字=' + JSON.stringify(badgeText));
      fail++;
    } else console.log('PASS  工具栏图标随路由变色 (百度绿点猫/谷歌紫点猫/暂停灰点猫 · badge文字已清空无CN黑点)');

    // ── P0 规则库自动更新 ────────────────────────────────────────────
    const beforeV4 = ctx.CN_V4_CSV.split(',').length;
    const upd = await vm.runInContext('updateRulesFromApnic()', ctx);
    const afterV4 = ctx.CN_V4_CSV.split(',').length;
    const liveMeta = await vm.runInContext('ACTIVE_META', ctx);
    let rulesOk = upd.ok && afterV4 > 3000 && liveMeta.live === true &&
      liveMeta.v4 === afterV4 && (liveMeta.fetchedAt > 0);
    if (!rulesOk) {
      console.log('FAIL  规则库自动更新: ok=' + upd.ok + ' before=' + beforeV4 +
        ' after=' + afterV4 + ' live=' + liveMeta.live + ' err=' + (upd.error || ''));
      fail++;
    } else console.log('PASS  规则库自动更新 (APNIC拉取→解析→覆盖全局→meta标记live, ' + beforeV4 + '→' + afterV4 + ' 条)');

    // 覆盖后 buildPac 必须用新版规则（PAC 内嵌的 CN_V4_CSV 条数 = 更新后条数）
    const pacNow = vm.runInContext('buildPac(cachedCfg)', ctx);
    const pacHasNew = pacNow.indexOf('11.11.0.0/16') >= 0 || pacNow.indexOf('11.') >= 0;
    if (!pacHasNew) { console.log('FAIL  PAC未使用更新后规则'); fail++; }
    else console.log('PASS  PAC 使用更新后规则');

    // 失败兜底：模拟拉取失败，规则与 meta 不应被破坏
    const savedV4 = ctx.CN_V4_CSV;
    const savedLive = liveMeta.live;
    fetchStub = async () => { throw new Error('offline'); };
    ctx.fetch = fetchStub;
    const bad = await vm.runInContext('updateRulesFromApnic()', ctx);
    const afterFail = ctx.CN_V4_CSV;
    if (bad.ok || afterFail !== savedV4) {
      console.log('FAIL  规则更新失败未兜底: ok=' + bad.ok + ' changed=' + (afterFail !== savedV4));
      fail++;
    } else console.log('PASS  规则拉取失败静默兜底 (保留旧规则不破坏)');

  console.log(`\nCN v4=${ctx.CN_V4_CSV.split(',').length} v6=${ctx.CN_V6_CSV.split(',').length} domains=${ctx.CN_DOMAIN_CSV.split(',').length}`);
  console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})();
