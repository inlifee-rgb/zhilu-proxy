/* 智路 · CN 智能分流代理 — popup 控制器 */
const $ = (id) => document.getElementById(id);

function send(type, patch) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, patch }, (r) => resolve(r || {}));
  });
}

let state = null;
let portAlive = null;
let kernelInfo = null;   // 最近一次内核检测结果，供诊断详情读取

const MODE_TEXT = {
  pac_script: 'PAC 智能分流',
  fixed_servers: '全局代理',
  direct: '直连',
  system: '跟随系统',
  unknown: '未接管'
};

/* 规则库版本：显示"今天/N天前 + 实时/内置"，超 30 天标黄提醒更新。 */
function ruleAgeLabel(m) {
  if (!m) return { label: '—', stale: false };
  const live = !!m.live;
  const age = (typeof m.ageDays === 'number') ? m.ageDays : null;
  const when = m.generated && m.generated !== '—' ? m.generated : '';
  let label;
  if (age === null) label = (when || '内置') + (live ? ' · 实时' : '');
  else if (age <= 0) label = '今天' + (live ? ' · 实时' : '');
  else label = age + ' 天前' + (live ? ' · 实时' : '');
  return { label, stale: age !== null && age > 30 };
}
function renderRuleAge(m) {
  const el = $('ruleAge');
  if (!el) return;
  const r = ruleAgeLabel(m);
  el.textContent = r.label;
  el.classList.toggle('is-stale', r.stale);
  el.title = (m && m.source ? m.source + '\n' : '') + (m && m.generated ? '生成于 ' + m.generated : '内置基线');
}

