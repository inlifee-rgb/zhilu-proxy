/* 吉祥物跨卡片斜跳巡游 —— 纯 Node DOM 桩回归（无需浏览器）
 * 验证：初始贴健康卡边线 / 抛物线上抛 / 斜向位移 / 落点贴卡片边线 / 站点轮换。
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
    getBoundingClientRect() { return { top, bottom: top + 100 }; }
  };
}
const CARDS = {
  healthCard: mkCard(60),
  kernelCard: mkCard(180),
  ipCard:     mkCard(300),
};
const appStub = {
  offsetTop: 0, scrollTop: 0,
  getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
  addEventListener() {}
};
const elStub = {
  style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
  classList: {
    s: new Set(),
    add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, contains(c) { return this.s.has(c); }
  }
};
const documentStub = {
  getElementById(id) { return id === 'mascot' ? elStub : (CARDS[id] || null); },
  querySelector(sel) { return sel === '.app' ? appStub : null; }
};

let NOW = 0, timers = [], rafQ = [];
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
  MutationObserver: null,
  window: { matchMedia: () => ({ matches: false }), addEventListener() {} },
  Math, Set, Object, Date, JSON
};

// 只抽取 Mascot IIFE 段落（依赖全局 $ 辅助）
const start = js.indexOf('const Mascot');
const end = js.indexOf("$('testBtn')");
const seg = js.slice(start, end);
vm.createContext(ctx);
vm.runInContext('const $=(id)=>document.getElementById(id);\n' + seg + '\nglobalThis.__Mascot=Mascot;', ctx);

const M = ctx.__Mascot;
M.start();

function pos() {
  const p = elStub.style.props;
  return { x: parseFloat(p['--mx']), y: parseFloat(p['--my']) };
}

// 1) 初始位置：健康卡边线 60 - BELLY 29 = 31
const init = pos();
check(Math.abs(init.y - 31) < 0.01 && init.x > 0,
  '初始肚皮贴健康卡边线 (期望 y≈31，实际 ' + init.y.toFixed(1) + ')');

// 2) 触发一次跳：start 时 t0=performance.now()，所以从 NOW 起逐帧推进
if (timers.length) { const fn = timers.shift(); fn(); }
const t0 = NOW;
let peaked = false;
// rAF 回调注册 t0 那一帧后，逐帧把时间往前推；每帧只执行一次注册的回调
for (let step = 0; step <= 30; step++) {
  const now = t0 + step * 40;
  ctx.__step(now);
  if (pos().y < init.y - 5) peaked = true;     // 中途高于起跳点 = 上抛
}
const after = pos();
check(peaked, '跳跃有抛物线上抛弧线');
check(Math.abs(after.y - init.y) > 1 || Math.abs(after.x - init.x) > 1,
  '落点发生位移 (斜跳) x=' + after.x.toFixed(1) + ' y=' + after.y.toFixed(1));

// 3) 落点贴某张卡的上边线：31 / 151 / 271
const edges = [31, 151, 271];
check(edges.some((L) => Math.abs(after.y - L) < 0.5),
  '落点贴合卡片上边线 (31/151/271，实际 ' + after.y.toFixed(1) + ')');

// 4) 再触发一次，站点应轮换（y 变化）
const before2 = { ...after };
if (timers.length) { const fn = timers.shift(); fn(); }
const t02 = NOW;
for (let step = 0; step <= 30; step++) ctx.__step(t02 + step * 40);
const after2 = pos();
check(Math.abs(after2.y - before2.y) > 1,
  '站点轮换到下一张卡 (y ' + before2.y.toFixed(1) + ' → ' + after2.y.toFixed(1) + ')');

console.log(fail === 0 ? '\nROAM ALL PASS' : '\n' + fail + ' FAILED');
process.exit(fail === 0 ? 0 : 1);
