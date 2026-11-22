/* 智路使用视频导演脚本 v2 —— 多镜头构图版
   由 CDP 注入 preview.html。window.renderAt(t) 按秒数确定性渲染整帧。
   8 幕 8 种镜头：片头 / 双窗痛点 / 面板滑入 / 路由特写 / IP 双卡 /
   工具栏状态点特写 / 猫跳动效 / 全屏开源结尾。舞台 1280x720。 */
(function () {
  if (window.__directorReady) return;
  window.__directorReady = true;

  var CAT = '<svg viewBox="0 0 512 512" width="100%" height="100%"><g stroke="#0D285C" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M103 245 C97 191 103 100 138 71 C157 58 206 112 224 132 Q256 127 288 132 C310 111 357 57 377 71 C410 99 415 191 409 245 C418 287 400 346 356 376 C302 412 210 412 156 376 C111 346 94 288 103 245 Z" fill="#FFFFFF" stroke-width="17"/>' +
    '<path d="M131 198 C131 159 133 120 146 104 C162 108 178 135 190 154 Z" fill="#76B7FF" stroke="none"/>' +
    '<path d="M381 198 C381 159 379 120 366 104 C350 108 334 135 322 154 Z" fill="#76B7FF" stroke="none"/>' +
    '<path d="M261 136 C289 139 301 155 328 173 C353 190 377 202 400 204 C377 223 342 214 316 202 C293 190 274 174 261 136Z" fill="#89BBFA" stroke="none"/>' +
    '<ellipse cx="202" cy="265" rx="24" ry="32" fill="#0D285C" stroke="none"/>' +
    '<ellipse cx="193" cy="252" rx="7" ry="10" fill="white" stroke="none"/>' +
    '<path d="M297 268 Q326 232 351 263" fill="none" stroke-width="15"/>' +
    '<ellipse cx="151" cy="305" rx="25" ry="13" fill="#FFB7BA" stroke="none"/>' +
    '<ellipse cx="363" cy="305" rx="25" ry="13" fill="#FFB7BA" stroke="none"/>' +
    '<path d="M247 284 Q256 279 265 284 Q256 295 247 284Z" fill="#0D285C" stroke="none"/>' +
    '<path d="M256 292 Q246 315 229 302 M256 292 Q268 315 285 302" fill="none" stroke-width="10"/>' +
    '<path d="M116 269 L72 263 M113 297 L72 313 M397 269 L440 263 M399 297 L441 313" fill="none" stroke-width="12"/>' +
    '</g></svg>';

  // 完整趴猫素材（去掉 CSS 动画，姿态由视频时间轴控制）；尾根(28,72)、前爪扣边线(y≈94)
  var LOUNGE = '<svg viewBox="0 0 120 100" width="100%" height="100%"><g stroke="#0D285C" stroke-linecap="round" stroke-linejoin="round">' +
    '<g transform="translate(28,72)"><g id="catTail"><path d="M0 0 C-13 -3 -20 -15 -13 -24 C-9 -29 -2 -28 1 -23" fill="none" stroke-width="5"/>' +
    '<path d="M-13 -24 C-9 -29 -2 -28 1 -23" fill="none" stroke="#76B7FF" stroke-width="2.1"/></g></g>' +
    '<ellipse cx="56" cy="71" rx="31" ry="15.5" fill="#fff" stroke-width="3.2"/>' +
    '<path d="M63 59 C75 60 83 67 83 75 C73 73 67 67 63 59Z" fill="#DCEBFF" stroke="none"/>' +
    '<path d="M31 80 q-7 3 -11 0 q-1 -5 4 -6 l9 -1Z" fill="#fff" stroke-width="2.6"/>' +
    '<path d="M70 80 C70 89 71 94 76 94 C81 94 82 89 81 80 Z" fill="#fff" stroke-width="2.6"/>' +
    '<path d="M80 81 C80 91 81 95 86 95 C91 95 92 90 91 81 Z" fill="#fff" stroke-width="2.4"/>' +
    '<g transform="translate(70,43) scale(0.142) translate(-256,-250)">' +
    '<path d="M103 245 C97 191 103 100 138 71 C157 58 206 112 224 132 Q256 127 288 132 C310 111 357 57 377 71 C410 99 415 191 409 245 C418 287 400 346 356 376 C302 412 210 412 156 376 C111 346 94 288 103 245 Z" fill="#FFFFFF" stroke-width="17"/>' +
    '<path d="M131 198 C131 159 133 120 146 104 C162 108 178 135 190 154 Z" fill="#76B7FF" stroke="none"/>' +
    '<path d="M381 198 C381 159 379 120 366 104 C350 108 334 135 322 154 Z" fill="#76B7FF" stroke="none"/>' +
    '<path d="M261 136 C289 139 301 155 328 173 C353 190 377 202 400 204 C377 223 342 214 316 202 C293 190 274 174 261 136Z" fill="#89BBFA" stroke="none"/>' +
    '<ellipse cx="202" cy="265" rx="24" ry="32" fill="#0D285C" stroke="none"/><ellipse cx="193" cy="252" rx="7" ry="10" fill="white" stroke="none"/>' +
    '<path d="M297 268 Q326 232 351 263" fill="none" stroke-width="15"/>' +
    '<ellipse cx="151" cy="305" rx="25" ry="13" fill="#FFB7BA" stroke="none"/><ellipse cx="363" cy="305" rx="25" ry="13" fill="#FFB7BA" stroke="none"/>' +
    '<path d="M247 284 Q256 279 265 284 Q256 295 247 284Z" fill="#0D285C" stroke="none"/>' +
    '<path d="M256 292 Q246 315 229 302 M256 292 Q268 315 285 302" fill="none" stroke-width="10"/>' +
    '<path d="M116 269 L72 263 M113 297 L72 313 M397 269 L440 263 M399 297 L441 313" fill="none" stroke-width="12"/>' +
    '</g></g></svg>';

  var CSS = `
  html,body{margin:0!important;padding:0!important;width:1280px!important;height:720px!important;overflow:hidden!important;
    background:#f4f7ff!important;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif!important;}
  .bg-orb-a,.bg-orb-b,.bg-orb-c,.bg-orb-d{display:none!important;}
  /* 面板自带猫用真实时间 rAF 跳，逐帧录制时会瞬移/脱节 —— 视频里隐藏，
     猫的动作一律由 renderAt(t) 按视频时间轴确定性控制（只在 motion 幕出现）。 */
  #mascotWrap{display:none!important;}
  #stage{position:fixed;inset:0;overflow:hidden;
    background:radial-gradient(circle at 14% 18%,#dceaff 0%,transparent 40%),
               radial-gradient(circle at 88% 78%,#e9ddff 0%,transparent 44%),
               radial-gradient(circle at 62% 6%,#d8f3ec 0%,transparent 38%),#f5f8ff;}
  #stage::before{content:"";position:absolute;inset:0;
    background-image:radial-gradient(rgba(120,150,200,.11) 1px,transparent 1px);
    background-size:24px 24px;opacity:.55;}
  /* 真实面板容器：每幕用 translate+scale 推拉到不同位置 */
  #panelWrap{position:absolute;left:0;top:0;width:420px;height:700px;transform-origin:top left;
    opacity:0;will-change:transform,opacity;
    filter:drop-shadow(0 22px 46px rgba(40,70,130,.20));}
  #panelFrame{width:420px;overflow:hidden;border-radius:20px;}
  /* 聚焦描边框 */
  #focus{position:absolute;border:2px solid rgba(124,58,237,.55);border-radius:16px;
    box-shadow:0 0 0 5px rgba(124,58,237,.10),0 10px 30px rgba(124,58,237,.18);
    opacity:0;pointer-events:none;}
  /* 通用字幕块（位置每幕可变） */
  #caption{position:absolute;opacity:0;}
  #capNo{font-size:14px;letter-spacing:3px;color:#7c3aed;font-weight:700;margin-bottom:14px;}
  #capTitle{font-size:50px;line-height:1.2;font-weight:800;color:#0d285c;letter-spacing:1px;}
  #capSub{margin-top:18px;font-size:23px;line-height:1.7;color:#475569;font-weight:500;}
  #capTag{display:inline-block;margin-top:24px;padding:9px 18px;border-radius:999px;
    background:linear-gradient(135deg,ede9fe,dbeafe);color:#6d28d9;font-size:16px;font-weight:700;}
  /* scene 层：整层独立淡入淡出 */
  .sceneLayer{position:absolute;inset:0;opacity:0;pointer-events:none;}
  #sceneLabel{position:absolute;right:56px;top:34px;font-size:14px;letter-spacing:2px;
    color:#8a93ad;font-weight:700;}
  #progress{position:absolute;left:56px;right:56px;bottom:24px;height:5px;border-radius:99px;background:#dbe4f5;overflow:hidden;}
  #progressFill{height:100%;width:0%;background:linear-gradient(90deg,#7c3aed,#2563eb);border-radius:99px;}
  /* ── 幕1/8 品牌首屏 ── */
  #brandWrap{position:absolute;left:0;right:0;top:0;bottom:0;display:flex;flex-direction:column;
    align-items:center;justify-content:center;}
  .brandBadge{font-size:15px;letter-spacing:4px;color:#6d28d9;font-weight:800;margin-bottom:26px;}
  .brandCatBox{width:210px;height:210px;border-radius:46px;background:linear-gradient(150deg,#fff,#eef3ff);
    border:1px solid #d8e3f7;box-shadow:0 22px 50px rgba(50,80,150,.18),inset 0 2px 0 #fff;
    display:flex;align-items:center;justify-content:center;padding:26px;}
  .brandTitle{font-size:96px;font-weight:900;letter-spacing:6px;color:#0d285c;margin-top:30px;line-height:1;}
  .brandSub{font-size:27px;color:#5b6b8a;margin-top:20px;font-weight:500;}
  .brandFoot{position:absolute;bottom:70px;font-size:15px;color:#98a3bb;letter-spacing:2px;}
  /* ── 幕2 痛点双窗口 ── */
  .win{position:absolute;width:430px;border-radius:18px;overflow:hidden;background:#fff;
    border:1px solid #d6e0f2;box-shadow:0 18px 40px rgba(40,70,130,.16);}
  .winBar{height:40px;background:#f3f6fc;border-bottom:1px solid #e2e9f5;display:flex;align-items:center;
    gap:7px;padding:0 14px;}
  .winBar i{width:10px;height:10px;border-radius:50%;display:block;}
  .winBody{padding:22px 24px;height:210px;}
  .winUrl{margin-top:14px;height:32px;border-radius:9px;background:#f5f7fb;border:1px solid #e5ebf5;
    display:flex;align-items:center;padding:0 12px;font-size:14px;color:#64748b;}
  .winLine{display:flex;align-items:center;gap:12px;margin-top:22px;font-size:17px;font-weight:600;color:#0d285c;}
  .winLine .tick{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;
    font-size:18px;color:#fff;font-weight:800;flex:none;}
  .winNote{margin-top:16px;font-size:14px;line-height:1.6;color:#64748b;}
  #painVs{position:absolute;left:50%;top:290px;transform:translateX(-50%);width:60px;height:60px;border-radius:50%;
    background:#fff;border:1px solid #d6e0f2;box-shadow:0 8px 20px rgba(40,70,130,.14);
    display:flex;align-items:center;justify-content:center;font-size:19px;font-weight:900;color:#94a3b8;}
  #painBottom{position:absolute;left:0;right:0;bottom:78px;text-align:center;font-size:24px;
    color:#334155;font-weight:600;}
  #painBottom b{color:#6d28d9;}
  /* ── 幕5 IP 双卡 ── */
  .ipCard{position:absolute;width:300px;height:168px;border-radius:20px;background:rgba(255,255,255,.9);
    border:1px solid #d6e0f2;box-shadow:0 14px 34px rgba(40,70,130,.14);padding:20px 22px;}
  .ipCard .k{font-size:14px;color:#64748b;font-weight:600;}
  .ipCard .v{font-size:25px;color:#0d285c;font-weight:800;margin-top:8px;}
  .ipCard .ip{font-size:16px;color:#475569;margin-top:10px;font-family:ui-monospace,Consolas,monospace;}
  .ipCard .badge{position:absolute;right:22px;top:20px;padding:5px 12px;border-radius:99px;font-size:13px;font-weight:800;}
  /* ── 幕6 工具栏状态点特写 ── */
  #bigTool{position:absolute;width:330px;height:330px;border-radius:56px;
    background:linear-gradient(150deg,#fff,#eaf0ff);border:1px solid #d5e0f5;
    box-shadow:0 26px 60px rgba(40,70,130,.22),inset 0 2px 0 #fff;display:flex;align-items:center;justify-content:center;}
  #bigTool .cat{width:230px;height:230px;padding:14px;}
  #bigTool .dot{position:absolute;right:26px;bottom:26px;width:58px;height:58px;border-radius:50%;
    border:5px solid #0d285c;box-shadow:0 0 0 7px #fff,0 6px 16px rgba(0,0,0,.15);background:#94a3b8;}
  /* ── 巡游猫：完整趴猫素材，趴在卡片边缘 ── */
  #roam{position:absolute;width:72px;height:60px;opacity:0;pointer-events:none;
    filter:drop-shadow(0 8px 14px rgba(40,70,130,.28));}
  /* 素材自带的 CSS 动画走浏览器真实时间，逐帧录制会瞬移 —— 视频里全部禁用，
     呼吸/摆尾/跳跃一律由 renderAt(t) 按视频时间轴确定性驱动。 */
  #roam svg *{animation:none!important;}
  body > :not(#stage){visibility:hidden!important;}
  `;
  var style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);

  var stage = document.createElement('div'); stage.id = 'stage';
  stage.innerHTML =
    '<div id="panelWrap"><div id="panelFrame"></div></div>' +
    '<div id="focus"></div>' +
    '<div id="caption"><div id="capNo"></div><div id="capTitle"></div><div id="capSub"></div><div id="capTag"></div></div>' +
    '<div id="sceneBrand" class="sceneLayer"><div id="brandWrap">' +
      '<div class="brandBadge" id="brandBadge">CHROME EXTENSION · MANIFEST V3</div>' +
      '<div class="brandCatBox" id="brandCatBox">' + CAT + '</div>' +
      '<div class="brandTitle" id="brandTitle">智路</div>' +
      '<div class="brandSub" id="brandSub">让国内网站直连，海外网站自动走代理</div>' +
      '<div class="brandFoot" id="brandFoot">ZHILU · SMART PROXY</div>' +
    '</div></div>' +
    '<div id="scenePain" class="sceneLayer">' +
      '<div class="win" id="winBrowser"><div class="winBar"><i style="background:#ff6b6b"></i><i style="background:#ffd166"></i><i style="background:#51cf66"></i></div>' +
        '<div class="winBody"><div style="font-size:21px;font-weight:800;color:#0d285c">浏览器 · 打开 baidu.com</div>' +
        '<div class="winUrl">https://www.baidu.com</div>' +
        '<div class="winLine"><span class="tick" style="background:#22c55e">✓</span>能打开，但走的是本地网络</div>' +
        '<div class="winNote">装了代理软件，却不想让国内流量也绕道海外。</div></div></div>' +
      '<div class="win" id="winClash"><div class="winBar"><i style="background:#cbd5e1"></i><i style="background:#cbd5e1"></i><i style="background:#cbd5e1"></i></div>' +
        '<div class="winBody"><div style="font-size:21px;font-weight:800;color:#0d285c">Clash Verge · 系统代理</div>' +
        '<div class="winUrl" style="justify-content:space-between"><span>系统代理</span><span style="padding:3px 12px;border-radius:99px;background:#e2e8f0;color:#64748b;font-weight:800;font-size:13px">关闭</span></div>' +
        '<div class="winLine"><span class="tick" style="background:#ef4444">×</span>系统代理一关，海外网站全断</div>' +
        '<div class="winNote">两个都要，靠手动切开关？太麻烦。</div></div></div>' +
      '<div id="painVs">VS</div>' +
      '<div id="painBottom">智路把分流决策写进 <b>Chrome 自己的 PAC</b>，跟系统代理完全无关。</div>' +
    '</div>' +
    '<div id="sceneIp" class="sceneLayer">' +
      '<div class="ipCard" id="ipProxy"><div class="badge" style="background:#ede9fe;color:#6d28d9">代理出口</div>' +
        '<div class="k">当前流量出口</div><div class="v">日本 · 东京（NRT）</div><div class="ip">203.0.113.44</div></div>' +
      '<div class="ipCard" id="ipLocal"><div class="badge" style="background:#dcfce7;color:#15803d">本机真实</div>' +
        '<div class="k">你的物理位置</div><div class="v">中国 · 广东 深圳</div><div class="ip">113.66.xxx.xxx</div></div>' +
    '</div>' +
    '<div id="sceneTool" class="sceneLayer">' +
      '<div id="bigTool"><div class="cat">' + CAT + '</div><div class="dot" id="bigDot"></div></div>' +
    '</div>' +
    '<div id="roam">' + LOUNGE + '</div>' +
    '<div id="sceneLabel"></div>' +
    '<div id="progress"><div id="progressFill"></div></div>';
  document.body.appendChild(stage);

  var app = document.querySelector('.app');
  var header = document.querySelector('.header');
  var frame = document.getElementById('panelFrame');
  if (app) frame.appendChild(app);
  if (header) frame.insertBefore(header, frame.firstChild);

  var $ = function (id) { return document.getElementById(id); };
  var appEl = app, focusEl = $('focus'), panel = $('panelWrap'), roam = $('roam'), prog = $('progressFill');
  var capNo = $('capNo'), capTitle = $('capTitle'), capSub = $('capSub'), capTag = $('capTag'), caption = $('caption');
  var layers = { brand:$('sceneBrand'), pain:$('scenePain'), ip:$('sceneIp'), tool:$('sceneTool') };

  // [起,止,编号,id] —— 每幕一种镜头
  var SCENES = [
    { a:0,  b:4,  no:'01 / 08 · INTRO',    id:'brand' },
    { a:4,  b:9,  no:'02 / 08 · PAIN',     id:'pain' },
    { a:9,  b:14, no:'03 / 08 · TAKEOVER', id:'takeover' },
    { a:14, b:21, no:'04 / 08 · ROUTING',  id:'routing' },
    { a:21, b:26, no:'05 / 08 · VERIFY',   id:'verify' },
    { a:26, b:31, no:'06 / 08 · STATUS',   id:'status' },
    { a:31, b:36, no:'07 / 08 · MOTION',   id:'motion' },
    { a:36, b:40, no:'08 / 08 · OPEN',     id:'open' }
  ];
  var TOTAL = 40;

  function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
  function ease(x){return x<0?0:x>1?1:x*x*(3-2*x);}
  function lerp(a,b,k){return a+(b-a)*k;}

  function showCaption(no,title,sub,tag,x,y,w,local){
    capNo.textContent = no;
    capTitle.innerHTML = title;
    capSub.innerHTML = sub;
    capTag.textContent = tag;
    var e1 = ease(clamp(local/0.12,0,1));
    var e2 = ease(clamp((local-0.06)/0.14,0,1));
    var e3 = ease(clamp((local-0.12)/0.14,0,1));
    caption.style.left = x+'px'; caption.style.top = y+'px'; caption.style.width = w+'px';
    capNo.style.opacity = e1;
    capTitle.style.opacity = e1;
    capTitle.style.transform = 'translateY('+((1-e1)*16).toFixed(1)+'px)';
    capSub.style.opacity = e2;
    capTag.style.opacity = e3;
    capTag.style.transform = 'translateY('+((1-e3)*10).toFixed(1)+'px)';
  }

  function setPanel(x,y,scale,opacity){
    panel.style.transform = 'translate('+x.toFixed(1)+'px,'+y.toFixed(1)+'px) scale('+scale.toFixed(4)+')';
    panel.style.opacity = opacity;
  }

  function setSpot(sx,sy){
    if (!appEl) return;
    appEl.style.setProperty('--sx',sx.toFixed(1)+'%');
    appEl.style.setProperty('--sy',sy.toFixed(1)+'%');
    var cards = appEl.querySelectorAll('.spotlight');
    for (var c=0;c<cards.length;c++){
      cards[c].style.setProperty('--sx',sx.toFixed(1)+'%');
      cards[c].style.setProperty('--sy',sy.toFixed(1)+'%');
    }
  }

  function setFocus(id, strength){
    var el = id ? $(id) : null;
    if (!el) { focusEl.style.opacity = 0; return; }
    var r = el.getBoundingClientRect();
    focusEl.style.left = (r.left-3)+'px';
    focusEl.style.top = (r.top-3)+'px';
    focusEl.style.width = (r.width+6)+'px';
    focusEl.style.height = (r.height+6)+'px';
    focusEl.style.opacity = strength;
  }

  // 路由状态：幕4 用；其它幕保持 baidu 直连
  function setRoute(t, active){
    var cn=$('routeCn'), os=$('routeOs'), why=$('routeWhyText'),
        logoDot=$('logoRouteDot'), localIp=$('localIp'), localPlace=$('localPlace');
    var proxy = active && t>=17.5;
    if (cn&&os){ cn.classList.toggle('is-on',!proxy); os.classList.toggle('is-on',proxy); }
    if (why) why.textContent = proxy ? '当前 google.com · 走代理 · 海外域名'
                                     : '当前 baidu.com · 直连 · 中国域名库';
    if (logoDot) logoDot.className = 'logo-route-dot '+(proxy?'is-purple':'is-green');
    if (localIp) localIp.textContent = proxy ? 'google.com' : 'baidu.com';
    if (localPlace) localPlace.textContent = proxy ? '海外域名 IP' : '中国域名 IP';
  }

  window.renderAt = function (t) {
    t = clamp(t,0,TOTAL-0.001);
    prog.style.width = (t/TOTAL*100).toFixed(2)+'%';

    var s = SCENES[SCENES.length-1];
    for (var i=0;i<SCENES.length;i++){ if (t>=SCENES[i].a && t<SCENES[i].b){ s=SCENES[i]; break; } }
    var local = (t-s.a)/(s.b-s.a);
    var enter = ease(clamp(local/0.12,0,1));
    var exit  = ease(clamp((s.b-t)/0.35,0,1));
    $('sceneLabel').textContent = s.no;

    // 全部复位
    for (var k in layers) layers[k].style.opacity = 0;
    caption.style.opacity = 0;
    panel.style.opacity = 0;
    focusEl.style.opacity = 0;
    roam.style.opacity = 0;
    setRoute(t,false);

    if (s.id === 'brand' || s.id === 'open') {
      // ── 幕1/8：全屏品牌 ──
      layers.brand.style.opacity = enter*exit;
      var pulse = 1 + 0.02*Math.sin(t*2.2);
      $('brandCatBox').style.transform = 'scale('+(pulse*(0.9+0.1*enter)).toFixed(3)+')';
      $('brandBadge').style.opacity = enter;
      $('brandTitle').style.opacity = enter;
      $('brandTitle').style.transform = 'translateY('+((1-enter)*20).toFixed(1)+'px)';
      $('brandSub').style.opacity = ease(clamp((local-0.1)/0.15,0,1));
      $('brandFoot').style.opacity = ease(clamp((local-0.2)/0.15,0,1));
      if (s.id === 'open') {
        $('brandBadge').textContent = 'OPEN SOURCE · FREE FOREVER';
        $('brandTitle').innerHTML = '开源 · 免费';
        $('brandSub').innerHTML = 'github.com/inlifee-rgb/zhilu-proxy';
        $('brandFoot').textContent = 'MIT LICENSE · 规则自动更新 · 判定可解释';
      } else {
        $('brandBadge').textContent = 'CHROME EXTENSION · MANIFEST V3';
        $('brandTitle').innerHTML = '智路';
        $('brandSub').innerHTML = '让国内网站直连，海外网站自动走代理';
        $('brandFoot').textContent = 'ZHILU · SMART PROXY';
      }
      setSpot(50,45);
      return;
    }

    if (s.id === 'pain') {
      // ── 幕2：双窗口痛点 ──
      layers.pain.style.opacity = enter*exit;
      var slide = (1-enter)*60;
      $('winBrowser').style.left = (108+slide)+'px'; $('winBrowser').style.top = '150px';
      $('winClash').style.left = (742-slide)+'px'; $('winClash').style.top = '150px';
      $('painVs').style.opacity = enter;
      $('painBottom').style.opacity = ease(clamp((local-0.25)/0.2,0,1));
      setSpot(50,45);
      return;
    }

    if (s.id === 'takeover') {
      // ── 幕3：面板从右侧滑入 + 放大 ──
      caption.style.opacity = 1;
      showCaption(s.no,'装上即接管','打开面板一眼确认：<br>Chrome 实际模式 =「PAC 智能分流」。','蓝色流光 = 正在工作',650,180,560,local);
      var k = ease(clamp(local/0.4,0,1));
      setPanel(lerp(1240,64,k), -64, lerp(0.9,1.0,k), enter*exit);
      setSpot(50+8*Math.sin(t*0.9),40+6*Math.cos(t*0.7));
      setFocus('healthCard', 0.30+0.18*(0.5+0.5*Math.sin(t*2)));
      return;
    }

    if (s.id === 'routing') {
      // ── 幕4：路由条特写（面板放大） ──
      caption.style.opacity = 1;
      var proxy = t>=17.5;
      showCaption(s.no,'每个域名走哪条，一眼看穿',
        proxy ? '切到 google.com，右侧「海外域名 IP」亮起紫灯：<br>google.com → 走代理 · 海外域名'
              : '当前页面命中依据直接显示：<br>baidu.com → 直连 · 中国域名库',
        proxy ? '紫色 = 走代理 · 海外域名' : '绿色 = 直连 · 中国域名库',
        630,150,590,local);
      setRoute(t,true);
      setPanel(40,-110,1.35,enter*exit);   // 放大并把路由条顶到视野中
      setSpot(50+10*Math.sin(t*1.1),36+8*Math.cos(t*0.8));
      setFocus('routeBar', 0.34+0.22*(0.5+0.5*Math.sin(t*2.4)));
      return;
    }

    if (s.id === 'verify') {
      // ── 幕5：IP 双卡 + 面板特写 ──
      caption.style.opacity = 1;
      showCaption(s.no,'代理到底生没生效？','代理出口：日本 · 东京（NRT）<br>本机真实：中国 广东 深圳','两个 IP 并排，真假一目了然',610,150,610,local);
      layers.ip.style.opacity = enter*exit;
      $('ipProxy').style.left = '638px'; $('ipProxy').style.top = '420px';
      $('ipLocal').style.left = '968px'; $('ipLocal').style.top = '420px';
      setPanel(44,-40,1.16,enter*exit);
      setSpot(50,34);
      setFocus('healthCard',0.28);
      return;
    }

    if (s.id === 'status') {
      // ── 幕6：工具栏状态点大特写，面板退到背景 ──
      caption.style.opacity = 1;
      showCaption(s.no,'直连绿 · 代理紫','工具栏图标右下角的小圆点，<br>随时告诉你当前页面走的是哪条路。','切换标签，实时变色',650,190,560,local);
      layers.tool.style.opacity = enter*exit;
      $('bigTool').style.left = '96px'; $('bigTool').style.top = '210px';
      $('bigTool').style.transform = 'scale('+(0.9+0.1*enter).toFixed(3)+')';
      var purple = (Math.floor((t-26)/1.1)%2)===1;
      $('bigDot').style.background = purple ? '#7c3aed' : '#22c55e';
      // 本幕主角是工具栏大特写，不放面板（避免衬底把字幕弄灰）
      setSpot(50,45);
      return;
    }

    if (s.id === 'motion') {
      // ── 幕7：面板居中 + 猫跳 + 聚光 ──
      caption.style.opacity = 1;
      showCaption(s.no,'有质感的细节','聚光跟随、边缘流光，<br>还有一只趴在卡片边缘摇尾巴眨眼的智路猫。','浅色磨砂玻璃 · 五种交互动效',52,96,470,local);
      setPanel(560,40,1.0,enter*exit);   // 原始尺寸，底部不被截断
      setSpot(30+40*(0.5+0.5*Math.sin(t*1.6)),30+40*(0.5+0.5*Math.cos(t*1.3)));

      // 猫：安静趴在健康卡右上角边缘，呼吸起伏 + 尾巴轻摆 + 偶尔眨眼。
      // 不做跨卡片跳跃 —— 用户明确要「趴卡片边缘、摇尾眨眼」，跳跃会显得脱节。
      roam.style.opacity = 1;
      var CAT_W = 72, CAT_H = 60, PAW = 94/100*CAT_H;  // 前爪素材 y≈94，扣住卡片上边线
      var hc = $('healthCard');
      if (hc) {
        var cr = hc.getBoundingClientRect();
        var px = cr.left + cr.width - CAT_W - 10;
        var py = cr.top - PAW + 1;         // 前爪正好搭在卡片上边线
        roam.style.left = px.toFixed(1)+'px';
        roam.style.top = py.toFixed(1)+'px';
        var sy = 1 + 0.025*Math.sin(t*3.0);  // 呼吸
        roam.style.transform = 'scale(1,'+sy.toFixed(3)+')';
        var tail = $('catTail');
        if (tail) tail.setAttribute('transform', 'rotate('+(Math.sin(t*2.4)*15).toFixed(1)+')');
      }
      return;
    }
  };

  window.renderAt(0);
})();
