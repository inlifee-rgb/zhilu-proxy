/* 五种交互动效 —— 纯 Node DOM 桩回归（无需浏览器）
 * 验证：液态胶囊位移+拉伸回弹 / 聚光标尺与≤4°倾斜 / 详情展开填充 / dock 联动 /
 *       猫避开 dock 遮挡区。
 * 运行：node tools/test_effects.js
 */
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

// ---- 通用桩工具 ----
function mkEl(id, extra) {
  const e = {
    id, hidden: false, dataset: {}, children: [], listeners: {},
    style: { props: {}, setProperty(k, v) { this.props[k] = v; }, getPropertyValue(k) { return this.props[k] || ''; } },
    classList: {
      s: new Set(),
      add(...cs) { cs.forEach(c => this.s.add(c)); },
      remove(...cs) { cs.forEach(c => this.s.delete(c)); },
      contains(c) { return this.s.has(c); },
      toggle(c, on) { on ? this.s.add(c) : this.s.delete(c); }
    },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    fire(t, ev) { (this.listeners[t] || []).forEach(fn => fn(ev || {})); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100, bottom: 100, right: 100 }; },
    scrollIntoView() { this.scrolled = true; },
    ...extra
  };
  return e;
}

// 三个模式按钮
const segSmart = mkEl('segSmart', { offsetLeft: 4, offsetWidth: 100 });
const segDirect = mkEl('segDirect', { offsetLeft: 108, offsetWidth: 100 });
const segAll = mkEl('segAll', { offsetLeft: 212, offsetWidth: 100 });
[segSmart, segDirect, segAll].forEach((b, i) => b.dataset.mode = ['smart', 'direct', 'allproxy'][i]);

// pill 支持 Web Animations API：记录关键帧供断言
const pill = mkEl('segPill', {
  animate(frames, opts) {
    this._frames = frames;
    this._animOpts = opts;
    const a = { onfinish: null, cancel() { this.cancelled = true; } };
    this._anim = a;
    return a;
  }
});
const seg = mkEl('modeSegment', {
  querySelector(sel) {
    if (sel.includes('is-active')) return [segSmart, segDirect, segAll].find(b => b.classList.contains('is-active'));
    return null;
  }
});
segSmart.classList.add('is-active');

// 详情层元素
const detailEls = {};
['detailLayer', 'dHero', 'dActual', 'dControl', 'dPort', 'dKernel', 'dCoverage', 'dOffline', 'dError', 'detailOpenBtn', 'detailCloseBtn']
  .forEach(id => detailEls[id] = mkEl(id));
detailEls.detailLayer.hidden = true;

// 停靠栏
const dockItems = [
  mkEl('dock0', { dataset: { scroll: 'healthCard', label: '状态' } }),
  mkEl('dock1', { dataset: { scroll: 'kernelCard', label: '内核' } }),
  mkEl('dock2', { dataset: { scroll: 'healthCard', label: '出口' } }),
  mkEl('dock3', { dataset: { action: 'test', label: '连通' } }),
  mkEl('dock4', { dataset: { scroll: 'advancedFold', label: '设置' } })
];
const dockEl = mkEl('dock', { querySelectorAll: () => dockItems, getBoundingClientRect: () => ({ height: 50, left: 0, top: 0 }) });

// 聚光卡片
function mkSpotlight() {
  return mkEl('spot', {
    listeners: {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 200, height: 100, bottom: 100 }; }
  });
}
const spotCards = [mkSpotlight(), mkSpotlight(), mkSpotlight()];

// 滚动容器桩：记录 scrollTo 目标，供 dock 定位断言
const appStub = mkEl('app', {
  offsetTop: 0, scrollTop: 0,
  scrollTo(o) { this._scrollTo = o; this.scrollTop = o.top; }
});

// 全局 document 桩
const allById = Object.assign({ modeSegment: seg, segPill: pill, dock: dockEl, app: appStub }, detailEls,
  { testBtn: mkEl('testBtn'),
    healthCard: mkEl('healthCard', { offsetTop: 60 }),
    kernelCard: mkEl('kernelCard', { offsetTop: 180 }),
    ipCard: mkEl('ipCard', { offsetTop: 300 }),
    advancedFold: mkEl('advancedFold', { offsetTop: 400 }) });

