/* 吉祥物跨卡片斜跳巡游 —— 纯 Node DOM 桩回归（无需浏览器）
 * 验证：初始贴边 / 蓄力压扁 / 起跳上抛 / 斜向位移 / 落点贴边 / 站点轮换 /
 *       落地后 class 变化不回弹 / 重校准落在当前站点而非健康卡。
 * 运行：node tools/test_roam.js
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

// ---- 极简 DOM 桩 ----
function mkCard(top) {
  return {
    offsetTop: top, offsetLeft: 18, offsetWidth: 384, offsetHeight: 100,
    isConnected: true,
    getBoundingClientRect() { return { top, bottom: top + 100 }; }
  };
}
const CARDS = {
  healthCard:  mkCard(60),
  kernelCard:  mkCard(180),
  trafficCard: mkCard(300),   // 最底部卡，用于 dock 遮挡测试
};
const appStub = {
  offsetTop: 0, scrollTop: 0,
  getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
  addEventListener() {}
};
let observerCb = null;
const elStub = {
  style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
  classList: {
    s: new Set(),
    add(c) { this.s.add(c); if (observerCb) observerCb(); },
    remove(c) { this.s.delete(c); if (observerCb) observerCb(); },
    contains(c) { return this.s.has(c); }
  }
};
let dockStub = null;
const documentStub = {
  getElementById(id) { return id === 'mascot' ? elStub : (CARDS[id] || null); },
  querySelector(sel) { return sel === '.app' ? appStub : (sel === '.dock' ? dockStub : null); }
};

let NOW = 0, timers = [], rafQ = [];
class MutationObserverStub {
  constructor(cb) { observerCb = cb; }
  observe() {}
}
const ctx = {
  document: documentStub, console,
  matchMedia: () => ({ matches: false }),
  performance: { now: () => NOW },
  requestAnimationFrame: (fn) => { rafQ.push(fn); return rafQ.length; },
  __step: (now) => {
    const q = rafQ; rafQ = [];
    NOW = now;
    for (const fn of q) fn(now);
  },
  cancelAnimationFrame: () => { rafQ = []; },
  setTimeout: (fn, ms) => { timers.push(fn); return timers.length; },
  clearTimeout: () => {},
  MutationObserver: MutationObserverStub,
  window: { matchMedia: () => ({ matches: false }), addEventListener() {}, MutationObserver: MutationObserverStub },
  Math, Set, Object, Date, JSON
};

// 只抽取 Mascot IIFE 段落（依赖全局 $ 辅助）
const start = js.indexOf('const Mascot');
const end = js.indexOf("$('testBtn').addEventListener('click', async () =>");
const seg = js.slice(start, end);
vm.createContext(ctx);
vm.runInContext('const $=(id)=>document.getElementById(id);\n' + seg + '\nglobalThis.__Mascot=Mascot;', ctx);

const M = ctx.__Mascot;
M.start();

function pos() {
  const p = elStub.style.props;
  return { x: parseFloat(p['--mx']), y: parseFloat(p['--my']) };
}
function scaleY() { return parseFloat(elStub.style.props['--msy']); }

// 1) 初始位置：健康卡边线 60 - BELLY 29 = 31
const init = pos();
check(Math.abs(init.y - 31) < 0.01 && init.x > 0,
  '初始肚皮贴健康卡边线 (期望 y≈31，实际 ' + init.y.toFixed(1) + ')');

// 2) 触发一次跳：start 时 t0=performance.now()，从 NOW 起逐帧推进
if (timers.length) { const fn = timers.shift(); fn(); }
const t0 = NOW;
let peaked = false, crouched = false;
for (let step = 0; step <= 32; step++) {
  const now = t0 + step * 40;
  ctx.__step(now);
  if (elStub.classList.contains('is-jumping') && scaleY() < 0.96) crouched = true; // 蓄力压扁
  if (pos().y < init.y - 5) peaked = true;                                          // 起跳上抛
}
const after = pos();
check(crouched, '起跳前先蓄力下蹲 (sy<0.96)');
check(peaked, '跳跃有明确上抛弧线（先跳起来，再落下）');
check(Math.abs(after.y - init.y) > 1 || Math.abs(after.x - init.x) > 1,
  '落点发生位移 (斜跳) x=' + after.x.toFixed(1) + ' y=' + after.y.toFixed(1));

// 3) 落点贴某张卡的上边线：健康31 / 内核151 / 流量271
const edges = [31, 151, 271];
check(edges.some((L) => Math.abs(after.y - L) < 0.5),
  '落点贴合卡片上边线 (31/151/271，实际 ' + after.y.toFixed(1) + ')');

// 4) 刚落地时 observer 回调（由 remove is-jumping 触发）不得把猫弹回健康卡
check(Math.abs(pos().y - after.y) < 0.5,
  '落地瞬间 class 变化不回弹（无「跳下去一瞬间回来」）');

// 5) 冷却期之后，卡片 class 变化触发重校准 —— 应停在「当前站点」而非健康卡
NOW += 200;
if (observerCb) observerCb();
check(Math.abs(pos().y - after.y) < 0.5,
  '重校准保持当前站点 (y=' + pos().y.toFixed(1) + '，不闪回健康卡 31)');

// 6) 再触发一次，站点应轮换（y 变化）
const before2 = { ...after };
if (timers.length) { const fn = timers.shift(); fn(); }
const t02 = NOW;
for (let step = 0; step <= 32; step++) ctx.__step(t02 + step * 40);
const after2 = pos();
check(Math.abs(after2.y - before2.y) > 1,
  '站点轮换到下一张卡 (y ' + before2.y.toFixed(1) + ' → ' + after2.y.toFixed(1) + ')');

// 7) 有底部 dock 时：被遮挡的底部卡片不参与站点轮换（猫不跳到 dock 后面）
dockStub = { getBoundingClientRect: () => ({ height: 50 }) };
// 让 trafficCard(top=300,bottom=400) 贴近 app 底(600) 以下的“遮挡”场景：缩小 app 可视底到 420
const realRect = appStub.getBoundingClientRect;
appStub.getBoundingClientRect = () => ({ top: 0, bottom: 440 }); // dock 预留 50+18=68 → 有效底 372
// trafficCard top=300 < 372 仍可见；把 app 底压到 380 → 有效底 312，trafficCard top=300<312 勉强可见
// 再压到 350 → 有效底 282，trafficCard(top=300) 应被排除
appStub.getBoundingClientRect = () => ({ top: 0, bottom: 350 });
const beforeHide = pos();
if (timers.length) { const fn = timers.shift(); fn(); }
const t03 = NOW;
for (let step = 0; step <= 32; step++) ctx.__step(t03 + step * 40);
const after3 = pos();
// trafficCard 边线 y=271；被 dock 遮挡后猫不应落到 271
check(Math.abs(after3.y - 271) > 0.5,
  '底部卡片被 dock 遮挡时不作为落点 (实际 y=' + after3.y.toFixed(1) + ')');
appStub.getBoundingClientRect = realRect;
dockStub = null;

console.log(fail === 0 ? '\nROAM ALL PASS' : '\n' + fail + ' FAILED');
process.exit(fail === 0 ? 0 : 1);
