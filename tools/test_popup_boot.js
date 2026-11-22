/* popup 首屏回归：DOM 桩里跑真实 popup.js，验证
   ① 首帧把 logo 状态灯点成绿/紫（不是灰/无）
   ② 健康卡/状态芯片有文案
   ③ 后台超时（getState 不返回）时面板不空白，状态灯仍有兜底
   用法：node tools/test_popup_boot.js */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');

let fail = 0;
function check(ok, msg) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + msg);
  if (!ok) fail++;
}

function mkEl(id) {
  const classes = new Set();
  const e = {
    id, hidden: false, dataset: {}, children: [], listeners: {}, textContent: '', innerHTML: '',
    style: { props: {}, setProperty(k, v) { this.props[k] = v; }, getPropertyValue(k) { return this.props[k] || ''; } },
    classList: {
      add(...cs) { cs.forEach((c) => classes.add(c)); },
      remove(...cs) { cs.forEach((c) => classes.delete(c)); },
      contains(c) { return classes.has(c); },
      toggle(c, on) { on ? classes.add(c) : classes.delete(c); },
      _set: classes
    },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { this.children.push(...cs); },
    setAttribute() {}, removeAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100, bottom: 100, right: 100 }; },
    scrollTo() {}, scrollIntoView() {},
    animate() { return { onfinish: null, cancel() {} }; },
    offsetTop: 0, offsetLeft: 0, offsetWidth: 100, offsetHeight: 40,
    disabled: false, checked: false, open: false
  };
  Object.defineProperty(e, 'className', {
    get() { return Array.from(classes).join(' '); },
    set(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); }
  });
  return e;
}

const els = {};
const doc = {
  getElementById(id) { return (els[id] = els[id] || mkEl(id)); },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement(tag) { return mkEl('new-' + tag); },
  addEventListener() {},
  body: mkEl('body'),
  documentElement: mkEl('html')
};

const STATE = {
  ok: true,
  cfg: { enabled: true, mode: 'smart', proxyHost: '127.0.0.1', proxyPort: 7897, forceDirect: [], forceProxy: [], dnsCheck: true, cnDomainList: true, failOpen: true },
  actual: 'pac_script', levelOfControl: 'controlled_by_this_extension', offline: false, lastError: '',
  meta: { v4: 5500, v6: 2019, domains: 122, generated: '2026-11-21' }
};

