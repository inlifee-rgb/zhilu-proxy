/* 冷启动回归：用 chrome API 桩跑真实 background.js，验证
   ① 模式已一致时是否仍写状态图标（状态灯不能丢）
   ② 模式不一致时是否重写代理并写图标
   ③ getState 消息是否可用
   用法：node tools/test_coldstart.js */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function makeChrome(opts = {}) {
  const calls = { setIcon: [], proxySet: [], proxyGet: 0 };
  const store = Object.assign({}, opts.store || {});
  const listeners = {};
  const settings = {
    mode: opts.actualMode || 'pac_script'
  };
  const api = {
    storage: {
      local: {
        get: (k) => {
          if (typeof k === 'string') return Promise.resolve({ [k]: store[k] });
          if (Array.isArray(k)) {
            const o = {};
            for (const key of k) o[key] = store[key];
            return Promise.resolve(o);
          }
          return Promise.resolve(Object.assign({}, store));
        },
        set: (o) => { Object.assign(store, o); return Promise.resolve(); },
        onChanged: { addListener() {} }
      }
    },
    proxy: {
      settings: {
        get: (details, cb) => {
          calls.proxyGet++;
          const r = { value: Object.assign({}, settings), levelOfControl: 'controlled_by_this_extension' };
          if (typeof cb === 'function') cb(r);
          return Promise.resolve(r);
        },
        set: (details, cb) => {
          calls.proxySet.push(details && details.value);
          if (details && details.value) settings.mode = details.value.mode;
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        },
        clear: (details, cb) => {
          calls.proxySet.push({ cleared: true });
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        },
        onChange: { addListener() {} }
      }
    },
    action: {
      setIcon: (o) => calls.setIcon.push(o && o.path),
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {}
    },
    tabs: {
      query: () => {
        calls.tabQuery = (calls.tabQuery || 0) + 1;
        if (opts.emptyTabTimes && calls.tabQuery <= opts.emptyTabTimes) return Promise.resolve([]);
        return Promise.resolve([{ url: opts.tabUrl || 'https://www.baidu.com/' }]);
      },
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} }
    },
    alarms: {
      create: () => Promise.resolve(),
      clear: () => Promise.resolve(),
      onAlarm: { addListener() {} }
    },
    webRequest: {
      onCompleted: { addListener() {} },
      onBeforeRequest: { addListener() {} }
    },
    runtime: {
      id: 'test-extension',
      getURL: (p) => 'chrome-extension://test-extension/' + p,
      onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
      onStartup: { addListener: (fn) => { listeners.startup = fn; } },
      onMessage: { addListener: (fn) => { listeners.message = fn; } }
    }
  };
  return { api, calls, store, listeners, settings };
}

function loadBackground(opts) {
  const m = makeChrome(opts);
  const ctx = {
    chrome: m.api,
    console: { log() {}, warn() {}, error: (...a) => { m.errPush?.(a.join(' ')); } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, URL, URLSearchParams, TextEncoder, TextDecoder,
    AbortController, fetch: () => Promise.reject(new Error('offline in test')),
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, parseInt, parseFloat, isNaN
  };
  ctx.globalThis = ctx;
  ctx.importScripts = (...files) => {
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      vm.runInContext(src, ctx, { filename: f });
    }
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  const code = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  vm.runInContext(code, ctx, { filename: 'background.js' });
  return { ctx, ...m };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iconName = (p) => {
  if (!p) return '(none)';
  if (typeof p === 'string') return p;
  const v = p[16] || p['16'] || Object.values(p)[0] || '';
  return String(v);
};

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

async function main() {
  console.log('\n[场景 A] SW 冷启动 · 代理模式已一致（不应重写，但必须恢复状态灯）');
  {
    const b = loadBackground({ actualMode: 'pac_script' });
    await sleep(400);
    check('没有重复写 proxy', b.calls.proxySet.length === 0, 'proxySet=' + b.calls.proxySet.length);
    check('写了状态图标', b.calls.setIcon.length > 0, 'setIcon=' + JSON.stringify(b.calls.setIcon));
    check('图标是 direct/proxy 之一', /icon-(direct|proxy)-/.test(iconName(b.calls.setIcon[0])), iconName(b.calls.setIcon[0]));
  }

  console.log('\n[场景 B] SW 冷启动 · 模式不一致（应重写 proxy 并写状态灯）');
  {
    const b = loadBackground({ actualMode: 'direct' });
    await sleep(500);
    check('重写了 proxy', b.calls.proxySet.length > 0, 'proxySet=' + b.calls.proxySet.length);
    check('写了状态图标', b.calls.setIcon.length > 0, 'setIcon=' + JSON.stringify(b.calls.setIcon));
  }

  console.log('\n[场景 C] 用户暂停（enabled=false → 灰点 off）');
  {
    const b = loadBackground({ actualMode: 'system', store: { cfg: { enabled: false } } });
    await sleep(400);
    check('写了 off 图标', /icon-off-/.test(iconName(b.calls.setIcon[0])), iconName(b.calls.setIcon[0]));
  }

  console.log('\n[场景 E] 启动瞬间查不到活动标签（Chrome 还没就绪）');
  {
    const b = loadBackground({ actualMode: 'pac_script', emptyTabTimes: 4 });
    await sleep(1200);
    const painted = b.calls.setIcon.map(iconName);
    check('没有先刷成灰点 off/unknown', !painted.some((p) => /icon-(off)-/.test(p)), JSON.stringify(painted));
    check('重试后点亮 direct/proxy', painted.some((p) => /icon-(direct|proxy)-/.test(p)), JSON.stringify(painted));
  }

  console.log('\n[场景 D] getState 消息往返');
  {
    const b = loadBackground({ actualMode: 'pac_script' });
    await sleep(300);
    const t0 = Date.now();
    const r = await new Promise((res) => {
      const ok = b.listeners.message({ type: 'getState' }, {}, res);
      if (ok !== true) res({ __return: ok });
    });
    check('ok=true', r && r.ok === true, JSON.stringify(r).slice(0, 120));
    check('含 cfg/mode', !!(r && r.cfg && r.cfg.mode), JSON.stringify(r && r.cfg).slice(0, 80));
    check('往返 < 200ms', Date.now() - t0 < 200, (Date.now() - t0) + 'ms');
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS FAIL:', e); process.exit(1); });