const documentStub = {
  getElementById(id) { return allById[id] || null; },
  querySelector(sel) {
    if (sel === '.dock') return dockEl;
    if (sel === '.modeSegment' || sel === '#modeSegment') return seg;
    return null;
  },
  querySelectorAll(sel) {
    if (sel === '.spotlight') return spotCards;
    if (sel === '.dock-item') return dockItems;
    if (sel === '[data-detail-close]') return [detailEls.detailCloseBtn];
    if (sel === '.seg') return [segSmart, segDirect, segAll];
    return [];
  },
  addEventListener() {}
};

let NOW = 0;
const ctx = {
  document: documentStub, console,
  window: { matchMedia: () => ({ matches: false }), addEventListener() {} },
  matchMedia: () => ({ matches: false }),
  performance: { now: () => NOW },
  requestAnimationFrame: (fn) => { setTimeout(() => fn(NOW), 0); return 1; },
  cancelAnimationFrame: () => {},
  setTimeout: (fn, ms) => setTimeout(fn, 0), clearTimeout: (t) => clearTimeout(t),
  Math, Set, Object, Date, JSON, Array
};

// 抽取动效控制器段（从 liquid pill 到 bindings 之前）
const s = js.indexOf('/* ── 液态玻璃选中');
const e = js.indexOf('/* ── bindings');
const segCode = js.slice(s, e);
// 单独抽取 ruleAgeLabel 纯函数（位于文件顶部，不在 segCode 区间）
const raStart = js.indexOf('function ruleAgeLabel(m)');
const raEnd = js.indexOf('function renderRuleAge', raStart);
const ruleAgeCode = js.slice(raStart, raEnd);
vm.createContext(ctx);
vm.runInContext('const $ = (id) => document.getElementById(id);\n' + ruleAgeCode + '\n' + segCode + `
  globalThis.__fx = { movePill, initSpotlights, fillDetail, openDetail, closeDetail, initDock, ruleAgeLabel };
  globalThis.__setState = (v) => { state = v; };
  globalThis.__setKernel = (v) => { kernelInfo = v; };
  globalThis.__setPort = (v) => { portAlive = v; };
  var state = null, kernelInfo = null, portAlive = null;
  var MODE_TEXT = { pac_script:'PAC 智能分流', fixed_servers:'全局代理', direct:'直连', system:'跟随系统', unknown:'未接管' };
  function verdict(st){
    if(!st||!st.cfg||!st.cfg.enabled) return {kind:'off',title:'代理已暂停'};
    if(st.lastError) return {kind:'err',title:'代理写入失败'};
    return {kind:'ok',title:'分流正常'};
  }
`, ctx);

const F = ctx.__fx;

// ---- 1. 液态胶囊：首次定位 ----
F.movePill(false);
check(pill.classList.contains('is-ready'), '液态胶囊首次定位后可见');
check(pill.style.props['--pill-x'] === '0px', '胶囊对齐首个 active 段 (x=0)');
check(pill.style.width === '100px', '胶囊宽度=按钮宽度');

