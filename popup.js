/* 智路 · CN 智能分流代理 — popup 控制器 */
const $ = (id) => document.getElementById(id);

function send(type, patch) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, patch }, (r) => resolve(r || {}));
  });
}

let state = null;
let portAlive = null;

const MODE_TEXT = {
  pac_script: 'PAC 智能分流',
  fixed_servers: '全局代理',
  direct: '直连',
  system: '跟随系统',
  unknown: '未接管'
};

/* 单一健康裁决：所有状态归一到一个结论，杜绝自相矛盾的多条提示 */
function verdict(s) {
  const c = s.cfg;
  if (!c.enabled) {
    return { kind: 'off', chip: '已暂停', title: '代理已暂停', sub: 'Chrome 使用系统默认网络设置' };
  }
  if (s.lastError) {
    return {
      kind: 'err', chip: '需处理', title: '代理写入失败',
      sub: 'Chrome 拒绝了代理设置，点下方重试',
      detail: '错误：' + s.lastError
    };
  }
  if (s.actual === 'unknown' || s.actual === 'system') {
    return {
      kind: 'err', chip: '需处理', title: '尚未接管 Chrome',
      sub: '请在 chrome://extensions 允许「更改代理设置」',
      detail: '读取到的实际模式：' + (MODE_TEXT[s.actual] || s.actual)
    };
  }
  if (s.offline) {
    return {
      kind: 'warn', chip: '已降级', title: '代理离线 · 临时直连',
      sub: 'Clash 未响应，联网不受影响',
      detail: '端口连续失败 ' + (s.missCount || 0) + ' 次，已临时直连，恢复后自动切回'
    };
  }
  if (portAlive === false) {
    return {
      kind: 'warn', chip: '端口异常', title: '代理端口未响应',
      sub: '分流规则仍在，但代理出口连不上',
      detail: '检查 Clash 是否运行、端口是否为 ' + c.proxyPort
    };
  }
  return { kind: 'ok', chip: '运行中', title: '分流正常', sub: 'Chrome 流量已由扩展接管' };
}

const ICONS = {
  ok: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5 10 17l9-10" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 8v5m0 3.5v.01" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M10.3 4.3 2.8 17.2A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.8L13.7 4.3a2 2 0 0 0-3.4 0Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  err: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 8v5m0 3.5v.01" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/></svg>',
  off: '<svg viewBox="0 0 24 24" fill="none"><path d="M7 12h10" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/></svg>'
};

function render(s) {
  state = s;
  const c = s.cfg;
  const v = verdict(s);

  // 健康卡：颜色 / 文案 / 图标统一由 verdict 决定
  const card = $('healthCard');
  card.className = 'health health-' + v.kind;
  $('healthIcon').innerHTML = ICONS[v.kind];
  $('healthTitle').textContent = v.title;
  $('healthSub').textContent = v.sub;

  const chip = $('statusChip');
  chip.className = 'chip ' + (
    v.kind === 'ok' ? 'chip-on' : v.kind === 'off' ? 'chip-off' :
    v.kind === 'warn' ? 'chip-warn' : 'chip-err'
  );
  chip.textContent = v.chip;

  const detail = $('healthDetail');
  detail.hidden = !v.detail;
  if (v.detail) $('healthDetailText').textContent = v.detail;

  $('masterToggle').checked = !!c.enabled;

  $('actualMode').textContent = MODE_TEXT[s.actual] || s.actual || '—';
  $('actualMode').title = s.levelOfControl ? 'Chrome 控制权：' + s.levelOfControl : '';
  const m = s.meta || {};
  $('coverage').textContent = m.v4 ? `${m.v4} 网段 / ${m.domains} 域名` : '—';
  $('proxyStateText').textContent = portAlive === null ? '检测中' : (portAlive ? '正常' : '未响应');

  document.querySelectorAll('.seg').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.mode === c.mode);
  });

  $('proxyHost').value = c.proxyHost;
  $('proxyPort').value = c.proxyPort;

  $('optDns').checked = !!c.dnsCheck;
  $('optDomains').checked = !!c.cnDomainList;
  $('optFailOpen').checked = !!c.failOpen;

  $('ruleCount').textContent = (c.forceDirect || []).length + (c.forceProxy || []).length;
  renderChips('directChips', c.forceDirect, 'direct');
  renderChips('proxyChips', c.forceProxy, 'proxy');
}