function runPopup(opts = {}) {
  Object.keys(els).forEach((k) => delete els[k]);
  const reply = (type) => {
    if (opts.hang && type === 'getState') return null; // 永不回调
    switch (type) {
      case 'getState': return STATE;
      case 'proxyAlive': return { ok: true, ms: 11 };
      case 'currentRoute': return { available: true, host: 'www.baidu.com', decision: { decision: 'direct', via: '中国域名库 · baidu.com' } };
      case 'detectKernel': return { ok: true, found: true, port: 7897, name: 'Clash Verge', version: 'v1.7.7', alivePorts: [7897] };
      case 'trafficStats': return { ok: true, stats: { direct: { bytes: 100, requests: 2 }, proxy: { bytes: 50, requests: 1 }, uptimeSec: 60, startedAt: Date.now() - 60000 } };
      case 'ipInfo': return { ok: true, kind: 'ok', verdict: 'ok', exit: { ok: true, ip: '1.1.1.1', country: 'JP', region: '东京' }, local: { ok: true, ip: '2.2.2.2', country: 'CN', region: '广东' } };
      case 'rulesStatus': return { ok: true, ageDays: 1, meta: STATE.meta };
      default: return { ok: true };
    }
  };
  const sent = [];
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        sent.push(msg && msg.type);
        const r = reply(msg && msg.type);
        if (r === null) return true;              // 模拟不回调
        if (cb) setTimeout(() => cb(r), 5);
        return true;
      },
      getURL: (p) => 'chrome-extension://t/' + p
    },
    storage: {
      local: {
        get(k) {
          const data = opts.emptyStorage ? {} : { cfg: STATE.cfg };
          const keys = Array.isArray(k) ? k : [k];
          const out = {};
          for (const key of keys) if (data[key] !== undefined) out[key] = data[key];
          return Promise.resolve(out);
        },
        set() { return Promise.resolve(); }
      }
    },
    proxy: {
      settings: {
        get(o, cb) {
          const d = (opts.emptyStorage || opts.noProxy) ? {}
            : { value: { mode: opts.proxyMode || 'pac_script' }, levelOfControl: 'controlled_by_this_extension' };
          if (cb) { setTimeout(() => cb(d), 2); return; }
          return Promise.resolve(d);
        }
      }
    }
  };
  const lsMap = new Map();
  const localStorage = {
    getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
    setItem: (k, v) => { lsMap.set(k, String(v)); },
    removeItem: (k) => { lsMap.delete(k); }
  };
  if (opts.cacheState) {
    localStorage.setItem('zl-last-state-v1', JSON.stringify({ at: Date.now(), s: opts.cacheState }));
  }
  const ctx = {
    chrome, document: doc, console, setTimeout, clearTimeout, setInterval, clearInterval, localStorage,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    window: { matchMedia: () => ({ matches: false }), addEventListener() {}, devicePixelRatio: 1, __ZL_MSG_TIMEOUT__: 300 },
    navigator: { userAgent: 'test' }, performance: { now: () => Date.now() },
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
    parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent, URL, Set, Map
  };
  ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(js, ctx, { filename: 'popup.js' });
  els.__sent = sent;
  return els;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n[场景 A] 后台正常应答');
  {
    const e = runPopup();
    await sleep(400);
    const dot = e.logoRouteDot && e.logoRouteDot.className;
    check(/is-(green|purple)/.test(dot || ''), 'logo 状态灯点亮（绿/紫）→ ' + dot);
    check(!!(e.healthTitle && e.healthTitle.textContent), '健康卡标题有文案 → ' + (e.healthTitle && e.healthTitle.textContent));
    check(!!(e.statusChip && e.statusChip.textContent), '状态芯片有文案 → ' + (e.statusChip && e.statusChip.textContent));
    check(!!(e.routeCnHost && e.routeCnHost.textContent), '路由条显示当前域名 → ' + (e.routeCnHost && e.routeCnHost.textContent));
    check((e.__sent || []).includes('refreshBadge'), '首帧主动重刷工具栏状态灯 → ' + (e.__sent || []).join(','));
  }

  console.log('\n[场景 B] 后台 getState 不回（模拟冷启动卡住）');
  {
    const e = runPopup({ hang: true, emptyStorage: true });   // 后台不回 + 本地也读不到
    await sleep(4800);
    const dot = e.logoRouteDot && e.logoRouteDot.className;
    check(/is-warn/.test(dot || ''), '后台与本地都读不到时，状态灯是可见的琥珀（不是灰/无）→ ' + dot);
    check((e.statusChip && e.statusChip.textContent) === '后台无响应', '明确报后台无响应 → ' + (e.statusChip && e.statusChip.textContent));
    check(!!(e.healthSub && e.healthSub.textContent), '健康卡副标题有提示 → ' + (e.healthSub && e.healthSub.textContent));
  }

  console.log('\n[场景 D] 后台 getState 完全不回，但本地可读（本次修复的核心路径）');
  {
    const e = runPopup({ hang: true });
    await sleep(1400);
    check((e.healthTitle && e.healthTitle.textContent) === '分流正常',
      '首屏靠本地直读出真实状态 → ' + (e.healthTitle && e.healthTitle.textContent));
    check(!/扩展后台未响应/.test((e.healthSub && e.healthSub.textContent) || ''),
      '后台没回也不写「后台无响应」→ ' + (e.healthSub && e.healthSub.textContent));
    check(!!(e.logoRouteDot && /is-(green|violet|warn)/.test(e.logoRouteDot.className || '')),
      '状态灯不是空白 → ' + (e.logoRouteDot && e.logoRouteDot.className));
  }

  console.log('\n[场景 E] 有上次快照 + 后台不回 → 快照立刻顶上');
  {
    const cache = JSON.parse(JSON.stringify(STATE));
    const e = runPopup({ hang: true, cacheState: cache });
    await sleep(80);
    check((e.healthTitle && e.healthTitle.textContent) === '分流正常',
      '快照同步出内容（80ms 内）→ ' + (e.healthTitle && e.healthTitle.textContent));
  }

  console.log('\n结果：' + (fail ? fail + ' 失败' : '全部通过'));
  process.exit(fail ? 1 : 0);
})();
