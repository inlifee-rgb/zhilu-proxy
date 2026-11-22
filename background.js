/* 智路 · CN 智能分流代理 — background service worker
 * 核心：用 chrome.proxy + PAC 直接接管 Chrome 的代理决策。
 * 与 Clash Verge 的「系统代理」开关完全无关。
 */
importScripts('data-cn.js');

const DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'smart',            // smart | direct | allproxy
  proxyHost: '127.0.0.1',
  proxyPort: 7897,          // 实测本机 Clash Verge mixed-port
  forceDirect: [],
  forceProxy: [],
  dnsCheck: true,
  cnDomainList: true,
  failOpen: true,           // 代理端口不通时自动直连，避免全网断网
  clashApiHost: '127.0.0.1',
  clashApiPort: 9097,
  clashSecret: 'set-your-secret'
});

let offline = false;
let applying = false;
let pendingApply = false;
let missCount = 0;
let lastError = '';
let lastLivenessError = '';
let cachedCfg = null;   // 供 webRequest 同步判定路由，避免每条请求都 await 存储

/* ------------------------------------------------------- rule data (P0) --- */
/* 规则库自动更新：构建时 data-cn.js 提供离线基线；运行时从 APNIC 拉最新 CN
 * 段存入 storage，加载时用存储版覆盖全局 CSV——buildPac / classifyHost /
 * traffic 全部自动用新版，无需改判定逻辑。拉取失败静默保留旧规则。
 * 域名库人工维护，始终用内置 CN_DOMAIN_CSV。 */
const APNIC_URL = 'https://ftp.apnic.net/apnic/stats/apnic/delegated-apnic-latest';
let ACTIVE_META = (typeof CN_DATA_META !== 'undefined')
  ? Object.assign({}, CN_DATA_META) : { v4: 0, v6: 0, domains: 0, generated: '—' };
const BUILTIN_META = Object.assign({}, ACTIVE_META);

function todayStamp() { return new Date().toISOString().slice(0, 10); }

/* 解析 APNIC delegated 文本 -> {v4:[cidr],v6:[cidr]}。不折叠 CIDR：
 * PAC 的 _init4 按 /24 分桶逐条匹配，条数多一点不影响正确性，且省去复杂的
 * 运行时地址聚合。size 必须是 2 的幂（ipv4），ipv6 直接是前缀长度。 */
function parseApnic(text) {
  const v4 = [], v6 = [], seen = new Set();
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.startsWith('apnic|')) continue;
    const p = raw.trim().split('|');
    if (p.length < 6 || p[1] !== 'CN') continue;
    const kind = p[2], addr = p[3], sizeRaw = p[4];
    const key = kind + ':' + addr + ':' + sizeRaw;
    if (seen.has(key)) continue;
    seen.add(key);
    if (kind === 'ipv4') {
      const n = Number(sizeRaw);
      if (!n || (n & (n - 1))) continue;              // 非 2 的幂：跳过
      v4.push(addr + '/' + (32 - Math.log2(n)));
    } else if (kind === 'ipv6') {
      const pre = Number(sizeRaw);
      if (isFinite(pre) && pre >= 0 && pre <= 128) v6.push(addr + '/' + pre);
    }
  }
  return { v4, v6 };
}

/* 从 storage 读取已保存的规则并覆盖全局 CSV；无存储时用内置基线。 */
async function applyStoredRules() {
  let saved = null;
  try { const s = await chrome.storage.local.get('rules'); saved = s && s.rules; } catch (_) {}
  if (saved && typeof saved.v4 === 'string' && typeof saved.v6 === 'string' &&
      saved.v4.length > 100 && saved.v6.length > 20) {
    CN_V4_CSV = saved.v4;
    CN_V6_CSV = saved.v6;
    G4 = null; V6 = null;                              // 重建索引缓存
    ACTIVE_META = Object.assign({}, saved.meta || {}, { live: true });
  } else {
    ACTIVE_META = Object.assign({}, BUILTIN_META, { live: false });
  }
}