function renderChips(elId, list, kind) {
  const el = $(elId);
  el.innerHTML = '';
  if (!list || !list.length) {
    const empty = document.createElement('span');
    empty.className = 'empty';
    empty.textContent = '暂无';
    el.appendChild(empty);
    return;
  }
  list.forEach((domain, idx) => {
    const item = document.createElement('span');
    item.className = 'chip-item';
    const name = document.createElement('span');
    name.textContent = domain;
    name.title = domain;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'chip-x';
    x.textContent = '×';
    x.title = '移除';
    x.dataset.kind = kind;
    x.dataset.index = String(idx);
    item.append(name, x);
    el.appendChild(item);
  });
}

async function save(patch) {
  const r = await send('set', patch);
  if (r.ok && r.cfg) await refresh();
  return r;
}

async function refresh() {
  const s = await send('getState');
  if (!s.ok) { $('actualMode').textContent = '读取失败'; return null; }
  render(s);
  return s;
}

async function checkProxy() {
  const r = await send('proxyAlive');
  portAlive = !!r.ok;
  const dotClass = portAlive ? 'dot-green' : 'dot-amber';
  $('proxyDotText').innerHTML = '<span id="proxyDot" class="dot ' + dotClass + '"></span>' + (portAlive ? '端口正常' : '端口未响应');
  if (state) render(state); // 用新端口状态重算健康结论
  // 自愈：端口正常但后台仍标离线 → 立刻重新接管
  if (portAlive && state && state.offline) {
    await send('retry');
    await refresh();
  }
}

async function retryNow() {
  await send('retry');
  await refresh();
  await checkProxy();
}

/* ── Kernel detection ─────────────────────────────────────────── */
const KERNEL_ICON_OK = '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="5" width="16" height="14" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M8 10h.01M12 10h.01M16 10h.01M8 14h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const KERNEL_ICON_MISS = '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="5" width="16" height="14" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M9 10l6 6m0-6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

async function loadKernel() {
  const card = $('kernelCard');
  const btn = $('kernelScanBtn');
  btn.disabled = true;
  $('kernelTitle').textContent = '检测本地代理内核…';
  $('kernelSub').textContent = '正在扫描常见端口';
  card.className = 'kernel';
  $('kernelIcon').innerHTML = KERNEL_ICON_OK;

  const r = await send('detectKernel');
  btn.disabled = false;
  const install = $('kernelInstall');
  if (!r.ok) {
    card.className = 'kernel kernel-miss';
    $('kernelIcon').innerHTML = KERNEL_ICON_MISS;
    $('kernelTitle').textContent = '内核检测失败';
    $('kernelSub').textContent = r.error || '后台未响应';
    install.hidden = false;
    return;
  }
  if (r.found) {
    card.className = 'kernel kernel-ok';
    $('kernelIcon').innerHTML = KERNEL_ICON_OK;
    $('kernelTitle').textContent = '已识别：' + r.name;
    $('kernelSub').textContent = '端口 ' + r.port + (r.version ? ' · ' + r.version : '') +
      (r.alivePorts && r.alivePorts.length > 1 ? ' · 另发现 ' + (r.alivePorts.length - 1) + ' 个端口' : '');
    install.hidden = true;
  } else {
    card.className = 'kernel kernel-miss';
    $('kernelIcon').innerHTML = KERNEL_ICON_MISS;
    $('kernelTitle').textContent = '未检测到代理内核';
    $('kernelSub').textContent = '本机没有运行中的代理服务端口';
    install.hidden = false;
  }
}

/* ── IP / region 双通道探测 ─────────────────────────────────── */
async function loadIpInfo() {
  const btn = $('ipRefreshBtn');
  btn.disabled = true;
  btn.classList.add('is-spin');
  ['exitIp', 'localIp'].forEach((id) => { $(id).textContent = '检测中'; });
  ['exitPlace', 'exitOrg'].forEach((id) => { $(id).textContent = '—'; });
  $('localPlace').textContent = '—';
  $('localOrg').textContent = '直连出口';
  const v = $('ipVerdict');
  v.className = 'ip-verdict';
  v.textContent = '正在探测出口与本机 IP…';

  const r = await send('ipInfo');
  btn.disabled = false;
  btn.classList.remove('is-spin');
  if (!r.ok) {
    v.className = 'ip-verdict err';
    v.textContent = '探测失败：' + (r.error || '后台未响应');
    return;
  }
  const e = r.exit || {};
  const l = r.local || {};
  $('exitIp').textContent = e.ok ? e.ip : '失败';
  $('exitPlace').textContent = e.ok ? (e.place || '—') : (e.error || '—');
  $('exitOrg').textContent = e.ok ? (e.org || '') : '';
  $('localIp').textContent = l.ok ? l.ip : '失败';
  $('localPlace').textContent = l.ok ? (l.place || '—') : (l.error || '—');
  $('localOrg').textContent = l.ok ? '直连出口' : '';
  v.className = 'ip-verdict' + (r.kind === 'warn' ? ' warn' : '');
  v.textContent = r.verdict || '探测完成';
}