// ---- 2. 液态胶囊：切换拉伸 + 回弹（水滴多段形变） ----
segSmart.classList.remove('is-active');
segDirect.classList.add('is-active');
F.movePill(true);
check(parseFloat(pill.style.props['--pill-x']) > 100, '切换后胶囊滑到新段位置');
check(parseFloat(pill.style.props['--pill-sx']) > 1, '滑动瞬间水滴拉伸 (scaleX>1)');
check(parseFloat(pill.style.props['--pill-sy']) < 1, '水滴体积守恒：垂直同步压扁 (scaleY<1)');
check(Array.isArray(pill._frames) && pill._frames.length === 5, '水滴动画为 5 段关键帧');
// 关键帧含拉伸峰值 + 过冲回弹（第3帧 x 越过目标、第4帧缩到 <1）
const f3 = String(pill._frames[2].transform);
const f4 = String(pill._frames[3].transform);
check(/scale\(1\./.test(f3), '关键帧中段有拉伸峰值');
check(/scale\(0\.97/.test(f4), '关键帧末段有过冲回弹 (scale<1)');
check(pill._animOpts && pill._animOpts.duration >= 500, '水滴动画时长足够看清形变 (≥500ms)');

// ---- 3. 聚光标尺：≤4° 倾斜 ----
F.initSpotlights();
spotCards[0].fire('pointermove', { clientX: 200, clientY: 0 }); // 右上角
const ry = parseFloat(spotCards[0].style.props['--ry']);
check(!isNaN(ry) && ry > 0 && ry <= 4, '聚光倾斜 ry 在 (0,4] 度内 (实际 ' + ry + ')');
const rx = parseFloat(spotCards[0].style.props['--rx']);
check(rx > 0 && rx <= 4, '聚光倾斜 rx 在 (0,4] 度内 (实际 ' + rx + ')');
check(spotCards[0].style.props['--sx'] === '100.0%' && spotCards[0].style.props['--sy'] === '0.0%', '光斑坐标跟随光标');
spotCards[0].fire('pointerleave', {});
check(spotCards[0].style.props['--rx'] === '0deg' && spotCards[0].style.props['--sy'] === '50%', '鼠标移出后倾斜与光斑平滑复原');

// ---- 4. 详情展开 + 数据填充 ----
ctx.__setState({ cfg: { enabled: true, proxyHost: '127.0.0.1', proxyPort: 7897 }, actual: 'pac_script',
  levelOfControl: 'controlled_by_this_extension', meta: { v4: 5500, domains: 122 },
  offline: false, missCount: 0, lastError: '' });
ctx.__setKernel({ ok: true, found: true, name: 'Clash Verge / Mihomo' });
ctx.__setPort(true);
F.openDetail();
check(detailEls.detailLayer.hidden === false, '点击后详情层显示');
check(detailEls.dHero.textContent === '分流正常', '详情 hero 取单一裁决结论');
check(detailEls.dActual.textContent === 'PAC 智能分流', '详情填入实际模式');
check(detailEls.dKernel.textContent.indexOf('Mihomo') >= 0, '详情填入内核名称');
check(detailEls.dPort.textContent.indexOf('7897') >= 0 && detailEls.dPort.textContent.indexOf('正常') >= 0, '详情填入端口+状态');
check(detailEls.dError.hidden === true, '无错误时错误行隐藏');
F.closeDetail();
check(!detailEls.detailLayer.classList.contains('is-open'), '关闭后 is-open 移除（触发原路收回）');

// ---- 5. dock 联动放大 + 点击滚动 ----
F.initDock();
dockItems[2].fire('pointerenter', {});
check(dockItems[2].classList.contains('is-hover'), 'dock 当前图标放大');
check(dockItems[1].classList.contains('is-near') && dockItems[3].classList.contains('is-near'), '相邻图标联动轻微放大');
dockItems[2].fire('pointerleave', {});
check(!dockItems[2].classList.contains('is-hover') && !dockItems[1].classList.contains('is-near'), 'dock 移出后复原');
dockItems[0].fire('click', {});
check(appStub._scrollTo && Math.abs(appStub._scrollTo.top - 52) < 0.01,
  'dock 点击按 offsetTop 定位 .app 滚动 (top=52)');
check(allById.healthCard.classList.contains('dock-hit'), 'dock 定位后目标卡闪烁反馈');
check(dockEl.listeners.wheel && dockEl.listeners.wheel.length === 1, 'dock 注册了滚轮转发');

// 滚轮停在 dock 上 → 转发到 .app.scrollTop
const beforeScroll = appStub.scrollTop;
dockEl.fire('wheel', { deltaY: 120, preventDefault() { this._pd = true; } });
check(appStub.scrollTop === beforeScroll + 120, 'dock 滚轮转发到 .app (scrollTop += deltaY)');

// ---- 6. 规则库版本显示（今天/N天前/实时/超期标黄）----
const raCases = [
  [{ generated: '2026-11-21', live: true, ageDays: 2 }, '2 天前 · 实时', false],
  [{ generated: '2026-11-21', live: true, ageDays: 0 }, '今天 · 实时', false],
  [{ generated: '2026-11-21', live: false, ageDays: 45 }, '45 天前', true],
  [{ generated: '2026-11-21' }, '2026-11-21', false],
  [null, '—', false]
];
for (const [m, wantLabel, wantStale] of raCases) {
  const r = F.ruleAgeLabel(m);
  check(r.label === wantLabel && r.stale === wantStale,
    '规则版本 ' + JSON.stringify(m) + ' -> ' + r.label + (r.stale ? ' (超期)' : ''));
}

console.log(fail === 0 ? '\nEFFECTS ALL PASS' : '\n' + fail + ' FAILED');
process.exit(fail === 0 ? 0 : 1);