/* 拉取并落库；返回统一结果。任何异常都不改动现有规则。 */
async function updateRulesFromApnic() {
  const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 15000) : null;
  try {
    const resp = await fetch(APNIC_URL, ctl ? { signal: ctl.signal, cache: 'no-store' } : { cache: 'no-store' });
    if (!resp || !resp.ok) throw new Error('HTTP ' + (resp && resp.status));
    const parsed = parseApnic(await resp.text());
    if (parsed.v4.length < 3000 || parsed.v6.length < 300) {
      throw new Error('APNIC 数据不完整 (' + parsed.v4.length + '/' + parsed.v6.length + ')');
    }
    const meta = {
      generated: todayStamp(), source: 'APNIC delegated-apnic-latest (live)',
      v4: parsed.v4.length, v6: parsed.v6.length,
      domains: CN_DOMAIN_CSV.split(',').filter(Boolean).length,
      fetchedAt: Date.now(), live: true
    };
    await chrome.storage.local.set({ rules: { v4: parsed.v4.join(','), v6: parsed.v6.join(','), meta } });
    await applyStoredRules();
    return { ok: true, meta: ACTIVE_META };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* 规则库年龄（天）：基于生效规则的 fetchedAt 或内置 generated。 */
function rulesAgeDays() {
  const t = ACTIVE_META.fetchedAt || (ACTIVE_META.generated ? Date.parse(ACTIVE_META.generated) : 0);
  if (!t) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

/* ---------------------------------------------------------------- PAC --- */
const PAC_BODY = `
function _ip2n(s){
  var p=String(s||'').split('.');
  if(p.length!==4) return -1;
  for(var i=0;i<4;i++){var x=+p[i];if(!(x>=0&&x<=255))return -1;}
  return ((((+p[0])<<24)|((+p[1])<<16)|((+p[2])<<8)|(+p[3]))>>>0);
}
var _G4=null;
function _init4(){
  if(_G4)return;
  _G4={};
  var a=CN_V4_CSV.split(',');
  for(var i=0;i<a.length;i++){
    var q=a[i].split('/');if(q.length<2)continue;
    var n=_ip2n(q[0]);if(n<0)continue;
    var p=+q[1];if(!(p>=0&&p<=32))continue;
    var m=p===0?0:((0xFFFFFFFF<<(32-p))>>>0);
    n=(n&m)>>>0;
    var b=n>>>24;
    if(!_G4[b])_G4[b]=[];
    _G4[b].push([n,m]);
  }
}
function _in4(ip){
  _init4();
  var n=_ip2n(ip);if(n<0)return false;
  var arr=_G4[n>>>24]||[];
  for(var i=0;i<arr.length;i++)if(((n&arr[i][1])>>>0)===arr[i][0])return true;
  return false;
}
function _v6groups(s){
  s=String(s||'').toLowerCase().split('%')[0];
  if(s.indexOf('::')>=0){
    var halves=s.split('::');if(halves.length>2)return null;
    var l=halves[0]?halves[0].split(':').filter(Boolean):[];
    var r=halves[1]?halves[1].split(':').filter(Boolean):[];
    var miss=8-l.length-r.length;if(miss<1)return null;
    var g=l.concat(new Array(miss).fill('0'),r);
    if(g.length!==8)return null;
    return g.map(function(x){return parseInt(x,16);});
  }
  var a=s.split(':');if(a.length!==8)return null;
  return a.map(function(x){return parseInt(x,16);});
}
var _V6=null;
function _init6(){
  if(_V6)return;
  _V6=[];
  var a=CN_V6_CSV.split(',');
  for(var i=0;i<a.length;i++){
    var q=a[i].split('/');if(q.length<2)continue;
    var g=_v6groups(q[0]),p=+q[1];
    if(g&&p>=0&&p<=128)_V6.push([g,p]);
  }
}
function _in6(ip){
  _init6();
  var g=_v6groups(ip);if(!g)return false;
  for(var i=0;i<_V6.length;i++){
    var e=_V6[i],ok=true;
    for(var k=0;k<e[1];k++){
      var idx=k>>3,bit=7-(k&7);
      if(((e[0][idx]>>bit)&1)!==((g[idx]>>bit)&1)){ok=false;break;}
    }
    if(ok)return true;
  }
  return false;
}
function _ends(h,d){return h===d||h.slice(-(d.length+1))==='.'+d;}
function _local(h){
  if(h==='localhost'||h==='::1'||h.slice(-6)==='.local')return true;
  var n=_ip2n(h);if(n<0)return false;
  var b=n>>>24,c=(n>>>16)&255;
  return b===127||b===10||b===0||
    (b===192&&c===168)||(b===172&&c>=16&&c<=31)||
    (b===169&&c===254);
}
function _cnDomain(h){
  if(h.slice(-3)==='.cn')return true;
  var a=CN_DOMAIN_CSV.split(',');
  for(var i=0;i<a.length;i++)if(a[i]&&_ends(h,a[i]))return true;
  return false;
}
function FindProxyForURL(url,host){
  var h=String(host||'').toLowerCase();
  while(h.charAt(h.length-1)==='.')h=h.slice(0,-1);
  if(!h)return 'DIRECT';
  if(OPT.local&&_local(h))return 'DIRECT';
  var i;
  for(i=0;i<DIRECT_LIST.length;i++)if(DIRECT_LIST[i]&&_ends(h,DIRECT_LIST[i]))return 'DIRECT';
  for(i=0;i<PROXY_LIST.length;i++)if(PROXY_LIST[i]&&_ends(h,PROXY_LIST[i]))return PROXY_ENDPOINT;
  if(OPT.domains&&_cnDomain(h))return 'DIRECT';
  if(OPT.dns){
    var literal=(_ip2n(h)>=0||h.indexOf(':')>=0);
    var ip=literal?h:dnsResolve(h);
    if(ip&&(ip.indexOf(':')>=0?_in6(ip):_in4(ip)))return 'DIRECT';
  }
  return PROXY_ENDPOINT;
}
`;

function normList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => String(x || '').trim().toLowerCase().replace(/^\./, '').replace(/^https?:\/\//, '').split('/')[0])
    .filter(Boolean)
    .slice(0, 500);
}

function buildPac(cfg) {
  const port = Number(cfg.proxyPort) > 0 ? Number(cfg.proxyPort) : 7897;
  const host = String(cfg.proxyHost || '127.0.0.1').trim();
  const lines = [
    '// Zhilu PAC - autogenerated: CN direct, overseas via proxy',
    'var CN_V4_CSV = ' + JSON.stringify(CN_V4_CSV) + ';',
    'var CN_V6_CSV = ' + JSON.stringify(CN_V6_CSV) + ';',
    'var CN_DOMAIN_CSV = ' + JSON.stringify(CN_DOMAIN_CSV) + ';',
    'var PROXY_ENDPOINT = ' + JSON.stringify('PROXY ' + host + ':' + port) + ';',
    'var DIRECT_LIST = ' + JSON.stringify(normList(cfg.forceDirect)) + ';',
    'var PROXY_LIST = ' + JSON.stringify(normList(cfg.forceProxy)) + ';',
    'var OPT = ' + JSON.stringify({ local: true, dns: !!cfg.dnsCheck, domains: !!cfg.cnDomainList }) + ';',
    PAC_BODY
  ];
  // Chrome 强制 pacScript.data 为纯 ASCII：中文注释/域名一律转成 \uXXXX 转义。
  // 规则库与模板通常全 ASCII，先 test 短路，避免每次生成都对 115KB 做全量 replace
  // 并构造一个新字符串（冷启动/改模式时的可观开销）。
  const raw = lines.join('\n');
  return /[^\x00-\x7F]/.test(raw)
    ? raw.replace(/[^\x00-\x7F]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
    : raw;
}

/* -------------------------------------- 当前页面路由判定（与 PAC 同规则） --- */
/* 出口探测只回答「代理通道是否通」，不能回答「当前页面走哪条路」。
 * 这里用与 PAC 完全相同的规则对当前标签域名做静态判定，并给出命中依据，
 * 让面板能明确显示 baidu.com → 直连、google.com → 走代理。 */
function ip2n(s) {
  const p = String(s || '').split('.');
  if (p.length !== 4) return -1;
  for (const x0 of p) { const x = +x0; if (!(x >= 0 && x <= 255)) return -1; }
  return ((((+p[0]) << 24) | ((+p[1]) << 16) | ((+p[2]) << 8) | (+p[3])) >>> 0);
}
let G4 = null;
function init4() {
  if (G4) return;
  G4 = {};
  for (const q of CN_V4_CSV.split(',')) {
    const parts = q.split('/'); if (parts.length < 2) continue;
    const n = ip2n(parts[0]); if (n < 0) continue;
    const p = +parts[1]; if (!(p >= 0 && p <= 32)) continue;
    const m = p === 0 ? 0 : ((0xFFFFFFFF << (32 - p)) >>> 0);
    const b = ((n & m) >>> 0) >>> 24;
    (G4[b] || (G4[b] = [])).push([(n & m) >>> 0, m]);
  }
}
function in4(ip) {
  init4();
  const n = ip2n(ip); if (n < 0) return false;
  for (const e of (G4[n >>> 24] || [])) if (((n & e[1]) >>> 0) === e[0]) return true;
  return false;
}
function v6groups(s) {
  s = String(s || '').toLowerCase().split('%')[0];
  if (s.indexOf('::') >= 0) {
    const halves = s.split('::'); if (halves.length > 2) return null;
    const l = halves[0] ? halves[0].split(':').filter(Boolean) : [];
    const r = halves[1] ? halves[1].split(':').filter(Boolean) : [];
    const miss = 8 - l.length - r.length; if (miss < 1) return null;
    const g = l.concat(new Array(miss).fill('0'), r);
    return g.length === 8 ? g.map((x) => parseInt(x, 16)) : null;
  }
  const a = s.split(':'); if (a.length !== 8) return null;
  return a.map((x) => parseInt(x, 16));
}
let V6 = null;
function init6() {
  if (V6) return;
  V6 = [];
  for (const q of CN_V6_CSV.split(',')) {
    const parts = q.split('/'); if (parts.length < 2) continue;
    const g = v6groups(parts[0]), p = +parts[1];
    if (g && p >= 0 && p <= 128) V6.push([g, p]);
  }
}
function in6(ip) {
  init6();
  const g = v6groups(ip); if (!g) return false;
  for (const e of V6) {
    let ok = true;
    for (let k = 0; k < e[1]; k++) {
      const idx = k >> 3, bit = 7 - (k & 7);
      if (((e[0][idx] >> bit) & 1) !== ((g[idx] >> bit) & 1)) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}
function ends(h, d) { return h === d || h.slice(-(d.length + 1)) === '.' + d; }
function isLocal(h) {
  if (h === 'localhost' || h === '::1' || h.slice(-6) === '.local') return true;
  const n = ip2n(h); if (n < 0) return false;
  const b = n >>> 24, c = (n >>> 16) & 255;
  return b === 127 || b === 10 || b === 0 || (b === 192 && c === 168) ||
    (b === 172 && c >= 16 && c <= 31) || (b === 169 && c === 254);
}
function isCnDomain(h) {
  if (h.slice(-3) === '.cn') return true;
  for (const d of CN_DOMAIN_CSV.split(',')) if (d && ends(h, d)) return true;
  return false;
}
/* 返回 { decision:'direct'|'proxy', via:'命中依据', detail } */
function classifyHost(rawHost, cfg) {
  let h = String(rawHost || '').toLowerCase();
  while (h.charAt(h.length - 1) === '.') h = h.slice(0, -1);
  if (!h) return { decision: 'direct', via: '无主机名', detail: '' };

  // 模式优先：全局直连 / 全局代理 / 离线降级
  if (!cfg.enabled) return { decision: 'direct', via: '扩展已暂停', detail: '当前未接管 Chrome' };
  if (cfg.mode === 'direct') return { decision: 'direct', via: '全部直连模式', detail: '所有流量都直连' };
  if (offline && cfg.failOpen) return { decision: 'direct', via: '代理离线自动直连', detail: '代理端口未响应，临时直连' };
  if (cfg.mode === 'allproxy') {
    if (isLocal(h)) return { decision: 'direct', via: '本地地址', detail: h };
    return { decision: 'proxy', via: '全部代理模式', detail: '所有流量都走代理' };
  }

  // smart 模式：顺序与 PAC 的 FindProxyForURL 完全一致
  if (isLocal(h)) return { decision: 'direct', via: '本地/保留地址', detail: h };
  for (const d of normList(cfg.forceDirect)) {
    if (d && ends(h, d)) return { decision: 'direct', via: '自定义强制直连', detail: d };
  }
  for (const d of normList(cfg.forceProxy)) {
    if (d && ends(h, d)) return { decision: 'proxy', via: '自定义强制代理', detail: d };
  }
  if (cfg.cnDomainList && isCnDomain(h)) {
    const isCnTld = h.slice(-3) === '.cn';
    return { decision: 'direct', via: isCnTld ? '.cn 域名' : '中国域名库', detail: h };
  }
  // 字面 IP：用中国 IP 段判定（域名场景 PAC 会 dnsResolve，SW 无同步 DNS，
  // 但域名库 + .cn 已覆盖主流中国站点）
  if (cfg.dnsCheck && (ip2n(h) >= 0 || h.indexOf(':') >= 0)) {
    const hit = h.indexOf(':') >= 0 ? in6(h) : in4(h);
    if (hit) return { decision: 'direct', via: '中国 IP 网段', detail: h };
  }
  return { decision: 'proxy', via: '海外域名', detail: h };
}

/* ------------------------------------------------------------- traffic --- */
/* 流量统计：webRequest 观察模式（MV3 无 blocking，观察不影响转发速度）。
 * 每条请求用与 PAC 同源的 classifyHost 归到 direct / proxy，累计请求数与
 * 传输字节（上传取 requestBody.contentLength，下载取响应 Content-Length）。
 * 只统计 http(s)，并排除扩展自身探测域名，避免自测流量污染统计。 */
const traffic = {
  direct: { bytes: 0, requests: 0 },
  proxy:  { bytes: 0, requests: 0 },
  startedAt: Date.now()
};
const SELF_PROBE_RE = /(^|\.)(cloudflare\.com|ipip\.net)$/i;
function trafficBucket(url) {
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = (u.hostname || '').toLowerCase();
  if (!h || h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || SELF_PROBE_RE.test(h)) return null;
  const d = classifyHost(h, cachedCfg || DEFAULTS);
  return d.decision === 'proxy' ? traffic.proxy : traffic.direct;
}
function num(v) { const n = Number(v); return isFinite(n) && n > 0 ? n : 0; }
function initTrafficObserver() {
  const wr = chrome.webRequest;
  if (!wr || !wr.onBeforeRequest || !wr.onCompleted) return; // 测试桩/旧版无 webRequest：安全降级
  try {
    wr.onBeforeRequest.addListener((d) => {
      const b = trafficBucket(d.url);
      if (!b) return;
      b.requests += 1;
      try { if (d.requestBody && d.requestBody.contentLength != null) b.bytes += num(d.requestBody.contentLength); } catch (_) {}
    }, { urls: ['http://*/*', 'https://*/*'] }, ['requestBody']);

    wr.onCompleted.addListener((d) => {
      const b = trafficBucket(d.url);
      if (!b) return;
      try {
        const hs = d.responseHeaders || [];
        for (const h of hs) {
          if (h && h.name && h.name.toLowerCase() === 'content-length') { b.bytes += num(h.value); break; }
        }
      } catch (_) {}
    }, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders']);
  } catch (e) { console.warn('[智路] 流量观察未启用:', e && e.message); }
}
initTrafficObserver();

/* ------------------------------------------------------------- state --- */
async function getCfg() {
  const stored = await chrome.storage.local.get('cfg');
  cachedCfg = Object.assign({}, DEFAULTS, stored.cfg || {});
  return cachedCfg;
}

async function setCfg(patch) {
  const next = Object.assign({}, await getCfg(), patch || {});
  await chrome.storage.local.set({ cfg: next });
  offline = false;
  await apply(next);
  return next;
}

function badge(text, color) {
  try {
    chrome.action.setBadgeText({ text: text || '' });
    chrome.action.setBadgeBackgroundColor({ color: color || '#2563EB' });
  } catch (e) { /* badge 不影响主功能 */ }
}

/* 工具栏图标：反映「当前活动标签页」实际走哪条路。
 * 直连=绿点 / 走代理=紫点 / 暂停或无法判定=灰点 / 写入失败=红点。
 * 用 setIcon 切换「猫头+小色点」的整套图标（tools/make_icons.py 生成），
 * 不再用 badge 文字——'●' 会渲染成难看的「黑点套绿框」，'CN' 更是误导。 */
const ICON_PATHS = {
  direct:  { 16: 'icons/icon-direct-16.png', 32: 'icons/icon-direct-32.png', 48: 'icons/icon-direct-48.png', 128: 'icons/icon-direct-128.png' },
  proxy:   { 16: 'icons/icon-proxy-16.png', 32: 'icons/icon-proxy-32.png', 48: 'icons/icon-proxy-48.png', 128: 'icons/icon-proxy-128.png' },
  off:     { 16: 'icons/icon-off-16.png', 32: 'icons/icon-off-32.png', 48: 'icons/icon-off-48.png', 128: 'icons/icon-off-128.png' },
  unknown: { 16: 'icons/icon-off-16.png', 32: 'icons/icon-off-32.png', 48: 'icons/icon-off-48.png', 128: 'icons/icon-off-128.png' },
  error:   { 16: 'icons/icon-error-16.png', 32: 'icons/icon-error-32.png', 48: 'icons/icon-error-48.png', 128: 'icons/icon-error-128.png' }
};
let lastIconKind = '';
let lastActualMode = 'unknown';   // 上次成功读到的代理模式：proxy 读取超时时兜底
function badgeDot(kind, force) {
  // 清掉旧的 badge 文字（旧版本可能留下 CN / ●，必须抹掉）
  try { chrome.action.setBadgeText({ text: '' }); } catch (_) {}
  if (!force && kind === lastIconKind) return;
  lastIconKind = kind;
  try { chrome.action.setIcon({ path: ICON_PATHS[kind] || ICON_PATHS.unknown }); }
  catch (e) { /* 图标切换失败不影响代理主功能 */ }
}

/* 取当前活动标签。SW 刚唤醒的那一瞬间 chrome.tabs 往往还没就绪：
 * 直接 query({active,currentWindow}) 可能返回空数组，于是被当成「无法判定」
 * 刷成灰点——而 16px 下灰点几乎看不见，表现就是「状态灯没了」。
 * 这里按窗口维度逐级退让，确保拿到真实标签。 */
async function activeTab() {
  const tries = [
    { active: true, currentWindow: true },
    { active: true, lastFocusedWindow: true },
    { active: true }
  ];
  for (const q of tries) {
    try {
      const tabs = await chrome.tabs.query(q);
      if (tabs && tabs[0]) return tabs[0];
    } catch (_) { /* 继续下一档 */ }
  }
  return null;
}

/* 读当前活动标签的 host，用与 PAC 同源的 classifyHost 判定后刷新角标。
 * 完全防御性：任何一步失败只落灰点，绝不影响代理主功能。 */
async function refreshRouteBadge(opts) {
  const force = !!(opts && opts.force);
  const retry = (opts && opts.retry) || 0;
  try {
    const cfg = cachedCfg || await getCfg();
    if (!cfg || !cfg.enabled) { badgeDot('off', force); return; }
    const tab = await activeTab();
    const url = (tab && (tab.url || tab.pendingUrl)) || '';
    // 拿不到标签地址（SW 刚醒 / 窗口还没就绪）：这次先不动灯，短延迟重试。
    // 绝不能在「查不到」时刷成灰点——16px 下灰点几乎不可见，观感就是灯丢了。
    if (!url) {
      if (retry < 3) setTimeout(() => refreshRouteBadge({ force, retry: retry + 1 }), 300);
      else badgeDot('unknown', force);
      return;
    }
    let host = '';
    if (/^https?:\/\//i.test(url)) {
      try { host = new URL(url).hostname; } catch (_) { host = ''; }
    }
    const d = host ? classifyHost(host, cfg) : null;
    badgeDot(d ? d.decision : 'unknown', force);
  } catch (_) {
    badgeDot('unknown', force);
  }
}

/* Chrome/Edge 各版本对 proxy.settings 的参数签名校验差异很大：
 * - 新版严格 schema 拒绝 'scope' 属性（Unexpected property 'scope'）
 * - 部分版本不接受纯 Promise 风格，要求显式 callback（callback does not match required signature）
 * - get/clear 的 details 是必需参数
 * 统一走「显式 details + 显式 callback」的官方签名，并兼容仍返回 Promise 的版本。 */
function proxyCall(method, details) {
  let settled = false;
  let resolveFn;
  let rejectFn;
  const promise = new Promise((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
  const done = (err, val) => {
    if (settled) return;
    settled = true;
    if (err) rejectFn(err); else resolveFn(val);
  };
  try {
    const ret = chrome.proxy.settings[method](
      details === undefined ? {} : details,
      function (result) {
        const le = (typeof chrome.runtime !== 'undefined' && chrome.runtime.lastError) || null;
        done(le ? new Error(le.message) : null, result);
      }
    );
    // 少数版本即使传了 callback 也会返回 Promise，双保险
    if (ret && typeof ret.then === 'function') ret.then((r) => done(null, r), (e) => done(e));
  } catch (e) {
    done(e);
  }
  return promise;
}
function proxySet(value) { return proxyCall('set', { value: value }); }
function proxyClear() { return proxyCall('clear', {}); }
function proxyGet() { return proxyCall('get', {}); }

/* 配置期望的 Chrome 代理模式（用于冷启动快速比对，避免无谓重写 PAC）。 */
function expectMode(cfg) {
  if (!cfg || !cfg.enabled) return 'system';
  if (cfg.mode === 'direct') return 'direct';
  if (cfg.mode === 'allproxy') return 'fixed_servers';
  return 'pac_script';
}

async function apply(cfg) {
  if (applying) { pendingApply = true; return; }
  applying = true;
  try {
    if (!cfg.enabled) {
      await proxyClear();
    } else if (cfg.mode === 'direct') {
      await proxySet({ mode: 'direct' });
    } else if (offline && cfg.failOpen) {
      await proxySet({ mode: 'direct' });
    } else if (cfg.mode === 'allproxy') {
      const port = Number(cfg.proxyPort) > 0 ? Number(cfg.proxyPort) : 7897;
      await proxySet({
        mode: 'fixed_servers',
        rules: {
          singleProxy: { scheme: 'http', host: String(cfg.proxyHost || '127.0.0.1'), port: port },
          bypassList: ['localhost', '127.0.0.1', '[::1]']
        }
      });
    } else {
      await proxySet({ mode: 'pac_script', pacScript: { data: buildPac(cfg) } });
    }
    // 关键：写入成功必须清空上一次的失败记录，否则面板红条会永远挂着（能用却报错）
    if (lastError) lastError = '';
    // 角标不再写死模式文字，改为反映当前页面实际路由（绿=直连/紫=代理）
    await refreshRouteBadge();
  } catch (err) {
    lastError = String(err && err.message ? err.message : err);
    console.error('[智路] 代理设置失败:', err);
    badgeDot('error');
  } finally {
    applying = false;
    if (pendingApply) {
      pendingApply = false;
      getCfg().then(apply);
    }
  }
}

/* ------------------------------------------------- proxy liveness --- */
async function proxyAlive(cfg) {
  const port = Number(cfg.proxyPort) > 0 ? Number(cfg.proxyPort) : 7897;
  const host = String(cfg.proxyHost || '127.0.0.1');
  let lastErr = '';
  // 连探 2 次：SW 冷启动时网络栈未就绪，单次失败不能算端口死了
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    try {
      // Chrome 始终直连 loopback，所以这里探测的是 Clash 进程本身是否活着
      await fetch('http://' + host + ':' + port + '/', {
        signal: ctl.signal, mode: 'no-cors', cache: 'no-store'
      });
      lastLivenessError = '';
      return true;
    } catch (e) {
      lastErr = String(e && e.message ? e.message : e);
    } finally {
      clearTimeout(timer);
    }
  }
  lastLivenessError = lastErr;
  return false;
}

async function healthTick() {
  const cfg = await getCfg();
  if (!cfg.enabled || cfg.mode === 'direct') { missCount = 0; return; }
  const alive = await proxyAlive(cfg);
  if (!alive) {
    missCount++;
    // 连续 3 次（约 3 分钟）失败才降级，避免冷启动误判
    if (missCount >= 3 && !offline) {
      offline = true;
      await apply(cfg);
    }
  } else {
    missCount = 0;
    if (offline) {
      offline = false;
      await apply(cfg);
    }
  }
}

/* ----------------------------------------------------- kernel detection --- */
/* 并行探测常见本地代理内核端口；命中后读各内核的 /version 端点识别名称。
 * 只读探测，不改任何内核设置。端口不通时返回 found:false，供面板提示"先装内核"。 */
const KERNEL_PORTS = [
  { port: 7897, name: 'Clash Verge / Mihomo' },
  { port: 7890, name: 'Clash / Clash for Windows' },
  { port: 7891, name: 'Clash (备用端口)' },
  { port: 7898, name: 'Clash Verge (备用端口)' },
  { port: 9090, name: 'Clash API' },
  { port: 10809, name: 'v2rayN / v2rayA' },
  { port: 10808, name: 'v2rayN (HTTP)' },
  { port: 1080, name: 'SOCKS 代理' },
  { port: 2080, name: 'sing-box' },
  { port: 2081, name: 'sing-box (混合)' },
  { port: 2017, name: 'Surge' },
  { port: 6152, name: 'Clash Verge (旧版)' }
];

async function probePort(host, port, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 1200);
  try {
    // no-cors：代理端口对 GET / 通常回 400/407，但只要进程在监听就不抛错
    await fetch('http://' + host + ':' + port + '/', {
      signal: ctl.signal, mode: 'no-cors', cache: 'no-store'
    });
    return true;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probeVersion(host, port) {
  // 各内核的只读版本端点，命中即可确认内核名/版本
  const eps = [
    { path: '/version', parse: (j) => (j && (j.version || j.Mihomo || j.Clash)) || '' },
    { path: '/v1/version', parse: (j) => (j && (j.version || j.tag)) || '' }
  ];
  for (const ep of eps) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1000);
    try {
      const r = await fetch('http://' + host + ':' + port + ep.path, {
        signal: ctl.signal, cache: 'no-store'
      });
      if (!r.ok) continue;
      const txt = await r.text();
      let v = '';
      try { v = ep.parse(JSON.parse(txt)); } catch (e) { v = txt.slice(0, 60); }
      if (v) return String(v).slice(0, 80);
    } catch (e) { /* continue */ }
    finally { clearTimeout(timer); }
  }
  return '';
}

async function detectKernels(cfg) {
  const host = String(cfg.proxyHost || '127.0.0.1');
  const hits = await Promise.all(KERNEL_PORTS.map(async (k) => ({
    ...k, alive: await probePort(host, k.port, 1200)
  })));
  const alivePorts = hits.filter((h) => h.alive).map((h) => h.port);
  // 优先选与当前配置端口一致的，其次按 KERNEL_PORTS 顺序（Clash 系优先）
  let best = hits.find((h) => h.alive && h.port === Number(cfg.proxyPort));
  if (!best) best = hits.find((h) => h.alive);
  let version = '';
  if (best) version = await probeVersion(host, best.port);
  return {
    ok: true,
    found: !!best,
    port: best ? best.port : null,
    name: best ? best.name : '',
    version: version,
    alivePorts: alivePorts,
    checkedAt: new Date().toISOString()
  };
}

/* -------------------------------------------------- Clash API (read only) */
async function clashStatus(cfg) {
  const base = 'http://' + String(cfg.clashApiHost || '127.0.0.1') + ':' + (Number(cfg.clashApiPort) || 9097);
  const headers = cfg.clashSecret ? { Authorization: 'Bearer ' + cfg.clashSecret } : {};
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);
  try {
    const vr = await fetch(base + '/version', { headers, signal: ctl.signal, cache: 'no-store' });
    if (!vr.ok) throw new Error('version HTTP ' + vr.status);
    const v = await vr.json();
    let mode = '—';
    let node = '—';
    try {
      const cr = await fetch(base + '/configs', { headers, signal: ctl.signal, cache: 'no-store' });
      if (cr.ok) {
        const c = await cr.json();
        mode = c.mode || '—';
      }
    } catch (e) { /* optional */ }
    try {
      const pr = await fetch(base + '/proxies', { headers, signal: ctl.signal, cache: 'no-store' });
      if (pr.ok) {
        const p = await pr.json();
        const groups = Object.keys(p.proxies || {})
          .map((k) => p.proxies[k])
          .filter((x) => x && x.now && (x.type === 'Selector' || x.type === 'Fallback' || x.type === 'URLTest'));
        if (groups.length) node = groups[0].now;
      }
    } catch (e) { /* optional */ }
    return { ok: true, version: v.version || '—', mode: mode, node: node };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------ IP / region --- */
/* 双通道探测：
 *  - 代理出口：请求 Cloudflare 的 cdn-cgi/trace（不限流、无需 key）—— PAC 判为海外 → 走代理
 *    → 返回出口 ip / loc(国家) / colo(机场代码)。原用 ipinfo.io 免费额度对共享出口常 429，已弃用。
 *  - 本机真实：请求国内服务 myip.ipip.net —— PAC 判为国内 → 直连 → 得到本机公网 IP/地区
 * 两个请求都经过 Chrome 网络栈，因此结果就是「用户当前实际的分流效果」，不是理论值。 */
const COUNTRY_ZH = {
  CN: '中国', HK: '中国香港', MO: '中国澳门', TW: '中国台湾', JP: '日本', KR: '韩国',
  SG: '新加坡', US: '美国', CA: '加拿大', GB: '英国', DE: '德国', FR: '法国', NL: '荷兰',
  AU: '澳大利亚', NZ: '新西兰', IN: '印度', RU: '俄罗斯', TH: '泰国', MY: '马来西亚',
  VN: '越南', PH: '菲律宾', ID: '印度尼西亚', BR: '巴西', MX: '墨西哥', IT: '意大利',
  ES: '西班牙', CH: '瑞士', SE: '瑞典', NO: '挪威', FI: '芬兰', IE: '爱尔兰', BE: '比利时',
  AT: '奥地利', PL: '波兰', TR: '土耳其', AE: '阿联酋', IL: '以色列', ZA: '南非'
};
function countryZh(code) {
  if (!code) return '—';
  const c = String(code).toUpperCase();
  return COUNTRY_ZH[c] || c;
}
function orgShort(org) {
  if (!org) return '';
  return String(org).replace(/^AS\d+\s*/i, '').replace(/\s*Co\.,?\s*Ltd\.?/gi, '').slice(0, 44);
}
// Cloudflare 机场代码 → 城市（常见节点，未列出的直接显示代码）
const CF_COLO = {
  NRT: '东京', HND: '东京', KIX: '大阪', ICN: '首尔', SIN: '新加坡', HKG: '中国香港',
  TPE: '中国台湾', LAX: '洛杉矶', SFO: '旧金山', SEA: '西雅图', ORD: '芝加哥', JFK: '纽约',
  LHR: '伦敦', CDG: '巴黎', FRA: '法兰克福', AMS: '阿姆斯特丹', SYD: '悉尼', MEL: '墨尔本'
};
async function fetchText(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 8000);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store', redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(timer); }
}
async function detectProxyExit() {
  try {
    // Cloudflare trace：纯文本 key=value，无限流、无需 API key
    const txt = await fetchText('https://www.cloudflare.com/cdn-cgi/trace', 9000);
    const kv = {};
    txt.split('\n').forEach((line) => {
      const i = line.indexOf('=');
      if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    });
    const ip = kv.ip || '';
    if (!ip) throw new Error('no ip in cloudflare trace');
    const country = kv.loc || '';
    const colo = kv.colo || '';
    const city = CF_COLO[colo] || colo || '';
    return {
      ok: true, ip: ip,
      country: country,
      countryZh: countryZh(country),
      region: '', city: city,
      org: '', colo: colo,
      place: [countryZh(country), city].filter(Boolean).join(' · ') || '—'
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}
async function detectLocalIp() {
  try {
    const txt = await fetchText('https://myip.ipip.net', 9000);
    // 形如：当前 IP：203.0.113.45  来自于：中国 广东 深圳  移动
    const m = txt.match(/(?:当前\s*IP|IP)\s*[：:]\s*([\d.]+)([\s\S]*)/i);
    if (!m) throw new Error('unexpected format: ' + txt.slice(0, 60));
    const place = String(m[2] || '').replace(/来自于[：:]/, '').replace(/\s+/g, ' ').trim();
    return { ok: true, ip: m[1], place: place || '—' };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}
async function ipInfo() {
  const [exit, local] = await Promise.all([detectProxyExit(), detectLocalIp()]);
  let verdict = '';
  let kind = 'ok';
  if (!exit.ok || !local.ok) {
    kind = 'warn';
    verdict = '代理通道探测有一路失败，结果可能不完整';
  } else if (exit.ip === local.ip) {
    kind = 'warn';
    verdict = '代理出口与本机相同 —— 代理通道未生效';
  } else if (exit.country === 'CN') {
    kind = 'warn';
    verdict = '代理出口落在境内 —— 节点可能未生效或为国内节点';
  } else {
    verdict = '代理通道已连通（出口在境外，与本机不同）';
  }
  return { ok: true, exit: exit, local: local, verdict: verdict, kind: kind,
           checkedAt: new Date().toISOString() };
}

/* ------------------------------------------------------------ events --- */
chrome.runtime.onInstalled.addListener(async () => {
  await applyStoredRules();
  const cfg = await getCfg();
  await chrome.storage.local.set({ cfg: cfg });
  chrome.alarms.create('zhilu-health', { periodInMinutes: 1 });
  chrome.alarms.create('zhilu-rules', { periodInMinutes: 1440 });  // 规则库每日更新
  // healthTick 会做端口探测（代理没开时最多两次 2.5s 超时），不能挡在 apply 前面：
  // 否则装完扩展第一次点图标要干等好几秒。探测结果下一分钟还会再测。
  healthTick().catch(() => {});
  await apply(cfg);
});

chrome.runtime.onStartup.addListener(async () => {
  await applyStoredRules();
  chrome.alarms.create('zhilu-health', { periodInMinutes: 1 });
  chrome.alarms.create('zhilu-rules', { periodInMinutes: 1440 });
  const cfg = await getCfg();
  await apply(cfg);
});

/* 切换标签 / 页面导航完成 → 刷新工具栏角标，让它始终反映当前页面路由 */
if (chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener(() => { refreshRouteBadge(); });
}
if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo && changeInfo.status === 'complete') refreshRouteBadge();
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'zhilu-health') healthTick();
  if (alarm.name === 'zhilu-rules') {
    (async () => {
      const r = await updateRulesFromApnic();
      if (r.ok) await apply(await getCfg());   // 新规则重建 PAC
    })().catch(() => {});
  }
});

chrome.proxy.settings.onChange.addListener(() => {
  // 外部改动代理时不强行抢回，避免与用户手动操作打架；下次设置变更会重新接管。
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const cfg = await getCfg();
    switch (msg && msg.type) {
      // 面板一打开就强制重刷工具栏状态灯：SW 可能是在后台被唤醒的，
      // 那一刻拿不到活动标签，灯会停在旧值/灰点。
      case 'refreshBadge':
        await refreshRouteBadge({ force: true });
        sendResponse({ ok: true, kind: lastIconKind });
        break;
      case 'getState': {
        let actual = lastActualMode;
        let levelOfControl = 'unknown';
        let readError = '';
        try {
          // proxy 读取偶尔会卡在 Chrome 代理服务上；面板首屏不能因此被拖住。
          // 800ms 拿不到就先回上次已知值，下次 getState 再修正。
          const s = await Promise.race([
            proxyGet(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('proxy 读取超时')), 800))
          ]);
          actual = (s && s.value ? s.value.mode : 'unknown') || 'unknown';
          levelOfControl = s && s.levelOfControl ? s.levelOfControl : 'unknown';
          if (actual !== 'unknown') lastActualMode = actual;
        } catch (e) {
          readError = String(e && e.message ? e.message : e);
        }
        sendResponse({
          ok: true,
          cfg: cfg,
          offline: offline,
          missCount: missCount,
          actual: actual,
          levelOfControl: levelOfControl,
          lastError: lastError || readError,
          livenessError: lastLivenessError,
          meta: Object.assign({}, ACTIVE_META, { ageDays: rulesAgeDays() })
        });
        break;
      }
      case 'retry': {
        offline = false;
        missCount = 0;
        lastError = '';
        lastLivenessError = '';
        await apply(await getCfg());
        const fresh = await proxyGet().catch(() => null);
        sendResponse({ ok: true, actual: fresh && fresh.value ? fresh.value.mode : 'unknown' });
        break;
      }
      case 'set':
        sendResponse({ ok: true, cfg: await setCfg(msg.patch) });
        break;
      case 'clashStatus':
        sendResponse(await clashStatus(cfg));
        break;
      case 'proxyAlive':
        sendResponse({ ok: await proxyAlive(cfg) });
        break;
      case 'detectKernel':
        sendResponse(await detectKernels(cfg));
        break;
      case 'ipInfo':
        sendResponse(await ipInfo());
        break;
      case 'trafficStats': {
        const uptimeSec = Math.floor((Date.now() - traffic.startedAt) / 1000);
        sendResponse({
          ok: true,
          stats: {
            direct: { bytes: traffic.direct.bytes, requests: traffic.direct.requests },
            proxy:  { bytes: traffic.proxy.bytes,  requests: traffic.proxy.requests },
            uptimeSec: uptimeSec,
            startedAt: traffic.startedAt
          }
        });
        break;
      }
      case 'rulesStatus': {
        sendResponse({ ok: true, meta: Object.assign({}, ACTIVE_META, { ageDays: rulesAgeDays() }) });
        break;
      }
      case 'updateRules': {
        const r = await updateRulesFromApnic();
        if (r.ok) await apply(await getCfg());
        sendResponse(r);
        break;
      }
      case 'currentRoute': {
        let host = '';
        let url = '';
        let title = '';
        try {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          const tab = tabs && tabs[0];
          if (tab) {
            url = tab.url || tab.pendingUrl || '';
            title = tab.title || '';
            if (url && /^https?:\/\//i.test(url)) {
              try { host = new URL(url).hostname; } catch (_) { host = ''; }
            }
          }
        } catch (_) { /* 无 tabs 权限时返回 unavailable */ }
        if (!host) {
          sendResponse({ ok: true, available: false, host: '', url: url, title: title,
            decision: { decision: 'unknown', via: '无法读取当前标签页', detail: '需 tabs 权限或非网页' } });
        } else {
          const d = classifyHost(host, cfg);
          sendResponse({ ok: true, available: true, host: host, url: url, title: title,
            decision: d, checkedAt: new Date().toISOString() });
        }
        break;
      }
      case 'testOverseas': {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 7000);
        const t0 = Date.now();
        try {
          const r = await fetch('https://www.google.com/generate_204', {
            signal: ctl.signal, cache: 'no-store', redirect: 'follow'
          });
          sendResponse({ ok: r.ok || r.status === 204, status: r.status, ms: Date.now() - t0 });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e), ms: Date.now() - t0 });
        } finally {
          clearTimeout(timer);
        }
        break;
      }
      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })();
  return true; // async sendResponse
});

// SW 冷启动兜底。
// ⚠️ 代理设置是浏览器持久化的：SW 被回收再唤醒后 chrome.proxy.settings 仍然有效，
// 不需要每次冷启动都重写。旧版无条件 apply → buildPac 要拼接 + 逐字符转义约 115KB
// 规则库并写回 proxy，这段同步 CPU 会把 popup 的 getState 挡住，是「点图标半天不出面板」
// 的主因。现在先比对实际模式，一致就直接返回。
chrome.alarms.create('zhilu-health', { periodInMinutes: 1 })
  .then(() => applyStoredRules())
  // 先把状态灯点亮，再比对代理模式：图标绝不能依赖后面的 proxy 读写是否顺利
  .then(() => { refreshRouteBadge({ force: true }); return getCfg(); })
  .then(async (c) => {
    const expected = expectMode(c);
    const cur = await proxyGet().catch(() => null);
    const actual = cur && cur.value ? cur.value.mode : 'unknown';
    // 规则更新走 updateRules 显式 apply，所以这里只需比模式即可
    if (actual === expected && !lastError) return;   // 灯已在上一步点亮
    await apply(c);
  })
  .catch((e) => console.error('[智路] 冷启动失败:', e));