function normalizeDomain(raw) {
  return String(raw || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .replace(/^\./, '');
}

function addRule(kind) {
  const input = $(kind === 'direct' ? 'directInput' : 'proxyInput');
  const domain = normalizeDomain(input.value);
  if (!domain) return;
  const key = kind === 'direct' ? 'forceDirect' : 'forceProxy';
  const cur = (state.cfg[key] || []).slice();
  if (!cur.includes(domain)) cur.push(domain);
  input.value = '';
  save({ [key]: cur });
}

/* ── bindings ───────────────────────────────────────────────── */
$('masterToggle').addEventListener('change', (e) => save({ enabled: e.target.checked }));
document.querySelectorAll('.seg').forEach((btn) => {
  btn.addEventListener('click', () => save({ mode: btn.dataset.mode }));
});
$('proxyHost').addEventListener('change', (e) => save({ proxyHost: e.target.value.trim() || '127.0.0.1' }));
$('proxyPort').addEventListener('change', (e) => {
  const p = Number(e.target.value);
  save({ proxyPort: p >= 1 && p <= 65535 ? p : 7897 });
});
$('optDns').addEventListener('change', (e) => save({ dnsCheck: e.target.checked }));
$('optDomains').addEventListener('change', (e) => save({ cnDomainList: e.target.checked }));
$('optFailOpen').addEventListener('change', (e) => save({ failOpen: e.target.checked }));
$('retryBtn').addEventListener('click', retryNow);
$('ipRefreshBtn').addEventListener('click', loadIpInfo);
$('kernelScanBtn').addEventListener('click', loadKernel);

document.querySelectorAll('[data-add]').forEach((b) => {
  b.addEventListener('click', () => addRule(b.dataset.add));
});
['directInput', 'proxyInput'].forEach((id) => {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addRule(id === 'directInput' ? 'direct' : 'proxy');
  });
});
['directChips', 'proxyChips'].forEach((id) => {
  $(id).addEventListener('click', (e) => {
    const btn = e.target.closest('.chip-x');
    if (!btn) return;
    const key = btn.dataset.kind === 'direct' ? 'forceDirect' : 'forceProxy';
    const cur = (state.cfg[key] || []).slice();
    cur.splice(Number(btn.dataset.index), 1);
    save({ [key]: cur });
  });
});

/* ── 吉祥物巡游：跨卡片斜跳（猫步） ───────────────────────────
 * 猫提升到面板层，站点 = 各卡片上边线。每站随机水平落点 + 抛物线上抛，
 * 呈斜向猫步；滚动/卡片显隐/尺寸变化时重新校准，绝不跳到错误位置。
 * 尊重 prefers-reduced-motion：开启则静止趴在健康卡。
 * ───────────────────────────────────────────────────────────── */