/* 单一健康裁决：所有状态归一到一个结论，杜绝自相矛盾的多条提示 */
function verdict(s) {
  const c = s.cfg;
  if (!c.enabled) {
    return { kind: 'off', chip: '已暂停', title: '代理已暂停', sub: 'Chrome 使用系统默认网络设置' };
  }
  if (s.lastError) {
    return {
      kind: 'err', chip: '需处理', title: '代理写入失败',
      sub: 'Chrome 拒绝代理设置 · 点右侧 › 诊断并重试'
    };
  }
  if (s.actual === 'unknown' || s.actual === 'system') {
    return {
      kind: 'err', chip: '需处理', title: '尚未接管 Chrome',
      sub: '请允许「更改代理设置」· 点 › 诊断'
    };
  }
  if (s.offline) {
    return {
      kind: 'warn', chip: '已降级', title: '代理离线 · 临时直连',
      sub: 'Clash 未响应，联网不受影响 · 恢复后自动切回'
    };
  }
  if (portAlive === false) {
    return {
      kind: 'warn', chip: '端口异常', title: '代理端口未响应',
      sub: '分流规则仍生效 · 端口 ' + c.proxyPort + ' 连不上'
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
  // 注意：整体赋值 className 时务必保留 glass / spotlight / has-beam，
  // 否则渲染一次就把 HTML 上的特效类冲掉（健康卡/内核卡曾因此失去聚光）
  const card = $('healthCard');
  card.className = 'health health-' + v.kind + ' glass spotlight has-beam';
  $('healthIcon').innerHTML = ICONS[v.kind];
  $('healthTitle').textContent = v.title;
  $('healthSub').textContent = v.sub;

  const chip = $('statusChip');
  chip.className = 'chip ' + (
    v.kind === 'ok' ? 'chip-on' : v.kind === 'off' ? 'chip-off' :
    v.kind === 'warn' ? 'chip-warn' : 'chip-err'
  );
  chip.textContent = v.chip;

  $('masterToggle').checked = !!c.enabled;

  $('actualMode').textContent = MODE_TEXT[s.actual] || s.actual || '—';
  $('actualMode').title = s.levelOfControl ? 'Chrome 控制权：' + s.levelOfControl : '';
  const m = s.meta || {};
  $('coverage').textContent = m.v4 ? `${m.v4} 网段 / ${m.domains} 域名` : '—';
  renderRuleAge(m);
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

  movePill(true);    // 液态胶囊跟随 active 段；展开详情同步数据
  if (!$('detailLayer').hidden) fillDetail();
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
  if (r.ok && r.cfg) { await refresh(); loadRoute(); } // 改模式后重判当前页面路由
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
  const btn = $('retryBtn');
  if (btn) btn.disabled = true;
  try {
    await send('retry');
    await refresh();
    await checkProxy();
  } finally {
    if (btn) btn.disabled = false;
  }
  if ($('detailLayer') && !$('detailLayer').hidden) closeDetail();
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
  card.className = 'kernel glass spotlight';
  $('kernelIcon').innerHTML = KERNEL_ICON_OK;

  const r = await send('detectKernel');
  btn.disabled = false;
  kernelInfo = r;
  const install = $('kernelInstall');
  if (!r.ok) {
    card.className = 'kernel kernel-miss glass spotlight';
    $('kernelIcon').innerHTML = KERNEL_ICON_MISS;
    $('kernelTitle').textContent = '内核检测失败';
    $('kernelSub').textContent = r.error || '后台未响应';
    install.hidden = false;
    return;
  }
  if (r.found) {
    card.className = 'kernel kernel-ok glass spotlight';
    $('kernelIcon').innerHTML = KERNEL_ICON_OK;
    $('kernelTitle').textContent = '已识别：' + r.name;
    $('kernelSub').textContent = '端口 ' + r.port + (r.version ? ' · ' + r.version : '') +
      (r.alivePorts && r.alivePorts.length > 1 ? ' · 另发现 ' + (r.alivePorts.length - 1) + ' 个端口' : '');
    install.hidden = true;
  } else {
    card.className = 'kernel kernel-miss glass spotlight';
    $('kernelIcon').innerHTML = KERNEL_ICON_MISS;
    $('kernelTitle').textContent = '未检测到代理内核';
    $('kernelSub').textContent = '本机没有运行中的代理服务端口';
    install.hidden = false;
  }
}

/* ── 当前页面路由：直接体现在健康卡的「直连 ↔ 代理」示意条上 ── */
/* 命中的一侧亮起 + 显示域名，另一侧灰掉；logo 灯同步：直连=绿、代理=紫 */
async function loadRoute() {
  const bar = $('routeBar');
  const cn = $('routeCn'), os = $('routeOs');
  const cnHost = $('routeCnHost'), osHost = $('routeOsHost');
  const dot = $('logoRouteDot');
  if (!bar || !cn || !os) return;

  // 复位：未判定时两侧中性
  bar.classList.remove('is-resolved');
  cn.classList.remove('is-on'); os.classList.remove('is-on');
  if (cnHost) cnHost.textContent = '';
  if (osHost) osHost.textContent = '';
  if (dot) { dot.className = 'logo-route-dot is-gray'; dot.title = '判定中'; }

  const r = await send('currentRoute');
  const d = (r && r.decision) || {};
  const dec = d.decision;
  const host = r && r.available ? (r.host || '') : '';

  if (dec !== 'direct' && dec !== 'proxy') {
    // 无法判定：两侧都灰，logo 灯用琥珀色提示
    bar.classList.remove('is-resolved');
    if (dot) { dot.className = 'logo-route-dot is-warn'; dot.title = '无法判定当前页面'; }
    return;
  }

  bar.classList.add('is-resolved');
  if (dec === 'direct') {
    cn.classList.add('is-on');
    if (cnHost) cnHost.textContent = host ? ('当前 ' + host) : '';
    if (dot) { dot.className = 'logo-route-dot is-green'; dot.title = '当前页面：直连（绿点）'; }
  } else {
    os.classList.add('is-on');
    if (osHost) osHost.textContent = host ? ('当前 ' + host) : '';
    if (dot) { dot.className = 'logo-route-dot is-purple'; dot.title = '当前页面：走代理（紫点）'; }
  }
  bar.title = host ? (host + ' · ' + (d.via || '') + (d.detail ? ' · ' + d.detail : '')) : '';

  // 判定可解释：明确告诉用户「当前页面因为什么走了这条路」
  const whyBox = $('routeWhy'), whyText = $('routeWhyText');
  if (whyBox && whyText) {
    if (host && d.via) {
      const verdict = dec === 'direct' ? '直连' : '走代理';
      whyText.textContent = host + ' → ' + verdict + '：' + d.via;
      whyBox.hidden = false;
    } else {
      whyBox.hidden = true;
    }
  }
}

/* ── 流量统计：读取后台累计的直连 / 代理字节与请求数 ─────────── */
function fmtBytes(n) {
  n = Math.max(0, Number(n) || 0);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
async function loadTraffic() {
  const dB = $('tfDirectBytes'), dR = $('tfDirectReq');
  const pB = $('tfProxyBytes'), pR = $('tfProxyReq');
  if (!dB || !pB) return;
  const r = await send('trafficStats');
  const t = (r && r.stats) || {};
  if (dB) dB.textContent = fmtBytes(t.direct && t.direct.bytes);
  if (dR) dR.textContent = ((t.direct && t.direct.requests) || 0) + ' 次请求';
  if (pB) pB.textContent = fmtBytes(t.proxy && t.proxy.bytes);
  if (pR) pR.textContent = ((t.proxy && t.proxy.requests) || 0) + ' 次请求';
}

/* ── IP / region 双通道探测 ─────────────────────────────────── */
async function loadIpInfo() {
  const btn = $('ipRefreshBtn');
  if (btn) { btn.disabled = true; btn.classList.add('is-spin'); }
  const set = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
  set('exitIp', '检测中'); set('localIp', '检测中');
  set('exitPlace', '检测中'); set('localPlace', '检测中');
  const v = $('ipVerdict');
  if (v) { v.className = 'rv-text'; v.textContent = '正在探测出口与本机 IP…'; }

  const r = await send('ipInfo');
  if (btn) { btn.disabled = false; btn.classList.remove('is-spin'); }
  if (!r.ok) {
    if (v) { v.className = 'rv-text err'; v.textContent = '探测失败：' + (r.error || '后台未响应'); }
    set('exitIp', '失败'); set('localIp', '失败');
    return;
  }
  const e = r.exit || {};
  const l = r.local || {};
  // 简洁呈现：IP 一行 + 地域一行（如 「13.208.38.214」「日本 · 大阪」）
  set('exitIp', e.ok ? e.ip : '失败');
  set('exitPlace', e.ok ? (e.place || '—') : (e.error || '—'));
  set('localIp', l.ok ? l.ip : '失败');
  set('localPlace', l.ok ? (l.place || '—') : (l.error || '—'));
  if (v) {
    v.className = 'rv-text' + (r.kind === 'warn' ? ' warn' : '');
    // 出口探测只反映代理通道通不通，不代表当前页面走哪条路（见上方亮起的路由节点）
    v.textContent = (r.verdict || '探测完成') + '（仅代理通道）';
  }
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

/* ── 液态玻璃选中：水滴拉伸 + 回弹的滑动胶囊 ─────────────────────
 * 参考演示：选中块切换时像一滴水被拉长 → 滑向新位 → 到位回弹。
 * 优先用 Web Animations API 播五段关键帧（压缩→拉伸→过冲→回弹→定格）；
 * 不支持时用 CSS 变量 + 定时器降级（也让纯 Node 桩测试可验证）。
 * ───────────────────────────────────────────────────────────── */
let pillX = null;
function movePill(animate) {
  const seg = $('modeSegment');
  const pill = $('segPill');
  if (!seg || !pill) return;
  const active = seg.querySelector('.seg.is-active');
  if (!active) return;
  // 按钮相对 segment 的偏移（pill 的 left:4px 基准）
  const x = active.offsetLeft - 4;
  const w = active.offsetWidth;
  pill.style.width = w + 'px';
  if (pillX === null || !animate) {
    pill.style.setProperty('--pill-x', x + 'px');
    pill.style.setProperty('--pill-sx', '1');
    pill.style.setProperty('--pill-sy', '1');
    pill.classList.add('is-ready');
    pillX = x;
    return;
  }
  const from = pillX;
  const dist = x - from;
  const dir = dist >= 0 ? 1 : -1;
  // 位移越大拉得越长，同时垂直压扁（体积守恒的“水滴”感）
  const stretch = 1 + Math.min(0.34, Math.abs(dist) / 150);
  const squash = 1 - Math.min(0.16, Math.abs(dist) / 320);
  pill.style.transformOrigin = dir > 0 ? 'left center' : 'right center';
  pill.style.setProperty('--pill-x', x + 'px');
  pill.style.setProperty('--pill-sx', String(stretch));
  pill.style.setProperty('--pill-sy', String(squash));
  pillX = x;

  const settle = () => {
    pill.style.setProperty('--pill-sx', '1');
    pill.style.setProperty('--pill-sy', '1');
    pill.style.transformOrigin = 'center center';
  };
  clearTimeout(movePill._t);
  const noMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof pill.animate === 'function' && !noMotion) {
    if (movePill._anim) { try { movePill._anim.cancel(); } catch (_) {} }
    // 五段形变：静止 → 起步压缩 → 途中拉长 → 过冲微缩 → 定格
    movePill._anim = pill.animate([
      { transform: `translateX(${from}px) scale(1, 1)` },
      { transform: `translateX(${from + dist * 0.30}px) scale(${stretch}, ${squash})`, offset: 0.38 },
      { transform: `translateX(${x - dir * 6}px) scale(${1 + (stretch - 1) * 0.35}, ${1 + (squash - 1) * 0.35})`, offset: 0.72 },
      { transform: `translateX(${x + dir * 3}px) scale(0.97, 1.03)`, offset: 0.88 },
      { transform: `translateX(${x}px) scale(1, 1)` }
    ], { duration: 560, easing: 'cubic-bezier(.34, 1.2, .42, 1)' });
    movePill._anim.onfinish = settle;
    movePill._t = setTimeout(settle, 640); // 兜底：onfinish 未触发也要复原
  } else {
    movePill._t = setTimeout(settle, 260);
  }
}

/* ── 聚光卡片：光斑跟随 + 边框提亮 + ≤4° 3D 倾斜 ─────────────── */
const TILT_MAX = 4;
function initSpotlights() {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelectorAll('.spotlight').forEach((card) => {
    // 注入真实 DOM 光斑层（末位子元素，天然盖在内容之上）：
    // 伪元素在健康卡/内核卡上会被内容的独立层叠上下文盖住，真实子元素不会。
    // 真实 DOM 光斑层：不用 :scope（部分内核不支持），也兼容无 DOM 的测试桩
    if (typeof document.createElement === 'function' && typeof card.appendChild === 'function' && card.children) {
      let hasGlow = false;
      for (const kid of card.children) { if (kid.classList && kid.classList.contains('spot-glow')) { hasGlow = true; break; } }
      if (!hasGlow) {
        const glow = document.createElement('span');
        glow.className = 'spot-glow';
        glow.setAttribute('aria-hidden', 'true');
        card.appendChild(glow);
      }
    }
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      const px = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const py = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      card.style.setProperty('--sx', (px * 100).toFixed(1) + '%');
      card.style.setProperty('--sy', (py * 100).toFixed(1) + '%');
      card.style.setProperty('--ry', ((px - 0.5) * 2 * TILT_MAX).toFixed(2) + 'deg');
      card.style.setProperty('--rx', ((0.5 - py) * 2 * TILT_MAX).toFixed(2) + 'deg');
    });
    card.addEventListener('pointerleave', () => {
      card.style.setProperty('--rx', '0deg');
      card.style.setProperty('--ry', '0deg');
      card.style.setProperty('--sx', '50%');
      card.style.setProperty('--sy', '50%');
    });
  });
}

/* ── 点击展开放大：诊断详情 ─────────────────────────────────── */
function fillDetail() {
  const s = state;
  if (!s) return;
  const v = verdict(s);
  const hero = $('dHero');
  hero.textContent = v.title;
  hero.className = 'ds-hero' + (v.kind === 'warn' ? ' warn' : (v.kind === 'err' || v.kind === 'off' ? ' err' : ''));
  $('dActual').textContent = MODE_TEXT[s.actual] || s.actual || '—';
  $('dControl').textContent = s.levelOfControl || '—';
  $('dPort').textContent = (s.cfg.proxyHost || '127.0.0.1') + ':' + s.cfg.proxyPort +
    ' · ' + (portAlive === null ? '检测中' : portAlive ? '正常' : '未响应');
  $('dKernel').textContent = kernelInfo && kernelInfo.found ? kernelInfo.name :
    (kernelInfo ? '未检测到' : '检测中');
  $('dCoverage').textContent = s.meta && s.meta.v4 ? `${s.meta.v4} 网段 / ${s.meta.domains} 域名` : '—';
  const dRule = $('dRuleAge');
  if (dRule) {
    const r = ruleAgeLabel(s.meta);
    dRule.textContent = r.label;
    dRule.classList.toggle('is-stale', r.stale);
  }
  $('dOffline').textContent = s.offline ? ('已降级 · ' + (s.missCount || 0) + ' 次') : '正常';
  const errBox = $('dError');
  if (s.lastError) { errBox.hidden = false; errBox.textContent = '写入错误：' + s.lastError; }
  else errBox.hidden = true;
}
function openDetail() {
  fillDetail();
  const layer = $('detailLayer');
  layer.hidden = false;
  requestAnimationFrame(() => layer.classList.add('is-open'));
}
function closeDetail() {
  const layer = $('detailLayer');
  layer.classList.remove('is-open');
  setTimeout(() => { if (!layer.classList.contains('is-open')) layer.hidden = true; }, 460);
}

/* ── 玻璃停靠栏：图标联动放大 + 滚动定位 ────────────────────── */
function initDock() {
  const dock = document.querySelector('.dock');
  const app = $('app');
  if (!dock) return;
  const items = Array.from(dock.querySelectorAll('.dock-item'));

  // 直接算 .app 的滚动位置 —— 浏览器原生的元素滚动方法常因 popup 容器高度受限而“点了不动”
  function scrollTo(target) {
    if (!target || !app) return;
    const det = target.closest && target.closest('details');
    if (det) det.open = true;
    const top = Math.max(0, target.offsetTop - app.offsetTop - 8);
    app.scrollTo({ top: top, behavior: 'smooth' });
    // 定位反馈：目标卡闪一下描边，让用户明确看到“跳到这里了”
    target.classList.add('dock-hit');
    clearTimeout(scrollTo._t);
    scrollTo._t = setTimeout(() => target.classList.remove('dock-hit'), 900);
  }

  items.forEach((it, i) => {
    it.addEventListener('pointerenter', () => {
      it.classList.add('is-hover');
      if (items[i - 1]) items[i - 1].classList.add('is-near');
      if (items[i + 1]) items[i + 1].classList.add('is-near');
    });
    it.addEventListener('pointerleave', () => {
      items.forEach((x) => x.classList.remove('is-hover', 'is-near'));
    });
    it.addEventListener('click', () => {
      if (it.dataset.action === 'test') { $('testBtn').click(); return; }
      scrollTo($(it.dataset.scroll));
    });
  });

  // 滚轮停在浮动的 dock 上时，事件被 dock 吞掉不会滚到 .app —— 显式转发
  if (app) {
    dock.addEventListener('wheel', (e) => {
      e.preventDefault();
      app.scrollTop += e.deltaY;
    }, { passive: false });
  }
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
const updateRulesBtn = $('updateRulesBtn');
if (updateRulesBtn) updateRulesBtn.addEventListener('click', async () => {
  const label = $('updateRulesLabel');
  const original = label ? label.textContent : '';
  if (updateRulesBtn.disabled) return;
  updateRulesBtn.disabled = true;
  if (label) label.textContent = '正在从 APNIC 拉取…';
  try {
    const r = await send('updateRules');
    if (r && r.ok) {
      if (label) label.textContent = '已更新 · ' + (r.meta && r.meta.v4 || 0) + ' 网段';
      state = await send('getState');
      render(state);
      if (!$('detailLayer').hidden) fillDetail();
    } else {
      if (label) label.textContent = '更新失败 · 已保留旧规则';
    }
  } catch (_) {
    if (label) label.textContent = '更新失败 · 已保留旧规则';
  } finally {
    setTimeout(() => { if (label) label.textContent = original; updateRulesBtn.disabled = false; }, 2600);
  }
});
$('ipRefreshBtn').addEventListener('click', loadIpInfo);
$('kernelScanBtn').addEventListener('click', loadKernel);
$('detailOpenBtn').addEventListener('click', openDetail);
document.querySelectorAll('[data-detail-close]').forEach((b) => {
  b.addEventListener('click', closeDetail);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('detailLayer') && !$('detailLayer').hidden) closeDetail();
});

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
 * 猫提升到面板层，站点 = 各卡片上边线。每站：蓄力下蹲 → 起跳上抛 → 斜向抛物线
 * → 落地缓冲。滚动 / 卡片显隐 / 尺寸变化时重校准到「当前站点」，绝不闪回健康卡。
 * 尊重 prefers-reduced-motion：开启则静止趴在健康卡。
 * ───────────────────────────────────────────────────────────── */
const Mascot = (() => {
  const el = $('mascot');
  const app = document.querySelector('.app');
  if (!el || !app) return { start() {}, recalibrate() {} };

  const reduced = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const STOPS = ['healthCard', 'kernelCard', 'trafficCard'];
  const CAT_W = 40;
  const BELLY = 29;                 // 肚皮相对自身顶部：SVG y≈86.5/100*34
  const cards = () => STOPS.map((id) => $(id)).filter(Boolean);
  let curCard = cards()[0] || null; // 当前停靠站点（重校准时据此归位，不回健康卡）
  let cur = { x: 0, y: 0 };
  let raf = 0, timer = 0, alive = false;
  let animating = false;            // 独立布尔标志：不依赖 classList，避免自触发
  let settleUntil = 0;              // 动画结束冷却：吃掉 remove('is-jumping') 引发的 observer 回调

  // 卡片相对 .app 内容区的布局位置。不能加 scrollTop：猫与卡片同处滚动容器，
  // 二者随内容一起滚动，相对位置由 offsetTop 决定，加 scrollTop 会双重位移。
  function cardTop(card) {
    return card.offsetTop - app.offsetTop;
  }
  function visible(card) {
    const r = card.getBoundingClientRect();
    const a = app.getBoundingClientRect();
    // 底部玻璃 dock 固定悬浮，给可视区下沿留出遮挡余量，猫不落到被 dock 盖住的卡片上
    const dock = document.querySelector('.dock');
    const dockReserve = dock ? dock.getBoundingClientRect().height + 18 : 0;
    return r.bottom > a.top + 6 && r.top < a.bottom - 6 - dockReserve;
  }
  function landing(card) {
    const x = card.offsetLeft + card.offsetWidth - CAT_W - 13 - Math.random() * 46;
    return { x: Math.max(4, x), y: cardTop(card) - BELLY };
  }
  function paint(p, rot, sx, sy) {
    el.style.setProperty('--mx', p.x + 'px');
    el.style.setProperty('--my', p.y + 'px');
    el.style.setProperty('--mrot', (rot || 0) + 'deg');
    el.style.setProperty('--msc', sx || 1);
    el.style.setProperty('--msy', sy || 1);
  }

  // 蓄力 → 起跳 → 落地缓冲：完整起跳动作都在这条时间轴里
  function jumpTo(target, card) {
    const from = { ...cur };
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    const dist = Math.hypot(dx, dy);
    const dur = Math.min(1050, 660 + dist * 0.75);   // 距离越远跳越久，动作看得清
    const lift = Math.min(92, 42 + dist * 0.22);     // 上抛高度：够明显地「先跳起来」
    const sideBend = (Math.random() * 2 - 1) * Math.min(22, dist * 0.10);
    const tiltDir = dx >= 0 ? 1 : -1;
    const CROUCH = 0.13;                              // 前 13% 原地蓄力
    const t0 = performance.now();
    animating = true;
    el.classList.add('is-jumping');
    cancelAnimationFrame(raf);

    function frame(now) {
      let t = (now - t0) / dur;
      if (t >= 1) t = 1;

      if (t < CROUCH) {
        // 蓄力下蹲：原地压扁、微微后仰，肚皮仍贴边线
        const k = Math.sin(Math.PI * (t / CROUCH));
        paint(from, -tiltDir * 4 * k, 1 + 0.06 * k, 1 - 0.11 * k);
        raf = requestAnimationFrame(frame);
        return;
      }

      // 主跳跃：基线 easeInOutQuad + 上抛 sin(πu)^0.8 —— 前段上抛压过基线，
      // 即使目标在下方很远，也会先明显窜起来再落下（这才是「起跳」）。
      const u = (t - CROUCH) / (1 - CROUCH);
      const base = u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u);
      const arc = Math.pow(Math.sin(Math.PI * u), 0.8);
      const x = from.x + dx * base + sideBend * Math.sin(Math.PI * u);
      const y = from.y + dy * base - lift * arc;
      const rot = tiltDir * 12 * arc;                 // 腾空倾斜
      const land = Math.sin(Math.PI * Math.max(0, (u - 0.86) / 0.14)); // 落地压扁回弹
      paint({ x, y }, rot, 1 + 0.10 * arc + 0.05 * land, 1 + 0.10 * arc - 0.09 * land);

      if (t < 1) {
        raf = requestAnimationFrame(frame);
      } else {
        cur = { ...target };
        curCard = card || curCard;
        paint(cur, 0, 1, 1);
        el.classList.remove('is-jumping');
        animating = false;
        settleUntil = performance.now() + 120;  // 冷却：忽略 class 变化回调，杜绝瞬间回弹
      }
    }
    raf = requestAnimationFrame(frame);
  }

  function nextStop() {
    if (!alive) return;
    const all = cards();
    const vis = all.filter(visible);
    const pool = vis.length ? vis : all.slice(0, 1);
    // 排除当前站点，避免原地蹦；为空（只剩一张可见卡）时就地小跳
    let candidates = pool.filter((c) => c !== curCard);
    if (!candidates.length) candidates = pool;
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    jumpTo(landing(target), target);
    timer = setTimeout(nextStop, 3400 + Math.random() * 1800);
  }

  function calibrate() {
    // 重校准到「当前站点」而不是健康卡 —— 否则内核卡上的猫会被拽回起点
    const card = curCard && curCard.isConnected !== false ? curCard : cards()[0];
    if (!card) return;
    if (!animating && !el.classList.contains('is-jumping')) {
      cur = landing(card);
      paint(cur, 0, 1, 1);
    }
  }

  return {
    start() {
      curCard = cards()[0] || curCard;
      calibrate();
      if (reduced) return;                 // 静态，不巡游
      alive = true;
      timer = setTimeout(nextStop, 2800);
      app.addEventListener('scroll', () => {
        // 猫与卡片同处滚动容器，相对位置不变；只重置计时，绝不能 cancelAnimationFrame
        clearTimeout(timer);
        if (alive && !animating) timer = setTimeout(nextStop, 1200);
      }, { passive: true });
      window.addEventListener('resize', calibrate);
      if (window.MutationObserver) {
        new MutationObserver(() => {
          // 动画中 / 结束冷却期内忽略：remove('is-jumping') 也会触发本回调，
          // 若此刻 calibrate 就会把刚落地的猫瞬间拉回 —— 正是「跳下去一瞬间回来」的根因。
          if (animating || performance.now() < settleUntil) return;
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
  loadRoute();    // 当前页面路由判定：落到健康卡的直连/代理示意条 + logo 灯
  loadTraffic();  // 流量统计：直连 / 代理分路累计
  loadIpInfo();   // 出口探测独立于健康状态，异步进行不阻塞面板
  loadKernel();   // 内核检测同上
  Mascot.start(); // 吉祥物跨卡片斜跳巡游
  initSpotlights(); // 聚光卡片鼠标跟随
  initDock();       // 玻璃停靠栏联动
})();
