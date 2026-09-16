/* ============================================================
 * Remix Studio — 叠加子界面（2 步：框定范围 → 微调叠加）
 * 第 1 步：两段音频各自框定自定义范围
 *         （光标悬停变粗 + 右键 开始/结束/取消自定义；也可直接拖拽画范围）
 * 第 2 步：拼接式上下对齐——偏移滑块只移动下方音频；可调换上下顺序；
 *         音量·倍速两段分别调整（共 4 滑块 + 实时 BPM），整段音频生效；
 *         试听逻辑与拼接界面一致（单击设起点 / 拖拽范围循环 / 试听叠加结果）
 * 输出 = 两段完整音频叠混：下段整体平移使其范围起点 = 上段范围起点 + 偏移
 * ============================================================ */
(function () {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function fmtSec(s) { return String(+(s.toFixed(1))); }
  function stripExt(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
  }
  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  /* ---------------- DOM ---------------- */
  const pageOverlay = document.getElementById('page-overlay');
  const wizardTitle = document.getElementById('ov-wizard-title');
  const stepDots = document.getElementById('ov-step-dots');
  const wizardDesc = document.getElementById('ov-wizard-desc');
  const stepBody = document.getElementById('ov-step-body');
  const btnPlay = document.getElementById('btn-ov-stepplay');
  const btnBack = document.getElementById('btn-ov-back');
  const btnNext = document.getElementById('btn-ov-next');
  const stepTip = document.getElementById('ov-step-tip');
  const exportSection = document.getElementById('ov-export-section');
  const btnSave = document.getElementById('btn-overlay-save');
  const exportBar = document.getElementById('ov-export-bar');
  const exportFill = document.getElementById('ov-export-fill');
  const exportStatus = document.getElementById('ov-export-status');
  const toast = document.getElementById('toast');

  /* ---------------- 状态 ---------------- */
  let segs = [];        // { name, buffer, bpm, range:{from,to}|null, rec:start|null, cursor:0 }
  let trackIds = [];
  let step = 0;         // 0 = 框定范围, 1 = 微调
  let active = 0;       // 第 1 步：当前卡（播放目标）
  let order = [0, 1];   // 第 2 步：[上段 segIdx, 下段 segIdx]
  let offset = 0;       // 下段范围起点 − 上段范围起点（输出秒；0 = 开头对齐）
  const rates = [1, 1]; // 两段各自倍速（互不影响）
  const vols = [1, 1];  // 两段各自音量（1 = 不变，互不影响）
  let dirty = false;    // 是否做过调整（退出时询问）
  let version = 0;      // 参数版本号（渲染缓存键）
  let heldAxis = 0;     // 第 2 步视图轴长（秒）：只在范围变宽时增长，避免两段互相牵动

  // 第 2 步 DOM（renderStep2 时创建）
  let timeline = null, barU = null, barL = null, band = null, handle = null;
  let tagU = null, tagL = null, canvasU = null, canvasL = null;
  let offsetInput = null, offsetVal = null, hintEl = null, btnPreview = null;

  let audioCtx = null;
  function ensureCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  let toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 1800);
  }

  function bpmText(i) {
    var seg = segs[i];
    return seg && seg.bpm ? Math.round(seg.bpm * (rates[i] || 1)) + ' BPM' : '-- BPM';
  }

  /* ---------------- 波形绘制（移植拼接：逐列峰值） ---------------- */
  function drawWave(canvas, buffer, from, to) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (!cssW || !cssH) return;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const sr = buffer.sampleRate;
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
    const a0 = clamp(Math.floor(from * sr), 0, buffer.length);
    const a1 = clamp(Math.ceil(to * sr), 0, buffer.length);
    const span = Math.max(1, a1 - a0);
    const mid = cssH / 2;

    ctx.fillStyle = 'rgba(242,238,255,0.5)';
    for (let x = 0; x < cssW; x++) {
      const s = a0 + Math.floor(span * x / cssW);
      const e = a0 + Math.max(1, Math.floor(span * (x + 1) / cssW));
      const step = Math.max(1, Math.floor((e - s) / 400));
      let peak = 0;
      for (let j = s; j < e; j += step) {
        const v = Math.abs((ch0[j] + ch1[j]) * 0.5);
        if (v > peak) peak = v;
      }
      const h = Math.max(1, peak * (cssH / 2 - 3));
      ctx.fillRect(x, mid - h, 1, h * 2);
    }
  }

  /* ============================================================
   * 第 1 步：框定范围
   * ============================================================ */
  const cardEls = [];  // { card, wave, canvas, playhead, band, rangeText }
  let cardPlay = null; // { segIdx, src, ctx, t0, base, raf }

  function setPlayBtn(text) { btnPlay.textContent = text; }

  function stopCardPlay() {
    if (!cardPlay) return;
    var cp = cardPlay;
    cardPlay = null;
    if (cp.raf) cancelAnimationFrame(cp.raf);
    try { cp.src.onended = null; } catch (e) {}
    try { cp.src.stop(); } catch (e) {}
    try { cp.src.disconnect(); } catch (e) {}
    setPlayBtn('▶︎ 播放');
    updateCardPlayhead(cp.segIdx);
  }

  function startCardPlay() {
    if (step !== 0 || !segs.length) return;
    stopCardPlay();
    var i = active;
    var seg = segs[i];
    var ctx = ensureCtx();
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    var base = clamp(seg.cursor, 0, seg.buffer.duration);
    if (base >= seg.buffer.duration - 0.01) base = 0; // 已到结尾：从头播放
    var src = ctx.createBufferSource();
    src.buffer = seg.buffer;
    src.connect(ctx.destination);
    var t0 = ctx.currentTime + 0.03;
    src.start(t0, base);
    cardPlay = { segIdx: i, src: src, ctx: ctx, t0: t0, base: base, raf: 0 };
    setPlayBtn('⏹︎ 停止');
    var token = cardPlay;
    src.onended = function () {
      if (cardPlay !== token) return;
      segs[i].cursor = segs[i].buffer.duration; // 播完停在结尾，下次播放自动回头
      stopCardPlay();
    };
    (function tick() {
      if (cardPlay !== token) return;
      var elapsed = Math.max(0, ctx.currentTime - t0);
      segs[i].cursor = clamp(base + elapsed, 0, segs[i].buffer.duration);
      updateCardPlayhead(i);
      cardPlay.raf = requestAnimationFrame(tick);
    })();
  }

  function toggleCardPlay() {
    if (cardPlay) stopCardPlay();
    else startCardPlay();
  }

  function cursorPx(seg, wave) {
    var W = wave.clientWidth;
    return seg.cursor / seg.buffer.duration * W;
  }

  function updateCardPlayhead(i) {
    var el = cardEls[i];
    if (!el || !el.wave.clientWidth) return;
    el.playhead.style.left = cursorPx(segs[i], el.wave) + 'px';
  }

  // 范围带：记录中 = 起点→光标 实时预览；已定 = 固定范围
  function updateCardRange(i) {
    var el = cardEls[i];
    var seg = segs[i];
    if (!el) return;
    var W = el.wave.clientWidth;
    var dur = seg.buffer.duration;
    var a = null, b = null;
    if (seg.rec != null) {
      a = Math.min(seg.rec, seg.cursor);
      b = Math.max(seg.rec, seg.cursor);
      el.rangeText.textContent = '记录中：' + formatTime(a) + ' → 光标 ' + formatTime(b);
    } else if (seg.range) {
      a = seg.range.from; b = seg.range.to;
      el.rangeText.textContent = '范围 ' + formatTime(a) + ' ~ ' + formatTime(b) + '（' + fmtSec(b - a) + 's）';
    } else {
      el.rangeText.textContent = '未设置';
    }
    if (a != null && W) {
      el.band.hidden = false;
      el.band.style.left = (a / dur * W) + 'px';
      el.band.style.width = Math.max(1, (b - a) / dur * W) + 'px';
    } else {
      el.band.hidden = true;
    }
  }

  /* ---------------- 第 1 步右键菜单：仅 开始/结束/取消 自定义 ---------------- */
  var ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctx-menu';
  ctxMenu.hidden = true;
  document.body.appendChild(ctxMenu);
  function closeMenu() { ctxMenu.hidden = true; }
  document.addEventListener('click', function (e) {
    if (!ctxMenu.contains(e.target)) closeMenu();
  });
  window.addEventListener('blur', closeMenu);

  function endRec(i) {
    var seg = segs[i];
    var a = seg.rec, b = seg.cursor;
    seg.rec = null;
    closeMenu();
    if (Math.abs(b - a) < 0.05) {
      updateCardRange(i);
      showToast('范围太短，已取消');
      return;
    }
    seg.range = { from: Math.min(a, b), to: Math.max(a, b) };
    dirty = true;
    version++;
    updateCardRange(i);
    showToast('已框定范围 ' + formatTime(seg.range.from) + ' ~ ' + formatTime(seg.range.to));
  }

  function openCardMenu(e, i) {
    var seg = segs[i];
    e.preventDefault();
    e.stopPropagation();
    ctxMenu.innerHTML = '';
    var items;
    if (seg.rec == null) {
      items = [{
        label: '开始自定义',
        fn: function () {
          seg.rec = seg.cursor;
          closeMenu();
          updateCardRange(i);
          showToast('已记下起点 ' + formatTime(seg.rec) + '：把光标移到终点后右键选「结束自定义」');
        }
      }];
    } else {
      items = [
        { label: '结束自定义', fn: function () { endRec(i); } },
        {
          label: '✕ 取消自定义',
          fn: function () {
            seg.rec = null;
            closeMenu();
            updateCardRange(i);
            showToast('已取消本次自定义');
          }
        }
      ];
    }
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-item';
      b.textContent = it.label;
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        closeMenu();
        it.fn();
      });
      ctxMenu.appendChild(b);
    });
    ctxMenu.style.left = e.clientX + 'px';
    ctxMenu.style.top = e.clientY + 'px';
    ctxMenu.hidden = false;
  }

  /* ---------------- 第 1 步渲染 ---------------- */
  function renderStep1() {
    stepBody.innerHTML = '';
    cardEls.length = 0;
    segs.forEach(function (seg, i) {
      var card = document.createElement('div');
      card.className = 'ov-card' + (i === active ? ' active' : '');
      var head = document.createElement('div');
      head.className = 'ov-card-head';
      var tag = document.createElement('span');
      tag.className = 'ov-card-tag';
      tag.textContent = '音乐' + (i + 1);
      var name = document.createElement('span');
      name.className = 'ov-card-name';
      name.textContent = seg.name;
      name.title = seg.name;
      var meta = document.createElement('span');
      meta.className = 'ov-card-meta';
      meta.textContent = (seg.bpm ? Math.round(seg.bpm) + ' BPM · ' : '') + formatTime(seg.buffer.duration) + ' · ';
      var rangeText = document.createElement('span');
      rangeText.className = 'ov-card-range';
      meta.appendChild(rangeText);
      head.appendChild(tag);
      head.appendChild(name);
      head.appendChild(meta);

      var wave = document.createElement('div');
      wave.className = 'ov-card-wave';
      var canvas = document.createElement('canvas');
      wave.appendChild(canvas);
      var band = document.createElement('div');
      band.className = 'ov-range-band';
      band.hidden = true;
      wave.appendChild(band);
      var playhead = document.createElement('div');
      playhead.className = 'ov-playhead';
      wave.appendChild(playhead);

      var hint = document.createElement('p');
      hint.className = 'ov-card-hint';
      hint.textContent = '单击定位，拖拽绘制范围，右键光标设定起点与终点';

      card.appendChild(head);
      card.appendChild(wave);
      card.appendChild(hint);
      stepBody.appendChild(card);

      cardEls.push({ card: card, wave: wave, canvas: canvas, playhead: playhead, band: band, rangeText: rangeText });

      // 点击卡片头部/提示区 → 设为当前音频（播放目标）；波形区在下方自己的 pointerdown 里激活
      card.addEventListener('pointerdown', function () {
        if (active === i) return;
        active = i;
        cardEls.forEach(function (c, k) { c.card.classList.toggle('active', k === active); });
      });

      // 波形交互（左键）：靠近光标 = 拖光标；否则拖拽画范围 / 单击定位
      wave.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return; // 右键留给自定义菜单
        active = i;
        cardEls.forEach(function (c, k) { c.card.classList.toggle('active', k === active); });
        e.preventDefault();
        try { wave.setPointerCapture(e.pointerId); } catch (err) {}
        stopCardPlay(); // 播放原则：开始新的波形交互先停掉播放
        var dur = seg.buffer.duration;
        var rect = wave.getBoundingClientRect();
        var x0 = clamp(e.clientX - rect.left, 0, rect.width);
        var mode = Math.abs(x0 - cursorPx(seg, wave)) <= 8 ? 'cursor' : 'range';
        var drag = { x0: x0, moved: false, mode: mode };
        function move(ev) {
          var r = wave.getBoundingClientRect();
          var x = clamp(ev.clientX - r.left, 0, r.width);
          if (!drag.moved && Math.abs(x - drag.x0) > 4) drag.moved = true;
          if (!drag.moved) return;
          if (drag.mode === 'cursor') {
            seg.cursor = clamp(x / r.width * dur, 0, dur);
            updateCardPlayhead(i);
            updateCardRange(i); // 记录中：范围带跟随光标实时更新
          } else {
            var a = Math.min(drag.x0, x) / r.width * dur;
            var b = Math.max(drag.x0, x) / r.width * dur;
            band.hidden = false; // 拖拽中实时预览范围带
            band.style.left = (a / dur * r.width) + 'px';
            band.style.width = Math.max(1, (b - a) / dur * r.width) + 'px';
          }
        }
        function up(ev) {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          var r = wave.getBoundingClientRect();
          var x = (ev.clientX != null) ? clamp(ev.clientX - r.left, 0, r.width) : drag.x0;
          if (drag.moved && drag.mode === 'range') {
            var a = Math.min(drag.x0, x) / r.width * dur;
            var b = Math.max(drag.x0, x) / r.width * dur;
            if (b - a >= 0.05) {
              seg.range = { from: a, to: b };
              seg.rec = null;
              dirty = true;
              version++;
              showToast('已框定范围 ' + formatTime(a) + ' ~ ' + formatTime(b));
            }
          } else if (!drag.moved) {
            seg.cursor = clamp(x / r.width * dur, 0, dur); // 单击定位光标
          }
          updateCardPlayhead(i);
          updateCardRange(i);
        }
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });

      // 右键光标 → 自定义菜单（开始/结束/取消）
      wave.addEventListener('contextmenu', function (e) {
        var r = wave.getBoundingClientRect();
        var x = e.clientX - r.left;
        if (Math.abs(x - cursorPx(seg, wave)) > 10) return; // 只在光标附近弹出
        active = i;
        cardEls.forEach(function (c, k) { c.card.classList.toggle('active', k === active); });
        openCardMenu(e, i);
      });

      // 悬停光标附近 → 光标变粗（提示可拖拽）
      wave.addEventListener('pointermove', function (e) {
        if (e.buttons) return;
        var r = wave.getBoundingClientRect();
        var x = e.clientX - r.left;
        playhead.classList.toggle('near', Math.abs(x - cursorPx(seg, wave)) <= 8);
      });
      wave.addEventListener('pointerleave', function () { playhead.classList.remove('near'); });
    });

    // 绘制 + 状态落位
    segs.forEach(function (seg, i) {
      var el = cardEls[i];
      drawWave(el.canvas, seg.buffer, 0, seg.buffer.duration);
      updateCardPlayhead(i);
      updateCardRange(i);
    });
  }

  /* ============================================================
   * 第 2 步：微调叠加
   * ============================================================ */

  // 单段的输出几何：zs/ze = 范围区间在输出时间轴上的位置（相对本段起点），total = 本段贡献总长
  function segPlan(i) {
    var seg = segs[i];
    var rate = rates[i] || 1;
    var r = seg.range;
    var zs = r.from / rate;
    var ze = r.to / rate;
    var total = seg.buffer.duration / rate;
    return { segIndex: i, seg: seg, rate: rate, vol: vols[i] || 1, zs: zs, ze: ze, total: total, w: ze - zs };
  }

  // 叠混几何：上段从 0 开始；下段平移使其范围起点 = 上段范围起点 + offset
  function mixGeometry() {
    var up = segPlan(order[0]);
    var low = segPlan(order[1]);
    var tB = (up.zs + offset) - low.zs;
    var shift = Math.max(0, -tB);
    var tA = shift;
    var tB2 = tB + shift;
    var total = Math.max(tA + up.total, tB2 + low.total);
    return {
      up: up, low: low, tA: tA, tB: tB2,
      total: Math.max(0.1, total),
      zu: tA + up.zs             // 上段范围起点（最终输出时间）
    };
  }

  // 离线渲染叠混结果（音量/倍速整段生效：两段各自独立的恒定速率与增益）
  function renderMix(geo) {
    var sr = segs[0].buffer.sampleRate;
    var len = Math.max(1, Math.ceil(geo.total * sr));
    var Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var offline = new Ctor(2, len, sr);
    [{ plan: geo.up, start: geo.tA }, { plan: geo.low, start: geo.tB }].forEach(function (p) {
      var plan = p.plan, start = p.start;
      var src = offline.createBufferSource();
      src.buffer = plan.seg.buffer;
      src.playbackRate.value = plan.rate;   // 本段自己的倍速
      var gain = offline.createGain();
      gain.gain.value = plan.vol;           // 本段自己的音量
      src.connect(gain);
      gain.connect(offline.destination);
      src.start(start);
    });
    return offline.startRendering();
  }

  /* ---------------- 试听（移植拼接：缓存 + 防抖重启 + 循环） ---------------- */
  let previewSrc = null;
  let previewSession = 0;
  let restartTimer = null;
  let previewRaf = 0;
  let playbackInfo = null;
  let previewCache = null;     // { version, geo, buffer }
  let previewStartT = null;    // 试听起点（视图时间：0 = 上段范围起点）
  let previewRange = null;     // { a, b } 循环范围（视图时间）
  let viewGeom = { axis: 1 };

  function setPreviewBtn(text) { if (btnPreview) btnPreview.textContent = text; }
  function isPreviewPlaying() { return !!previewSrc; }

  function stopPreview() {
    previewSession++;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (previewSrc) {
      var s = previewSrc;
      previewSrc = null;
      try { s.onended = null; } catch (e) {}
      try { s.stop(); } catch (e) {}
      try { s.disconnect(); } catch (e) {}
    }
    if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = 0; }
    playbackInfo = null;
    setPreviewBtn('▶︎ 试听叠加结果');
    updateMarkers();
  }

  async function getMixData(token) {
    if (previewCache && previewCache.version === version) return previewCache;
    setPreviewBtn('渲染中…');
    var geo = mixGeometry();
    var buffer = await renderMix(geo);
    if (token !== previewSession) return { version: -1, geo: geo, buffer: buffer }; // 期间已被停止/重启
    previewCache = { version: version, geo: geo, buffer: buffer };
    return previewCache;
  }

  async function startPreview() {
    if (step !== 1 || segs.length < 2) return;
    var ctx = ensureCtx();
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    var token = ++previewSession;
    var data;
    try {
      data = await getMixData(token);
    } catch (e) {
      console.error(e);
      return;
    }
    if (token !== previewSession) return; // 渲染期间被停止/重启

    var g = data.geo;
    var toMix = function (vt) { return g.zu + vt; }; // 视图时间 → 输出时间

    var from, to, loop;
    if (previewRange) {
      from = toMix(Math.min(previewRange.a, previewRange.b));
      to = toMix(Math.max(previewRange.a, previewRange.b));
      loop = true;
    } else if (previewStartT != null) {
      from = toMix(previewStartT);
      to = toMix(viewGeom.axis);
      loop = false;
    } else {
      from = toMix(0); // 默认从两段范围的对齐起点开始
      to = toMix(viewGeom.axis);
      loop = false;
    }
    from = clamp(from, 0, Math.max(0, data.buffer.duration - 0.05));
    to = clamp(to, from + 0.05, data.buffer.duration);

    var src = ctx.createBufferSource();
    src.buffer = data.buffer;
    if (loop) { src.loop = true; src.loopStart = from; src.loopEnd = to; }
    src.connect(ctx.destination);
    var t0 = ctx.currentTime + 0.05;
    src.start(t0, from);
    if (!loop) src.stop(t0 + (to - from));

    previewSrc = src;
    playbackInfo = { ctx: ctx, t0: t0, from: from, to: to, loop: loop, zu: g.zu, axis: viewGeom.axis };
    setPreviewBtn('⏹︎ 停止试听');
    cancelAnimationFrame(previewRaf);
    previewRaf = requestAnimationFrame(updateOvPlayhead);
    src.onended = function () {
      if (token !== previewSession || previewSrc !== src) return;
      previewSrc = null;
      playbackInfo = null;
      if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = 0; }
      setPreviewBtn('▶︎ 试听叠加结果');
      updateMarkers();
    };
  }

  function togglePreview() {
    if (isPreviewPlaying()) stopPreview();
    else startPreview();
  }

  // 参数变化后自动重播（防抖）
  function schedulePreviewRestart() {
    if (!isPreviewPlaying()) return;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(function () {
      restartTimer = null;
      if (!isPreviewPlaying()) return;
      stopPreview();
      startPreview();
    }, 300);
  }

  // 试听光标随播放推进（视图时间 ↔ 输出时间映射）
  function updateOvPlayhead() {
    if (!playbackInfo || !previewSrc) { previewRaf = 0; return; }
    var info = playbackInfo;
    var elapsed = Math.max(0, info.ctx.currentTime - info.t0);
    var pos = info.from + elapsed;
    if (info.loop && pos > info.to) {
      pos = info.from + ((pos - info.from) % Math.max(0.001, info.to - info.from));
    }
    pos = Math.min(pos, info.to);
    var W = timeline.clientWidth;
    if (W) {
      var vt = clamp(pos - info.zu, 0, info.axis);
      handle.style.left = (W * vt / info.axis) + 'px';
    }
    previewRaf = requestAnimationFrame(updateOvPlayhead);
  }

  /* ---------------- 时间轴手势（移植拼接） ---------------- */
  var rangeDrag = null;
  function xToViewT(px) {
    return clamp(px / timeline.clientWidth * viewGeom.axis, 0, viewGeom.axis);
  }

  function timelineCursorDragStart() {
    handle.classList.add('near');
    function move(ev) {
      var rect = timeline.getBoundingClientRect();
      var x = clamp(ev.clientX - rect.left, 0, timeline.clientWidth);
      previewRange = null;
      previewStartT = xToViewT(x);
      updateMarkers();
      schedulePreviewRestart();
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function timelinePointerDown(e) {
    if (step !== 1 || segs.length < 2) return;
    e.preventDefault();
    var rect = timeline.getBoundingClientRect();
    var x = clamp(e.clientX - rect.left, 0, timeline.clientWidth);
    var handleLeft = parseFloat(handle.style.left) || 0;
    if (Math.abs(x - handleLeft) <= 8) { // 靠近光标 → 拖拽光标
      timelineCursorDragStart();
      return;
    }
    rangeDrag = { startX: x, moved: false };
    window.addEventListener('pointermove', timelinePointerMove);
    window.addEventListener('pointerup', timelinePointerUp);
    window.addEventListener('pointercancel', timelinePointerUp);
  }

  function timelinePointerMove(e) {
    if (!rangeDrag) return;
    var rect = timeline.getBoundingClientRect();
    var x = clamp(e.clientX - rect.left, 0, timeline.clientWidth);
    if (!rangeDrag.moved && Math.abs(x - rangeDrag.startX) > 4) rangeDrag.moved = true;
    if (rangeDrag.moved) {
      band.hidden = false;
      band.style.left = Math.min(rangeDrag.startX, x) + 'px';
      band.style.width = Math.max(0, Math.abs(x - rangeDrag.startX)) + 'px';
    }
  }

  function timelinePointerUp(e) {
    if (!rangeDrag) return;
    var drag = rangeDrag;
    rangeDrag = null;
    window.removeEventListener('pointermove', timelinePointerMove);
    window.removeEventListener('pointerup', timelinePointerUp);
    window.removeEventListener('pointercancel', timelinePointerUp);

    var rect = timeline.getBoundingClientRect();
    var x = (e.clientX != null) ? clamp(e.clientX - rect.left, 0, timeline.clientWidth) : drag.startX;

    if (drag.moved) {
      var a = xToViewT(Math.min(drag.startX, x));
      var b = xToViewT(Math.max(drag.startX, x));
      if (b - a >= 0.2) {
        previewRange = { a: a, b: b };
        previewStartT = a;  // 光标 = 范围起点
        updateMarkers();
        stopPreview();
        startPreview();     // 松开即循环试听该范围
        return;
      }
      // 拖动距离过短，按单击处理
    }
    // 单击：设试听起点，清除循环范围
    previewRange = null;
    previewStartT = xToViewT(x);
    updateMarkers();
    schedulePreviewRestart();
  }

  function updateMarkers() {
    if (!timeline || !timeline.clientWidth) return;
    var W = timeline.clientWidth;
    var vt = (previewStartT != null) ? previewStartT : 0; // 默认停在上段范围起点（视图原点）
    handle.style.left = (W * clamp(vt, 0, viewGeom.axis) / viewGeom.axis) + 'px';
    if (previewRange) {
      var a = Math.min(previewRange.a, previewRange.b);
      var b = Math.max(previewRange.a, previewRange.b);
      band.hidden = false;
      band.style.left = (W * a / viewGeom.axis) + 'px';
      band.style.width = (W * (b - a) / viewGeom.axis) + 'px';
    } else {
      band.hidden = true;
    }
  }

  /* ---------------- 第 2 步渲染 ---------------- */
  function syncOffsetSlider() {
    var up = segPlan(order[0]);
    var low = segPlan(order[1]);
    offset = clamp(offset, -low.w, up.w);
    offsetInput.min = String(-low.w.toFixed(1));
    offsetInput.max = String(up.w.toFixed(1));
    offsetInput.value = String(offset);
    offsetVal.textContent = (offset > 0 ? '+' : '') + offset.toFixed(1) + 's';
  }

  function layoutStep2() {
    var W = timeline.clientWidth;
    if (!W) return;
    var up = segPlan(order[0]);
    var low = segPlan(order[1]);
    // 轴长只在某段范围变宽（倍速调慢）时增长：调快/调音量绝不会牵动另一段的显示
    var need = up.w + low.w;
    if (need > heldAxis) heldAxis = need;
    var axis = Math.max(0.1, heldAxis);
    viewGeom = { axis: axis };
    barU.style.left = '0px';
    barU.style.width = (W * up.w / axis) + 'px';
    barL.style.left = (W * offset / axis) + 'px'; // 只随「下段位置」滑块移动
    barL.style.width = (W * low.w / axis) + 'px';
    updateMarkers();
  }

  function drawStep2Wave(pos) { // pos: 0 = 上段, 1 = 下段
    var seg = segs[order[pos]];
    drawWave(pos === 0 ? canvasU : canvasL, seg.buffer, seg.range.from, seg.range.to);
  }

  function drawStep2Waves() {
    drawStep2Wave(0);
    drawStep2Wave(1);
  }

  function updateHint() {
    var txt;
    if (Math.abs(offset) < 0.05) {
      txt = '两段范围开头对齐。';
    } else if (offset > 0) {
      txt = '下方音频在上段范围起点后 ' + offset.toFixed(1) + 's 接入。';
    } else {
      txt = '下方音频在上段范围起点前 ' + (-offset).toFixed(1) + 's 接入。';
    }
    hintEl.textContent = txt + '拖动「下段位置」滑块只移动下方音频；单击时间轴设试听起点，按住拖动画出循环范围。';
  }

  function renderStep2() {
    stepBody.innerHTML = '';
    heldAxis = 0; // 进入本步：轴长按当前几何重建

    /* --- 对齐设置卡 --- */
    var card = document.createElement('div');
    card.className = 'card';
    var title = document.createElement('h2');
    title.className = 'section-title';
    title.textContent = '对齐设置';
    card.appendChild(title);

    timeline = document.createElement('div');
    timeline.className = 'splice-timeline';
    timeline.id = 'ov-timeline';
    timeline.innerHTML =
      '<div class="splice-bar" id="ov-bar-u"><canvas></canvas><span class="splice-wave-tag"></span></div>' +
      '<div class="splice-bar" id="ov-bar-l"><canvas></canvas><span class="splice-wave-tag"></span></div>' +
      '<div class="splice-band" hidden></div>' +
      '<div class="splice-handle" title="试听光标"><span></span></div>';
    card.appendChild(timeline);
    barU = timeline.querySelector('#ov-bar-u');
    barL = timeline.querySelector('#ov-bar-l');
    canvasU = barU.querySelector('canvas');
    canvasL = barL.querySelector('canvas');
    tagU = barU.querySelector('.splice-wave-tag');
    tagL = barL.querySelector('.splice-wave-tag');
    band = timeline.querySelector('.splice-band');
    handle = timeline.querySelector('.splice-handle');

    var row = document.createElement('div');
    row.className = 'splice-row';
    row.innerHTML =
      '<button id="btn-ov-swap" class="btn btn-small" type="button" title="交换两段音频的上下位置（下方音频继续由滑块调整）">⇅ 调换顺序</button>' +
      '<input type="range" class="slider" min="-10" max="10" step="0.1" value="0">' +
      '<span class="splice-row-value">0.0s</span>';
    card.appendChild(row);
    var btnSwap = row.querySelector('#btn-ov-swap');
    offsetInput = row.querySelector('input');
    offsetVal = row.querySelector('.splice-row-value');

    var previewRow = document.createElement('div');
    previewRow.className = 'splice-preview-row';
    previewRow.innerHTML =
      '<button id="btn-ov-preview" class="btn" type="button">▶︎ 试听叠加结果</button>' +
      '<span class="splice-tip">单击设定试听起点，拖拽选择循环播放范围</span>';
    card.appendChild(previewRow);
    btnPreview = previewRow.querySelector('#btn-ov-preview');

    hintEl = document.createElement('p');
    hintEl.className = 'splice-hint';
    card.appendChild(hintEl);
    stepBody.appendChild(card);

    /* --- 音量与倍速卡 --- */
    var params = document.createElement('div');
    params.className = 'card';
    var ptitle = document.createElement('h2');
    ptitle.className = 'section-title';
    ptitle.textContent = '音量与倍速（两段分别调整）';
    params.appendChild(ptitle);

    // 音量组
    var volGroup = document.createElement('div');
    volGroup.className = 'ov-param-group';
    var volHead = document.createElement('div');
    volHead.className = 'ov-param-title';
    volHead.innerHTML = '<span>音量（整段音频生效）</span>';
    volGroup.appendChild(volHead);
    [0, 1].forEach(function (i) {
      var r = document.createElement('div');
      r.className = 'ov-param-row';
      r.innerHTML =
        '<span class="ov-param-label">音乐' + (i + 1) + ' 音量</span>' +
        '<input type="range" class="slider" min="0" max="2" step="0.01" value="' + vols[i] + '">' +
        '<span class="ov-param-val">' + Math.round(vols[i] * 100) + '%</span>';
      volGroup.appendChild(r);
      var input = r.querySelector('input');
      var val = r.querySelector('.ov-param-val');
      input.addEventListener('input', function () {
        vols[i] = clamp(parseFloat(input.value) || 1, 0, 2);
        val.textContent = Math.round(vols[i] * 100) + '%';
        dirty = true;
        version++;
        schedulePreviewRestart();
      });
    });
    params.appendChild(volGroup);

    // 倍速组
    var rateGroup = document.createElement('div');
    rateGroup.className = 'ov-param-group';
    var rateHead = document.createElement('div');
    rateHead.className = 'ov-param-title';
    rateHead.innerHTML = '<span>倍速（整段音频生效）</span>';
    rateGroup.appendChild(rateHead);
    [0, 1].forEach(function (i) {
      var r = document.createElement('div');
      r.className = 'ov-param-row';
      r.innerHTML =
        '<span class="ov-param-label">音乐' + (i + 1) + ' 倍速</span>' +
        '<input type="range" class="slider" min="0.5" max="1.5" step="0.01" value="' + rates[i] + '">' +
        '<span class="ov-param-val">' + rates[i].toFixed(2) + 'x</span>' +
        '<span class="ov-param-bpm">' + bpmText(i) + '</span>';
      rateGroup.appendChild(r);
      var input = r.querySelector('input');
      var val = r.querySelector('.ov-param-val');
      var bpmSpan = r.querySelector('.ov-param-bpm');
      input.addEventListener('input', function () {
        rates[i] = clamp(parseFloat(input.value) || 1, 0.5, 1.5);
        val.textContent = rates[i].toFixed(2) + 'x';
        bpmSpan.textContent = bpmText(i);
        dirty = true;
        version++;
        syncOffsetSlider(); // 倍速改变范围宽度 → 偏移滑块范围跟随
        layoutStep2();
        drawStep2Wave(i);   // 只重画本段波形：另一段显示完全不动
        schedulePreviewRestart();
      });
    });
    params.appendChild(rateGroup);

    // 所有参数数值支持点击输入（偏移/音量×2/倍速×2）
    if (window.attachValueEditor) {
      params.querySelectorAll('.ov-param-row').forEach(function (r) {
        var val = r.querySelector('.ov-param-val');
        var input = r.querySelector('input');
        if (val && input) attachValueEditor(val, input);
      });
    }
    stepBody.appendChild(params);

    /* --- 状态落位 --- */
    tagU.textContent = '音乐' + (order[0] + 1) + ' · 叠加范围（上）';
    tagL.textContent = '音乐' + (order[1] + 1) + ' · 叠加范围（下）';
    syncOffsetSlider();
    layoutStep2();
    drawStep2Waves();
    updateHint();

    /* --- 接线 --- */
    offsetInput.addEventListener('input', function () {
      offset = parseFloat(offsetInput.value) || 0;
      offsetVal.textContent = (offset > 0 ? '+' : '') + offset.toFixed(1) + 's';
      dirty = true;
      version++;
      layoutStep2();
      updateHint();
      schedulePreviewRestart();
    });
    btnSwap.addEventListener('click', function () {
      stopPreview();
      order = [order[1], order[0]];
      offset = -offset; // 保持相对位置不变：滑块改为控制新的下方音频
      var up = segPlan(order[0]);
      var low = segPlan(order[1]);
      offset = clamp(offset, -low.w, up.w);
      dirty = true;
      version++;
      heldAxis = 0; // 上下互换后轴长重建
      tagU.textContent = '音乐' + (order[0] + 1) + ' · 叠加范围（上）';
      tagL.textContent = '音乐' + (order[1] + 1) + ' · 叠加范围（下）';
      syncOffsetSlider();
      layoutStep2();
      drawStep2Waves();
      updateHint();
      showToast('已调换上下顺序：滑块现在控制音乐' + (order[1] + 1));
    });
    btnPreview.addEventListener('click', togglePreview);
    timeline.addEventListener('pointerdown', timelinePointerDown);
    timeline.addEventListener('pointermove', function (e) {
      if (rangeDrag) return;
      var rect = timeline.getBoundingClientRect();
      var x = clamp(e.clientX - rect.left, 0, timeline.clientWidth);
      var handleLeft = parseFloat(handle.style.left) || 0;
      handle.classList.toggle('near', Math.abs(x - handleLeft) <= 8);
    });
    timeline.addEventListener('pointerleave', function () { handle.classList.remove('near'); });
  }

  /* ---------------- 保存（替换 / 保留原音频） ---------------- */
  async function saveOverlay() {
    if (segs.length < 2) return;
    stopPreview();
    stopCardPlay();
    btnSave.disabled = true;
    exportBar.hidden = false;
    exportFill.style.width = '0%';
    exportStatus.textContent = '正在渲染…';
    exportBar.classList.add('indeterminate'); // 渲染阶段无进度事件 → 流光
    try {
      await new Promise(function (r) { setTimeout(r, 30); });
      var geo = mixGeometry();
      var rendered = await renderMix(geo);
      var name = stripExt(segs[0].name) + '+' + stripExt(segs[1].name) + '_叠加';
      exportBar.classList.remove('indeterminate');
      exportFill.style.width = '100%';
      exportBar.hidden = true;
      window.openSaveChoice(rendered, name, trackIds); // 询问替换/保留原音频
    } catch (e) {
      console.error(e);
      exportStatus.textContent = '保存失败：' + (e && e.message ? e.message : e);
    } finally {
      exportBar.classList.remove('indeterminate');
      exportBar.hidden = true;
      exportFill.style.width = '0%';
      btnSave.disabled = false;
    }
  }

  /* ---------------- 顶层渲染 / 步骤切换 ---------------- */
  function renderDots() {
    stepDots.innerHTML = '';
    for (var i = 0; i < 2; i++) {
      var d = document.createElement('span');
      d.className = 'ov-dot' + (i < step ? ' done' : i === step ? ' cur' : '');
      stepDots.appendChild(d);
    }
    wizardTitle.textContent = step === 0 ? '第 1 步 · 框定叠加范围' : '第 2 步 · 微调叠加';
    wizardDesc.textContent = step === 0
      ? '分别为两段音频框定叠加范围：右键光标设定起点与终点，或在波形上拖拽。'
      : '两段范围上下对齐，滑块调整下方音频位置；音量与倍速独立可调。';
    btnBack.hidden = step === 0;
    btnNext.hidden = step === 1;
    btnPlay.textContent = step === 0 ? '▶︎ 播放' : '▶︎ 试听叠加结果';
    stepTip.textContent = step === 0
      ? '播放当前选中的音频；空格键播放/停止'
      : '空格键试听/停止，试听范围为两段对齐区段';
    exportSection.hidden = step !== 1;
  }

  function render() {
    renderDots();
    if (step === 0) renderStep1();
    else renderStep2();
  }

  /* ---------------- 主界面交接 ---------------- */
  window.OverlayStudio = {
    loadTracks: function (arr, ids) {
      stopPreview();
      stopCardPlay();
      segs = (arr || []).map(function (c) {
        return {
          name: c.name,
          buffer: c.buffer,
          bpm: (typeof window.detectBPM === 'function' ? window.detectBPM(c.buffer) : null),
          range: null,
          rec: null,
          cursor: 0
        };
      });
      trackIds = ids || [];
      step = 0;
      active = 0;
      order = [0, 1];
      offset = 0;
      rates[0] = 1; rates[1] = 1;
      vols[0] = 1; vols[1] = 1;
      dirty = false;
      version++;
      heldAxis = 0;
      previewCache = null;
      previewStartT = null;
      previewRange = null;
      render();
    }
  };

  /* ---------------- 控件事件 ---------------- */
  btnPlay.addEventListener('click', function () {
    if (step === 0) toggleCardPlay();
    else togglePreview();
  });
  btnNext.addEventListener('click', function () {
    if (!segs.every(function (s) { return s.range; })) {
      showToast('请先为两段音频都框定叠加范围');
      return;
    }
    stopCardPlay();
    stopPreview();
    step = 1;
    previewStartT = null;
    previewRange = null;
    render();
  });
  btnBack.addEventListener('click', function () {
    stopPreview();
    stopCardPlay();
    step = 0;
    render();
  });
  btnSave.addEventListener('click', function () { saveOverlay(); });

  document.getElementById('btn-exit-overlay').addEventListener('click', function () {
    if (segs.length && dirty) {
      window.confirmExit(function () {
        stopPreview();
        stopCardPlay();
        window.Studio.backToStudio();
      }, function () {
        saveOverlay(); // 保存并退出
      });
      return;
    }
    stopPreview();
    stopCardPlay();
    window.Studio.backToStudio();
  });

  // 空格：第 1 步播放当前音频；第 2 步试听/停止
  document.addEventListener('keydown', function (e) {
    if (pageOverlay.hidden) return;
    if (e.key !== ' ' && e.code !== 'Space') return;
    if (e.repeat || e.defaultPrevented) return;
    var t = e.target;
    var tag = t && t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && t.type !== 'range')) return;
    e.preventDefault();
    if (step === 0) toggleCardPlay();
    else togglePreview();
  });

  // Esc：关闭右键菜单 / 取消记录中
  document.addEventListener('keydown', function (e) {
    if (pageOverlay.hidden || e.key !== 'Escape') return;
    if (!ctxMenu.hidden) { closeMenu(); return; }
    if (step === 0) {
      var seg = segs[active];
      if (seg && seg.rec != null) {
        seg.rec = null;
        updateCardRange(active);
        showToast('已取消本次自定义');
      }
    }
  });

  // 点击空白（第 2 步控件之外）取消自定义试听范围
  document.addEventListener('click', function (e) {
    if (pageOverlay.hidden || step !== 1) return;
    if (previewRange == null && previewStartT == null) return;
    var t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest('.card, .ov-stepbar, .export, button, input, a, label')) return;
    previewRange = null;
    previewStartT = null;
    stopPreview();
    updateMarkers();
    showToast('已取消自定义试听范围');
  });

  // 窗口尺寸变化：重绘
  window.addEventListener('resize', function () {
    if (pageOverlay.hidden || !segs.length) return;
    if (step === 0) {
      segs.forEach(function (seg, i) {
        drawWave(cardEls[i].canvas, seg.buffer, 0, seg.buffer.duration);
        updateCardPlayhead(i);
        updateCardRange(i);
      });
    } else {
      layoutStep2();
      drawStep2Waves();
    }
  });
})();