const Mascot = (() => {
  const el = $('mascot');
  const app = document.querySelector('.app');
  if (!el || !app) return { start() {}, recalibrate() {} };

  const reduced = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const STOPS = ['healthCard', 'kernelCard', 'ipCard'];
  const CAT_W = 40, CAT_H = 34;
  let anchorY = 0;        // 猫肚皮相对自身的偏移：SVG y=86.5 / 100 * 34 ≈ 29.4
  const BELLY = 29;
  let cur = { x: 0, y: 0 };
  let raf = 0, timer = 0, stopIdx = 0, alive = false;

  function cardTop(card) {
    // 卡片相对 app 顶部的距离（含滚动）
    return card.offsetTop - app.offsetTop + app.scrollTop;
  }
  function visible(card) {
    const r = card.getBoundingClientRect();
    const a = app.getBoundingClientRect();
    return r.bottom > a.top + 4 && r.top < a.bottom - 4;
  }
  function landing(card) {
    const x = card.offsetLeft + card.offsetWidth - CAT_W - 13 - Math.random() * 46;
    const y = cardTop(card) - BELLY;      // 肚皮压在卡片上边线
    return { x: Math.max(4, x), y };
  }
  function paint(p, rot, scale) {
    el.style.setProperty('--mx', p.x + 'px');
    el.style.setProperty('--my', p.y + 'px');
    el.style.setProperty('--mrot', (rot || 0) + 'deg');
    el.style.setProperty('--msc', scale || 1);
  }

  // 抛物线斜跳：水平平滑插值 + 随机倾斜；垂直上抛再落到目标边线
  function jumpTo(target) {
    const from = { ...cur };
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    const dist = Math.hypot(dx, dy);
    const dur = Math.min(900, 420 + dist * 0.55);       // 距离越远跳越久
    const lift = Math.min(64, 26 + dist * 0.16);        // 上抛高度
    // 猫步：水平方向带一点随机弧线偏移，落点右偏/左偏不完全直线
    const sideBend = (Math.random() * 2 - 1) * Math.min(20, dist * 0.10);
    const tiltDir = dx >= 0 ? 1 : -1;
    const t0 = performance.now();
    el.classList.add('is-jumping');
    cancelAnimationFrame(raf);

    function frame(now) {
      let t = (now - t0) / dur;
      if (t >= 1) t = 1;
      // 水平：缓入缓出 + 侧弯（sin 半波）
      const x = from.x + dx * t + sideBend * Math.sin(Math.PI * t);
      // 垂直：线性基线 - 抛物线上抛（4t(1-t) 峰值在 t=0.5）
      const y = from.y + dy * t - lift * 4 * t * (1 - t);
      // 起跳仰头、落地前爪下探：旋转 + 轻微缩放（腾空放大）
      const rot = tiltDir * (Math.sin(Math.PI * t) * 13 - 5 * t);
      const scale = 1 + 0.09 * Math.sin(Math.PI * t);
      paint({ x, y }, rot, scale);
      if (t < 1) {
        raf = requestAnimationFrame(frame);
      } else {
        cur = { ...target };
        paint(cur, 0, 1);
        el.classList.remove('is-jumping');
      }
    }
    raf = requestAnimationFrame(frame);
  }

  function nextStop() {
    if (!alive) return;
    // 只在可见卡片里选下一站；健康卡始终保留兜底
    const cards = STOPS.map((id) => $(id)).filter(Boolean);
    const vis = cards.filter(visible);
    const pool = vis.length ? vis : cards.slice(0, 1);
    stopIdx = (stopIdx + 1) % pool.length;
    jumpTo(landing(pool[stopIdx]));
    timer = setTimeout(nextStop, 3200 + Math.random() * 1600);
  }

  function calibrate() {
    const cards = STOPS.map((id) => $(id)).filter(Boolean);
    const first = cards[0];
    if (!first) return;
    const base = landing(first);
    // 只在没跳的过程中归位，避免动画中被打断
    if (!el.classList.contains('is-jumping')) {
      cur = { x: base.x, y: base.y };
      paint(cur, 0, 1);
    }
  }

  return {
    start() {
      calibrate();
      if (reduced) return;                 // 静态，不巡游
      alive = true;
      timer = setTimeout(nextStop, 2600);
      app.addEventListener('scroll', () => {
        cancelAnimationFrame(raf);
        clearTimeout(timer);
        if (!el.classList.contains('is-jumping')) alive && (timer = setTimeout(nextStop, 900));
        else alive && (timer = setTimeout(nextStop, 900));
      }, { passive: true });
      window.addEventListener('resize', calibrate);
      // 卡片显隐（内核安装卡/详情卡展开）后重新校准静止位
      if (window.MutationObserver) {
        new MutationObserver(() => {
          if (!el.classList.contains('is-jumping')) calibrate();
        }).observe(app, { attributes: true, subtree: true, attributeFilter: ['hidden', 'class'] });
      }
    },
    recalibrate: calibrate
  };
})();

$('testBtn').addEventListener('click', async () => {
  const btn = $('testBtn');
  const out = $('testResult');
  btn.disabled = true;
  btn.textContent = '测试中';
  out.hidden = false;
  out.className = 'hint';
  out.textContent = '正在请求海外站点…';
  const r = await send('testOverseas');
  btn.disabled = false;
  btn.textContent = '测试连通';
  out.className = 'hint ' + (r.ok ? 'ok' : 'err');
  out.textContent = r.ok
    ? `海外连通正常 · HTTP ${r.status} · ${r.ms}ms`
    : `海外请求失败（${r.error || '超时'}）· 检查 Clash 是否运行、端口是否正确`;
});

(async function init() {
  const s = await refresh();
  if (!s) return;
  const c = s.cfg;

  // 开机自愈：实际模式与配置不符、或后台报错/离线 → 自动重写一次
  const expected = !c.enabled ? null
    : (c.mode === 'direct' ? 'direct' : (c.mode === 'allproxy' ? 'fixed_servers' : 'pac_script'));
  const mismatch = c.enabled && s.actual !== expected && s.actual !== 'unknown';
  if ((c.enabled && s.offline) || mismatch || s.lastError) {
    await retryNow();
  } else {
    await checkProxy();
  }
  loadIpInfo();   // 出口探测独立于健康状态，异步进行不阻塞面板
  loadKernel();   // 内核检测同上
  Mascot.start(); // 吉祥物跨卡片斜跳巡游
})();
