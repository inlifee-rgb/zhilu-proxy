/* 智路使用视频录制器。
   用法：node tools/record_video.mjs <mode>
     mode=sample  抽样 8 幕各截一帧 → .chrome-tmp/video/sample_XX.png（快速构图检查）
     mode=full    30fps 全量逐帧 → .chrome-tmp/video/frames/%05d.png（供 ffmpeg 合成）
   自包含：内部 spawn 独立 profile 的 headless Chrome，不碰用户现有浏览器。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 仓库根目录按脚本位置推导，不写死本机路径
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 可用 ZL_CHROME 指定浏览器路径
const CHROME = process.env.ZL_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9341;
const PROFILE = ROOT + '/.chrome-tmp/vidprof';
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = ROOT + '/.chrome-tmp/video';
const MODE = process.argv[2] || 'sample';
const W = 1280, H = 720, FPS = 30, DUR = 40;
const DIR = fs.readFileSync(ROOT + '/tools/director.js', 'utf8');

fs.mkdirSync(PROFILE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  `--window-size=${W},${H}`, '--no-first-run', '--force-device-scale-factor=1',
  '--allow-file-access-from-files', 'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/json/version'); if (r.ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}

let ws, seq = 0; const pending = new Map();
function cmd(method, params = {}) {
  const id = ++seq;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  if (!await waitPort()) throw new Error('CDP port timeout');
  const targets = await (await fetch(BASE + '/json/list')).json();
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('no page target');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.rej(new Error(JSON.stringify(m.error))); else p.res(m.result);
    }
  };

  await cmd('Page.enable');
  await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await cmd('Page.navigate', { url: pathToFileURL(path.join(ROOT, 'preview.html')).href });
  // 等页面 UI 渲染 + mock 数据填充
  await sleep(1500);
  // 注入导演脚本
  await cmd('Runtime.evaluate', { expression: DIR, awaitPromise: false });
  const ready = await cmd('Runtime.evaluate', { expression: '!!window.renderAt', returnByValue: true });
  if (!ready.result?.value) throw new Error('director not injected');
  console.log('director ready');

  async function frame(t) {
    await cmd('Runtime.evaluate', { expression: `window.renderAt(${t.toFixed(4)})`, awaitPromise: false });
    const r = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return Buffer.from(r.data, 'base64');
  }

  if (MODE === 'sample') {
    const times = [2, 6.5, 11.5, 16, 19.5, 23.5, 28.5, 33.5, 38];
    for (let i = 0; i < times.length; i++) {
      const buf = await frame(times[i]);
      fs.writeFileSync(path.join(OUT, `sample_${String(i).padStart(2, '0')}.png`), buf);
      console.log(`sample ${i} @${times[i]}s ${buf.length}B`);
    }
  } else if (MODE === 'full' || MODE.startsWith('range:')) {
    const dir = path.join(OUT, 'frames');
    fs.mkdirSync(dir, { recursive: true });
    let from = 0, to = DUR * FPS;
    if (MODE.startsWith('range:')) {
      const parts = MODE.split(':')[1].split('-');
      from = parseInt(parts[0], 10); to = parseInt(parts[1], 10);
    }
    for (let i = from; i < to; i++) {
      const t = i / FPS;
      const buf = await frame(t);
      fs.writeFileSync(path.join(dir, `${String(i).padStart(5, '0')}.png`), buf);
      if (i % 60 === 0) console.log(`frame ${i}/${to} @${t.toFixed(1)}s`);
    }
    console.log(`DONE frames ${from}..${to - 1}`);
  } else {
    throw new Error('unknown mode: ' + MODE);
  }
}

let code = 0;
try { await main(); } catch (e) { console.error('RECORD_FAIL:', e.message); code = 1; }
finally {
  try { if (ws) ws.close(); } catch {}
  try { chrome.kill('SIGKILL'); } catch {}
}
process.exit(code);
