/* 面板视觉快照：生成 harness.html（注入 chrome API 桩 + 真 popup.html 内容），
   用与录制器相同的 headless 链路截图，规避 Chrome 157 禁 --load-extension。
   用法：node tools/shot_popup2.mjs [输出png] */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.ZL_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9347 + Math.floor(Math.random() * 40);
const PROFILE = ROOT + '/.chrome-tmp/shotprof2-' + Date.now();
const OUT = process.argv[2] || ROOT + '/.chrome-tmp/popup-shot.png';
const HARNESS = ROOT + '/harness-tmp.html';
fs.mkdirSync(PROFILE, { recursive: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const STUB = `<script>
window.chrome = {
  runtime: {
    lastError: null,
    sendMessage(msg, cb) {
      const t = msg && msg.type;
      let r = { ok: true };
      if (t === 'getState') r = {
        ok: true,
        cfg: { enabled: true, mode: 'smart', proxyHost: '127.0.0.1', proxyPort: 7897,
               forceDirect: ['baidu.com','qq.com'], forceProxy: ['openai.com'],
               dnsCheck: true, cnDomainList: true, failOpen: true },
        actual: 'pac_script', levelOfControl: 'controlled_by_this_extension',
        offline: false, lastError: '',
        meta: { v4: 5500, v6: 2019, domains: 122, generated: '2026-11-21' }
      };
      else if (t === 'proxyAlive') r = { ok: true, ms: 11 };
      else if (t === 'currentRoute') r = { available: true, host: 'www.baidu.com',
        decision: { decision: 'direct', via: '中国域名库 · baidu.com', detail: 'cn-domain' } };
      else if (t === 'detectKernel') r = { ok: true, found: true, port: 7897, name: 'Clash Verge', version: 'v1.7.7', alivePorts: [7897] };
      else if (t === 'trafficStats') r = { ok: true, stats: { direct: { bytes: 1820000, requests: 96 }, proxy: { bytes: 940000, requests: 41 }, uptimeSec: 7200, startedAt: Date.now() - 7200000 } };
      else if (t === 'ipInfo') r = { ok: true, kind: 'ok', verdict: '代理通道已连通（出口在境外，与本机不同）',
        exit: { ok: true, ip: '219.100.37.88', country: 'JP', region: '东京', city: '东京', isp: 'SoftBank' },
        local: { ok: true, ip: '119.137.52.10', country: 'CN', region: '广东', city: '深圳', isp: '电信' } };
      else if (t === 'rulesStatus') r = { ok: true, ageDays: 1, meta: { v4: 5500, v6: 2019, domains: 122, generated: '2026-11-21' } };
      setTimeout(() => cb && cb(r), 15);
      return true;
    },
    getURL(p) { return 'chrome-extension://test/' + p; }
  },
  storage: {
    local: {
      get(k) {
        const cfg = { enabled: true, mode: 'smart', proxyHost: '127.0.0.1', proxyPort: 7897,
          forceDirect: ['baidu.com','qq.com'], forceProxy: ['openai.com'],
          dnsCheck: true, cnDomainList: true, failOpen: true };
        const keys = Array.isArray(k) ? k : [k];
        const out = {};
        if (keys.includes('cfg')) out.cfg = cfg;
        if (keys.includes('rules')) out.rules = { meta: { v4: 5500, v6: 2019, domains: 122, generated: '2026-11-21' } };
        return Promise.resolve(out);
      },
      set() { return Promise.resolve(); }
    }
  },
  proxy: { settings: { get(o, cb) {
    const d = { value: { mode: 'pac_script' }, levelOfControl: 'controlled_by_this_extension' };
    if (cb) { setTimeout(() => cb(d), 2); return; }
    return Promise.resolve(d);
  } } }
};
</script>`;

const html = fs.readFileSync(ROOT + '/popup.html', 'utf8');
// 在第一个脚本引用前插入桩
const marked = html.includes('<script src="popup.js"')
  ? html.replace('<script src="popup.js"', STUB + '\n  <script src="popup.js"')
  : html.replace('</head>', STUB + '\n</head>');
fs.writeFileSync(HARNESS, marked, 'utf8');

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=420,900', '--no-first-run', '--force-device-scale-factor=2',
  '--allow-file-access-from-files', 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitPort() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}

async function main() {
  if (!await waitPort()) throw new Error('CDP 端口未就绪');
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map(); const logs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.rej(new Error(JSON.stringify(m.error))); else p.res(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
  };
  const cmd = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }));
  });

  await cmd('Runtime.enable');
  await cmd('Page.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: false });
  await cmd('Page.navigate', { url: 'file:///' + HARNESS });
  await sleep(2600);

  const probe = await cmd('Runtime.evaluate', {
    expression: `JSON.stringify({
      dot: (document.getElementById('logoRouteDot')||{}).className,
      dotBox: (()=>{const d=document.getElementById('logoRouteDot');if(!d)return null;const r=d.getBoundingClientRect();const cs=getComputedStyle(d);return {w:+r.width.toFixed(1),h:+r.height.toFixed(1),x:+r.left.toFixed(1),y:+r.top.toFixed(1),bg:cs.backgroundColor,display:cs.display};})(),
      health: (document.getElementById('healthTitle')||{}).textContent,
      chip: (document.getElementById('statusChip')||{}).textContent,
      proxyState: (document.getElementById('proxyStateText')||{}).textContent,
      routeCn: (document.getElementById('routeCnHost')||{}).textContent,
      routeOs: (document.getElementById('routeOsHost')||{}).textContent,
      why: (document.getElementById('routeWhyText')||{}).textContent,
      cards: document.querySelectorAll('.glass.spotlight').length,
      glow: document.querySelectorAll('.spot-glow').length,
      mascot: (()=>{const m=document.getElementById('mascotWrap');if(!m)return null;const cs=getComputedStyle(m);return cs.display+'/'+cs.opacity;})(),
      scrollH: (document.getElementById('app')||{}).scrollHeight
    })`,
    returnByValue: true
  });
  console.log('DOM:', JSON.stringify(JSON.parse(probe.result.value || '{}'), null, 2));
  if (logs.length) console.log('报错:\n  ' + logs.join('\n  '));

  const shot = await cmd('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('截图:', OUT);
}

main().catch((e) => console.error('FAIL:', e.message)).finally(async () => {
  await sleep(200);
  try { chrome.kill(); } catch {}
  try { fs.unlinkSync(HARNESS); } catch {}
});
