/* ============================================================
 * Remix Studio — 剪辑拼接
 * 多段音频上传 / 排序删除重置 / 逐衔接重叠与淡入淡出 / 完整导出
 * 仅用 Web Audio API，导出复用 Exporter（lamejs / WAV）
 * ============================================================ */
(function () {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // 秒数显示：整数不带小数点，非整数保留 1 位（4 → "4"，3.85 → "3.9"）
  function fmtSec(s) { return String(+(s.toFixed(1))); }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

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

  /* ---------------- DOM 引用 ---------------- */
  const pageSplice = document.getElementById('page-splice');
  const filesCard = document.getElementById('splice-files-card');
  const fileList = document.getElementById('splice-file-list');
  const editor = document.getElementById('splice-editor');
  const timeline = document.getElementById('splice-timeline');
  const bar1 = document.getElementById('splice-bar-1');
  const bar2 = document.getElementById('splice-bar-2');
  const wave1 = document.getElementById('splice-wave-1');
  const wave2 = document.getElementById('splice-wave-2');
  const band = document.getElementById('splice-band');
  const handle = document.getElementById('splice-handle');
  const tag1 = document.getElementById('splice-tag-1');
  const tag2 = document.getElementById('splice-tag-2');
  const overlapInput = document.getElementById('splice-overlap');
  const overlapVal = document.getElementById('splice-overlap-val');
  if (window.attachValueEditor) attachValueEditor(overlapVal, overlapInput); // 重叠时长点击输入
  const fadeInput = document.getElementById('splice-fade');
  const xfadeStrip = document.getElementById('splice-fade-strip');
  const hintEl = document.getElementById('splice-hint');
  const btnPreview = document.getElementById('btn-splice-preview');
  const btnBpmAlign = document.getElementById('btn-bpm-align');
  const bpmStatus = document.getElementById('bpm-align-status');
  const exportSection = document.getElementById('splice-export-section');
  const btnSave = document.getElementById('btn-splice-save');
  const exportBar = document.getElementById('splice-export-bar');
  const exportFill = document.getElementById('splice-export-fill');
  const exportStatus = document.getElementById('splice-export-status');
  const toast = document.getElementById('toast');

  /* ---------------- 状态 ---------------- */
  const MAX_TRACKS = 12;    // 段数上限（防止内存耗尽）
  const WINDOW = 10;        // 衔接编辑器显示的窗口长度（秒）
  const AXIS = WINDOW * 2;  // 时间轴总长固定 20s：左半 = 前一段结尾，右半 = 后一段开头
  const tracks = [];        // 全部段落 { name, buffer, bpm, rate, fromTemp }，顺序即拼接顺序
  const junctions = [];     // junctions[i] = 第 i+1 段与第 i+2 段之间的衔接设置 { overlap, fade }
  let activeJunction = 0;   // 衔接设置画面当前编辑的衔接序号（0 = 第1、2段之间）
  let overlap = 0;          // 当前激活衔接的重叠时长（秒）
  let xfadeEls = null;      // 交叉淡化长条（绑定 junctions[activeJunction]）
  let audioCtx = null;
  let dragIndex = -1;
  let spliceDirty = false; // 是否做过调整（决定退出时是否询问）

  function ensureCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  /* ---------------- Toast ---------------- */
  let toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 1800);
  }

  /* ---------------- 从主界面接收两段音频 ---------------- */
  let sourceIds = [];
  function loadTracks(arr, ids) {
    stopPreview();
    tracksVersion++;
    bpmAlignMode = false;
    stopArrowRepeat();
    previewStartT = null;
    previewRange = null;
    previewCache = null;
    activeJunction = 0;
    overlap = 0;
    junctions.length = 0;
    tracks.length = 0;
    sourceIds = ids || [];
    spliceDirty = false; // 新会话：无操作
    overlapInput.disabled = false;
    overlapInput.value = '0';
    fadeInput.checked = true;
    exportStatus.textContent = '';
    exportBar.hidden = true;
    exportFill.style.width = '0%';
    (arr || []).forEach(function (c) {
      tracks.push({ name: c.name, buffer: c.buffer, bpm: (typeof window.detectBPM === 'function' ? window.detectBPM(c.buffer) : null), rate: 1, userRate: 1, alignRate: 1, volume: 1 });
    });
    tracksVersion++;
    render();
  }

  /* ---------------- 段落列表：删除 / 重置 / 拖拽换序 / 衔接设置按钮 ---------------- */
  function removeTrack(i) {
    stopPreview();
    tracksVersion++;
    bpmAlignMode = false;
    stopArrowRepeat();
    previewStartT = null;
    previewRange = null;
    previewCache = null;
    tracks.splice(i, 1);
    render();
  }

  function resetAll(silent) {
    stopPreview();
    tracksVersion++;
    bpmAlignMode = false;
    stopArrowRepeat();
    previewStartT = null;
    previewRange = null;
    previewCache = null;
    activeJunction = 0;
    overlap = 0;
    junctions.length = 0;
    tracks.length = 0;
    overlapInput.value = '0';
    fadeInput.checked = true;
    exportStatus.textContent = '';
    exportBar.hidden = true;
    exportFill.style.width = '0%';
    render();
    if (!silent) showToast('已清空全部音频，重新开始');
  }

  function render() {
    // 衔接设置数量始终 = 段数 − 1
    while (junctions.length > Math.max(0, tracks.length - 1)) junctions.pop();
    while (junctions.length < Math.max(0, tracks.length - 1)) junctions.push({ overlap: 0, fade: true, fadeOutSec: 5, fadeInSec: 5 });
    if (activeJunction > junctions.length - 1) activeJunction = Math.max(0, junctions.length - 1);

    fileList.innerHTML = '';
    tracks.forEach(function (t, i) {
      const item = document.createElement('div');
      item.className = 'splice-file-item';
      item.draggable = true;
      item.innerHTML =
        '<span class="splice-file-order">' + (i + 1) + '</span>' +
        '<span class="splice-file-name" title="' + esc(t.name) + '">' + esc(t.name) + '</span>' +
        '<span class="splice-file-bpm">' + bpmText(t) + '</span>' +
        '<span class="splice-file-dur">' + formatTime(t.buffer.duration) + '</span>' +
        '<button class="splice-file-del" type="button" title="删除该段">✕</button>' +
        '<span class="splice-file-grip" title="拖动换序">⠿</span>';

      item.querySelector('.splice-file-del').addEventListener('click', function () { removeTrack(i); });

      // 拖拽换序（交换两段位置）
      item.addEventListener('dragstart', function (e) {
        dragIndex = i;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(i)); } catch (err) {}
      });
      item.addEventListener('dragend', function () {
        dragIndex = -1;
        item.classList.remove('dragging');
        clearDragover();
      });
      item.addEventListener('dragover', function (e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (dragIndex !== -1 && dragIndex !== i) item.classList.add('dragover');
      });
      item.addEventListener('dragleave', function () { item.classList.remove('dragover'); });
      item.addEventListener('drop', function (e) {
        e.preventDefault();
        item.classList.remove('dragover');
        if (dragIndex !== -1 && dragIndex !== i) {
          const moved = tracks.splice(dragIndex, 1)[0];
          tracks.splice(i, 0, moved);
          render();
        }
        dragIndex = -1;
      });

      fileList.appendChild(item);

      // 每段独立倍速滑块（最终 rate = 用户倍速 × BPM对齐倍率）
      const rateRow = document.createElement('div');
      rateRow.className = 'splice-rate-row';
      rateRow.innerHTML =
        '<span class="splice-rate-label">倍速</span>' +
        '<input type="range" class="slider splice-rate" min="0.5" max="1.5" step="0.01" value="' + (t.userRate || 1) + '">' +
        '<span class="splice-rate-val">' + (t.userRate || 1).toFixed(2) + 'x</span>';
      fileList.appendChild(rateRow);
      (function (input, row, tk, itemEl) {
        input.addEventListener('input', function () {
          const v = clamp(parseFloat(input.value) || 1, 0.5, 1.5);
          tk.userRate = v;
          tk.rate = (tk.userRate || 1) * (tk.alignRate || 1);
          row.querySelector('.splice-rate-val').textContent = v.toFixed(2) + 'x';
          const bpmEl = itemEl.querySelector('.splice-file-bpm');
          if (bpmEl) bpmEl.textContent = bpmText(tk);
          spliceDirty = true;
          updateBpmAlignUI(); // 对齐面板的 BPM 状态即时刷新
          schedulePreviewRestart();
        });
      })(rateRow.querySelector('input'), rateRow, t, item);
      if (window.attachValueEditor) attachValueEditor(rateRow.querySelector('.splice-rate-val'), rateRow.querySelector('input'));

      // 每段独立音量滑块（与叠加界面一致：0–200%，默认 100%，整段生效）
      const volRow = document.createElement('div');
      volRow.className = 'splice-rate-row';
      volRow.innerHTML =
        '<span class="splice-rate-label">音量</span>' +
        '<input type="range" class="slider splice-vol" min="0" max="2" step="0.01" value="' + (t.volume != null ? t.volume : 1) + '">' +
        '<span class="splice-vol-val">' + Math.round((t.volume != null ? t.volume : 1) * 100) + '%</span>';
      fileList.appendChild(volRow);
      if (window.attachValueEditor) attachValueEditor(volRow.querySelector('.splice-vol-val'), volRow.querySelector('input'));
      (function (input, row, tk) {
        input.addEventListener('input', function () {
          const v = clamp(parseFloat(input.value) || 0, 0, 2);
          tk.volume = v;
          row.querySelector('.splice-vol-val').textContent = Math.round(v * 100) + '%';
          spliceDirty = true;
          schedulePreviewRestart(); // 试听播放的就是渲染混音 → 音量实时反映
        });
      })(volRow.querySelector('input'), volRow, t);
    });

    filesCard.hidden = tracks.length === 0;
    editor.hidden = tracks.length < 2;
    exportSection.hidden = tracks.length === 0;
    btnSave.disabled = tracks.length < 2;

    if (tracks.length >= 2) {
      const jn = junctions[activeJunction];
      overlap = clamp(jn.overlap, 0, maxOverlap());
      jn.overlap = overlap;
      fadeInput.checked = jn.fade !== false;
      if (xfadeEls) xfadeEls.refresh(); // 长条跟随当前衔接的时长设置
      const w1 = Math.min(WINDOW, tracks[activeJunction].buffer.duration);
      const w2 = Math.min(WINDOW, tracks[activeJunction + 1].buffer.duration);
      tag1.textContent = '第 ' + (activeJunction + 1) + ' 段 · 结尾 ' + fmtSec(w1) + 's';
      tag2.textContent = '第 ' + (activeJunction + 2) + ' 段 · 开头 ' + fmtSec(w2) + 's';
      overlapInput.max = String(maxOverlap()); // 滑块上限跟随实际可重叠时长
      layoutTimeline();
      drawWaves();
      updateReadout();
      updateBpmAlignUI();
    } else {
      bpmAlignMode = false;
      overlapInput.disabled = false;
    }
  }

  function clearDragover() {
    const items = fileList.querySelectorAll('.splice-file-item');
    for (const el of items) el.classList.remove('dragover');
  }

  // 段落旁的实时 BPM（已含全局倍速与 BPM 对齐倍率）
  function bpmText(t) {
    return t.bpm ? Math.round(t.bpm * (t.rate || 1)) + ' BPM' : '-- BPM';
  }

  /* ---------------- 衔接几何 ---------------- */
  function maxOverlap(j) {
    if (j == null) j = activeJunction;
    if (tracks.length < 2 || j < 0 || j >= tracks.length - 1) return 0;
    const d1 = tracks[j].buffer.duration / (tracks[j].rate || 1);
    const d2 = tracks[j + 1].buffer.duration / (tracks[j + 1].rate || 1);
    return Math.min(WINDOW, d1, d2);
  }

  // 输出时间轴上每段起点（考虑重叠与倍速）
  function computeStarts() {
    const starts = [0];
    for (let i = 1; i < tracks.length; i++) {
      const durOut = tracks[i - 1].buffer.duration / (tracks[i - 1].rate || 1);
      const o = junctions[i - 1] ? clamp(junctions[i - 1].overlap, 0, durOut) : 0;
      starts[i] = Math.max(0, starts[i - 1] + durOut - o);
    }
    return starts;
  }

  // 当前激活衔接的窗口几何（输出时间）
  function junctionWindow() {
    const starts = computeStarts();
    const tj = tracks[activeJunction], tk = tracks[activeJunction + 1];
    const rj = tj.rate || 1, rk = tk.rate || 1;
    const w1 = Math.min(WINDOW, tj.buffer.duration);
    const w2 = Math.min(WINDOW, tk.buffer.duration);
    const o = clamp(junctions[activeJunction].overlap, 0, Math.min(w1, w2));
    return {
      w1: w1, w2: w2, o: o, rj: rj, rk: rk,
      winStart: starts[activeJunction] + (tj.buffer.duration - w1) / rj, // 窗口起点（前段结尾10s开始处）
      endJ: starts[activeJunction] + tj.buffer.duration / rj,            // 前段结束（输出时间）
      winEnd: starts[activeJunction + 1] + w2 / rk                       // 窗口终点（后段开头10s结束处）
    };
  }

  // 窗口片段终点在时间轴上的位置（窗口时间 0~20s）
  function windowEndT() {
    if (tracks.length < 2) return AXIS;
    const j = activeJunction;
    const w1 = Math.min(WINDOW, tracks[j].buffer.duration);
    const w2 = Math.min(WINDOW, tracks[j + 1].buffer.duration);
    const o = junctions[j] ? junctions[j].overlap : 0;
    return Math.min(AXIS, w1 - o + w2);
  }

  function layoutTimeline() {
    const W = timeline.clientWidth;
    if (!W || tracks.length < 2) return;
    const w1 = Math.min(WINDOW, tracks[activeJunction].buffer.duration);
    const w2 = Math.min(WINDOW, tracks[activeJunction + 1].buffer.duration);
    const xs = W * (w1 - overlap) / AXIS;
    bar1.style.width = (W * w1 / AXIS) + 'px';
    bar2.style.width = (W * w2 / AXIS) + 'px';
    bar2.style.left = xs + 'px';
    updatePreviewMarkers();
  }

  function drawWaves() {
    if (tracks.length < 2) return;
    const t1 = tracks[activeJunction], t2 = tracks[activeJunction + 1];
    const w1 = Math.min(WINDOW, t1.buffer.duration);
    const w2 = Math.min(WINDOW, t2.buffer.duration);
    drawWave(wave1, t1.buffer, t1.buffer.duration - w1, t1.buffer.duration);
    drawWave(wave2, t2.buffer, 0, w2);
  }

  // 在 canvas 上绘制 [from, to] 秒区间的波形（逐列峰值）
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
      const step = Math.max(1, Math.floor((e - s) / 400)); // 逐列抽样取峰值，避免逐样本扫描
      let peak = 0;
      for (let j = s; j < e; j += step) {
        const v = Math.abs((ch0[j] + ch1[j]) * 0.5);
        if (v > peak) peak = v;
      }
      const h = Math.max(1, peak * (cssH / 2 - 3));
      ctx.fillRect(x, mid - h, 1, h * 2);
    }
  }

  /* ---------------- 重叠时长：拖拽手柄 / 波形 / 滑块 / 方向键 ---------------- */
  function setOverlap(o) {
    overlap = clamp(o, 0, maxOverlap());
    if (junctions[activeJunction]) junctions[activeJunction].overlap = overlap;
    spliceDirty = true;
    layoutTimeline();
    updateReadout();
    schedulePreviewRestart();
  }

  function updateReadout() {
    overlapInput.value = overlap;
    overlapVal.textContent = (bpmAlignMode ? overlap.toFixed(2) : overlap.toFixed(1)) + 's';
    if (tracks.length >= 2) {
      const a = activeJunction + 1, b = activeJunction + 2;
      hintEl.textContent = overlap <= 0.001
        ? '零重叠：第 ' + b + ' 段紧接第 ' + a + ' 段播放。'
        : '第 ' + b + ' 段提前 ' + (bpmAlignMode ? overlap.toFixed(2) : overlap.toFixed(1)) + ' 秒接入，与第 ' + a + ' 段重叠。';
    }
  }

  let rangeDrag = null;

  function xToWindowT(px) {
    return clamp(px / timeline.clientWidth * AXIS, 0, AXIS);
  }

  function showRangeBandPx(aPx, bPx) {
    band.hidden = false;
    band.style.left = aPx + 'px';
    band.style.width = Math.max(0, bPx - aPx) + 'px';
  }

  // 靠近试听光标时按住：拖拽光标（调整试听起点），而不是画范围
  function timelineCursorDragStart() {
    handle.classList.add('near');
    function move(ev) {
      const rect = timeline.getBoundingClientRect();
      const x = clamp(ev.clientX - rect.left, 0, timeline.clientWidth);
      previewRange = null;
      previewStartT = Math.min(xToWindowT(x), windowEndT());
      updatePreviewMarkers();
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
    if (tracks.length < 2) return;
    e.preventDefault();
    const rect = timeline.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, 0, timeline.clientWidth);
    const handleLeft = parseFloat(handle.style.left) || 0;
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
    const rect = timeline.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, 0, timeline.clientWidth);
    if (!rangeDrag.moved && Math.abs(x - rangeDrag.startX) > 4) rangeDrag.moved = true;
    if (rangeDrag.moved) showRangeBandPx(Math.min(rangeDrag.startX, x), Math.max(rangeDrag.startX, x));
  }

  function timelinePointerUp(e) {
    if (!rangeDrag) return;
    const drag = rangeDrag;
    rangeDrag = null;
    window.removeEventListener('pointermove', timelinePointerMove);
    window.removeEventListener('pointerup', timelinePointerUp);
    window.removeEventListener('pointercancel', timelinePointerUp);

    const rect = timeline.getBoundingClientRect();
    const x = (e.clientX != null) ? clamp(e.clientX - rect.left, 0, timeline.clientWidth) : drag.startX;

    if (drag.moved) {
      const a = xToWindowT(Math.min(drag.startX, x));
      const b = xToWindowT(Math.max(drag.startX, x));
      if (b - a >= 0.2) {
        previewRange = { a: a, b: b };
        previewStartT = a; // 光标 = 范围起点
        updatePreviewMarkers();
        stopPreview();
        startPreview();    // 松开即循环试听该范围
        return;
      }
      // 拖动距离过短，按单击处理
    }

    // 单击：设试听起点（限制在窗口片段内），清除自定义范围
    previewRange = null;
    previewStartT = Math.min(xToWindowT(x), windowEndT());
    updatePreviewMarkers();
    schedulePreviewRestart();
  }

  // 光标与范围高亮：光标默认停在两段交界处，自定义后停在设定位置
  function updatePreviewMarkers() {
    const W = timeline.clientWidth;
    if (!W || tracks.length < 2) return;
    const w1 = Math.min(WINDOW, tracks[activeJunction].buffer.duration);
    const cursorT = (previewStartT != null) ? previewStartT : (w1 - overlap);
    handle.style.left = (W * cursorT / AXIS) + 'px';
    if (previewRange) {
      const a = Math.min(previewRange.a, previewRange.b);
      const b = Math.max(previewRange.a, previewRange.b);
      band.hidden = false;
      band.style.left = (W * a / AXIS) + 'px';
      band.style.width = (W * (b - a) / AXIS) + 'px';
    } else {
      band.hidden = true;
    }
  }

  /* ---------------- 试听片段：渲染拼接结果并播放所选范围 ---------------- */
  let previewSrc = null;      // 当前试听音源
  let previewSession = 0;     // 会话号：使渲染期间失效的启动作废
  let restartTimer = null;
  let previewRaf = 0;         // 播放进度光标动画帧
  let playbackInfo = null;    // 进度换算参数
  let previewCache = null;    // { key, buffer }：拼接结果离线渲染缓存
  let previewStartT = null;   // 自定义试听起点（窗口时间 0~20s）；null = 默认（两段交界处）
  let previewRange = null;    // { a, b } 自定义循环范围（窗口时间）；null = 无
  let tracksVersion = 0;      // 曲目/设置变动计数：参与缓存键

  function setPreviewBtn(text) {
    btnPreview.textContent = text;
  }

  function isPreviewPlaying() { return !!previewSrc; }

  function stopPreview() {
    previewSession++;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (previewSrc) {
      const s = previewSrc;
      previewSrc = null;
      try { s.onended = null; } catch (e) {}
      try { s.stop(); } catch (e) {}
      try { s.disconnect(); } catch (e) {}
    }
    if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = 0; }
    playbackInfo = null;
    setPreviewBtn('▶︎ 试听片段');
    updatePreviewMarkers(); // 光标回到起点标记位
  }

  function previewCacheKey() {
    return tracksVersion + '|' + activeJunction + '|' +
      junctions.map(function (j) { return j.overlap + (j.fade ? 'f' : 'n') + (j.fadeOutSec || 0) + '-' + (j.fadeInSec || 0); }).join(',') + '|' +
      tracks.map(function (t) { return (t.volume != null ? t.volume : 1); }).join(',') + '|' +
      tracks.map(function (t) { return t.rate || 1; }).join(',');
  }

  async function getPreviewBuffer(token) {
    const key = previewCacheKey();
    if (previewCache && previewCache.key === key) return previewCache.buffer;
    setPreviewBtn('渲染中…');
    const buffer = await renderOutput();
    if (token !== previewSession) return buffer; // 期间已被停止/重启，不缓存
    if (previewCacheKey() === key) previewCache = { key: key, buffer: buffer };
    return buffer;
  }

  async function startPreview() {
    if (tracks.length < 2) return;
    const ctx = ensureCtx();
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }

    const token = ++previewSession;
    let buffer;
    try {
      buffer = await getPreviewBuffer(token);
    } catch (e) {
      return;
    }
    if (token !== previewSession) return; // 渲染期间被停止/重启

    const geo = junctionWindow();
    const toOut = (t) => (t <= geo.w1 ? geo.winStart + t / geo.rj : geo.endJ + (t - geo.w1) / geo.rk);

    let from, to, loop;
    if (previewRange) {
      from = toOut(Math.min(previewRange.a, previewRange.b));
      to = toOut(Math.max(previewRange.a, previewRange.b));
      loop = true;
    } else if (previewStartT != null) {
      from = toOut(previewStartT);
      to = geo.winEnd;
      loop = false;
    } else {
      from = geo.winStart;
      to = geo.winEnd;
      loop = false;
    }
    if (from >= buffer.duration) from = Math.max(0, buffer.duration - 0.05);
    if (to - from < 0.05) to = Math.min(buffer.duration, from + 0.05);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (loop) { src.loop = true; src.loopStart = from; src.loopEnd = to; }
    src.connect(ctx.destination);
    const t0 = ctx.currentTime + 0.05;
    src.start(t0, from);
    if (!loop) src.stop(t0 + (to - from));

    previewSrc = src;
    playbackInfo = {
      ctx: ctx, t0: t0, from: from, to: to, loop: loop,
      winStart: geo.winStart, endJ: geo.endJ, w1: geo.w1, rj: geo.rj, rk: geo.rk
    };
    setPreviewBtn('⏹︎ 停止试听');
    cancelAnimationFrame(previewRaf);
    previewRaf = requestAnimationFrame(updatePlayhead);
    src.onended = function () {
      if (token !== previewSession || previewSrc !== src) return;
      previewSrc = null;
      playbackInfo = null;
      if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = 0; }
      setPreviewBtn('▶︎ 试听片段');
      updatePreviewMarkers(); // 光标回到起点标记位
    };
  }

  function togglePreview() {
    if (isPreviewPlaying()) stopPreview();
    else startPreview();
  }

  // 重叠/淡入淡出/范围变化时自动重播（防抖，避免拖动过程中频繁重启）
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

  // 试听时光标作为进度指示随之移动；循环到结尾瞬间跳回开头
  function updatePlayhead() {
    if (!playbackInfo || !previewSrc) { previewRaf = 0; return; }
    const info = playbackInfo;
    const elapsed = Math.max(0, info.ctx.currentTime - info.t0);
    let pos = info.from + elapsed;
    if (info.loop && pos > info.to) {
      pos = info.from + ((pos - info.from) % Math.max(0.001, info.to - info.from));
    }
    pos = Math.min(pos, info.to);
    const W = timeline.clientWidth;
    if (W) {
      let t;
      if (pos <= info.endJ) t = (pos - info.winStart) * info.rj;
      else t = info.w1 + (pos - info.endJ) * info.rk;
      t = clamp(t, 0, AXIS);
      handle.style.left = (W * t / AXIS) + 'px';
    }
    previewRaf = requestAnimationFrame(updatePlayhead);
  }

  /* ---------------- 时间轴手势：单击设起点，按住拖动画循环范围 ---------------- */
  // 靠近试听光标时按住：拖拽光标（调整试听起点），而不是画范围
  function timelineCursorDragStart() {
    handle.classList.add('near');
    function move(ev) {
      const rect = timeline.getBoundingClientRect();
      const x = clamp(ev.clientX - rect.left, 0, timeline.clientWidth);
      previewRange = null;
      previewStartT = Math.min(xToWindowT(x), windowEndT());
      updatePreviewMarkers();
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
    if (tracks.length < 2) return;
    e.preventDefault();
    const rect = timeline.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, 0, timeline.clientWidth);
    const handleLeft = parseFloat(handle.style.left) || 0;
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
    const rect = timeline.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, 0, timeline.clientWidth);
    if (!rangeDrag.moved && Math.abs(x - rangeDrag.startX) > 4) rangeDrag.moved = true;
    if (rangeDrag.moved) showRangeBandPx(Math.min(rangeDrag.startX, x), Math.max(rangeDrag.startX, x));
  }

  function timelinePointerUp(e) {
    if (!rangeDrag) return;
    const drag = rangeDrag;
    rangeDrag = null;
    window.removeEventListener('pointermove', timelinePointerMove);
    window.removeEventListener('pointerup', timelinePointerUp);
    window.removeEventListener('pointercancel', timelinePointerUp);

    const rect = timeline.getBoundingClientRect();
    const x = (e.clientX != null) ? clamp(e.clientX - rect.left, 0, timeline.clientWidth) : drag.startX;

    if (drag.moved) {
      const a = xToWindowT(Math.min(drag.startX, x));
      const b = xToWindowT(Math.max(drag.startX, x));
      if (b - a >= 0.2) {
        previewRange = { a: a, b: b };
        previewStartT = a; // 光标 = 范围起点
        updatePreviewMarkers();
        stopPreview();
        startPreview();    // 松开即循环试听该范围
        return;
      }
      // 拖动距离过短，按单击处理
    }

    // 单击：设试听起点（限制在窗口片段内），清除自定义范围
    previewRange = null;
    previewStartT = Math.min(xToWindowT(x), windowEndT());
    updatePreviewMarkers();
    schedulePreviewRestart();
  }

  // 光标与范围高亮：光标默认停在两段交界处，自定义后停在设定位置
  function updatePreviewMarkers() {
    const W = timeline.clientWidth;
    if (!W || tracks.length < 2) return;
    const w1 = Math.min(WINDOW, tracks[activeJunction].buffer.duration);
    const cursorT = (previewStartT != null) ? previewStartT : (w1 - overlap);
    handle.style.left = (W * cursorT / AXIS) + 'px';
    if (previewRange) {
      const a = Math.min(previewRange.a, previewRange.b);
      const b = Math.max(previewRange.a, previewRange.b);
      band.hidden = false;
      band.style.left = (W * a / AXIS) + 'px';
      band.style.width = (W * (b - a) / AXIS) + 'px';
    } else {
      band.hidden = true;
    }
  }

  /* ---------------- 自动对齐 BPM（按当前激活衔接） ---------------- */
  let bpmAlignMode = false;
  let alignBPM = null;     // 对齐基准 BPM（取前一段的等效 BPM）
  let arrowRepeat = null;

  function stopArrowRepeat() {
    if (arrowRepeat) {
      clearTimeout(arrowRepeat.timer);
      clearInterval(arrowRepeat.interval);
      arrowRepeat = null;
    }
  }

  function updateBpmAlignUI() {
    const tj = tracks[activeJunction], tk = tracks[activeJunction + 1];
    const e1 = tj && tj.bpm ? tj.bpm * (tj.rate || 1) : null;
    const e2 = tk && tk.bpm ? tk.bpm * (tk.rate || 1) : null;
    overlapInput.disabled = bpmAlignMode;

    if (e1 == null || e2 == null) {
      bpmAlignMode = false;
      overlapInput.disabled = false;
      btnBpmAlign.disabled = true;
      btnBpmAlign.classList.remove('bpm-active');
      bpmStatus.textContent = '未检测到两段音频的 BPM，无法自动对齐';
      return;
    }

    // 把后一段等效 BPM 折算到前一段的倍频附近（×2 / ÷2，如 179 → 89.5）
    let b = e2;
    while (b < e1 * 0.7) b *= 2;
    while (b > e1 * 1.4) b /= 2;
    const diff = Math.abs(b - e1);

    if (diff > 3) {
      bpmAlignMode = false;
      overlapInput.disabled = false;
      btnBpmAlign.disabled = true;
      btnBpmAlign.classList.remove('bpm-active');
      bpmStatus.textContent = '无法自动对齐：两段 BPM ' + (+(e1.toFixed(1))) + ' 与 ' + (+(e2.toFixed(1))) + (b !== e2 ? '（折算 ' + (+(b.toFixed(1))) + '）' : '') + ' 相差 ' + (+(diff.toFixed(1))) + '，超过 3';
      return;
    }

    alignBPM = e1;
    btnBpmAlign.disabled = false;
    if (bpmAlignMode) {
      btnBpmAlign.classList.add('bpm-active');
      bpmStatus.textContent = '对齐模式：← → 调整重叠（半拍 ' + (+(30 / e1).toFixed(3)) + 's/步，可长按加速）' +
        (Math.abs((tk.rate || 1) - 1) > 0.001 ? '，第 ' + (activeJunction + 2) + ' 段倍速 ×' + (+(tk.rate.toFixed(4))) : '') + '；再点按钮退出';
    } else {
      btnBpmAlign.classList.remove('bpm-active');
      bpmStatus.textContent = (diff < 0.5 ? '两段 BPM 相同（' + (+(e1.toFixed(1))) + '）' : 'BPM ' + (+(e1.toFixed(1))) + ' 与 ' + (+(e2.toFixed(1))) + (b !== e2 ? '（×2 关系，折算 ' + (+(b.toFixed(1))) + '）' : '') + ' 相差 ' + (+(diff.toFixed(1)))) + '，点击开启后用 ← → 调整重叠';
    }
  }

  // 半拍步长：BPM 对齐需要落在节拍间隔上，而非平滑微调
  function stepOverlap(dir) {
    const step = Math.max(0.05, 30 / alignBPM);
    const quant = Math.round(overlap / step) + dir;
    setOverlap(+(quant * step).toFixed(3));
  }

  function startArrowRepeat(dir) {
    stepOverlap(dir);
    stopArrowRepeat();
    arrowRepeat = {};
    arrowRepeat.timer = setTimeout(function () {
      arrowRepeat.interval = setInterval(function () { stepOverlap(dir); }, 120);
    }, 400);
  }

  document.addEventListener('keydown', function (e) {
    if (!bpmAlignMode || pageSplice.hidden || tracks.length < 2) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && !t.disabled))) return;
    e.preventDefault();
    if (e.repeat) return; // 长按节奏自行控制
    startArrowRepeat(e.key === 'ArrowRight' ? 1 : -1);
  });
  document.addEventListener('keyup', function (e) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') stopArrowRepeat();
  });
  window.addEventListener('blur', stopArrowRepeat);

  btnBpmAlign.addEventListener('click', function () {
    if (btnBpmAlign.disabled) return;
    bpmAlignMode = !bpmAlignMode;
    stopArrowRepeat();
    if (bpmAlignMode) {
      // 进入模式即内部调节后一段倍速，使两段有效 BPM 相同
      const tj = tracks[activeJunction], tk = tracks[activeJunction + 1];
      const e1 = tj.bpm * (tj.rate || 1);
      const e2 = tk.bpm * (tk.rate || 1);
      let b = e2;
      while (b < e1 * 0.7) b *= 2;
      while (b > e1 * 1.4) b /= 2;
      const M = e1 / b;
      if (Math.abs(M - 1) > 0.001) {
        tk.alignRate = (tk.alignRate || 1) * M;
        tk.rate = (tk.userRate || 1) * tk.alignRate;
      }
      spliceDirty = true;
      showToast('自动对齐 BPM 已开启：← → 调整重叠时长');
    } else {
      showToast('已退出自动对齐 BPM（已应用的倍速保留）');
    }
    updateBpmAlignUI();
    render(); // 刷新段落 BPM 标签
    if (isPreviewPlaying()) schedulePreviewRestart(); // 倍速变化后重播
  });

  /* ---------------- 导出：完整链式拼接渲染 + 编码下载 ---------------- */
  const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

  // 抛物线包络曲线：isIn = 淡入（0→1），否则淡出（1→0），与长条图形一致
  function makeParabola(dur, isIn) {
    const N2 = 128;
    const curve = new Float32Array(N2);
    for (let k = 0; k < N2; k++) {
      const x = k / (N2 - 1);
      curve[k] = isIn ? (1 - (1 - x) * (1 - x)) : (1 - x * x);
    }
    return curve;
  }

  async function renderOutput() {
    let rendered;
    if (tracks.length === 1) {
      rendered = tracks[0].buffer;
    } else {
      const sr = MP3_RATES.indexOf(tracks[0].buffer.sampleRate) !== -1 ? tracks[0].buffer.sampleRate : 48000;
    const starts = computeStarts();
    const durOut = tracks.map(function (t) { return t.buffer.duration / (t.rate || 1); });
    const total = starts[starts.length - 1] + durOut[durOut.length - 1];
    const len = Math.max(1, Math.ceil(total * sr));
    const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offline = new Ctor(2, len, sr);

    const N = tracks.length;
    const gainNodes = [];
    tracks.forEach(function (t, i) {
      const src = offline.createBufferSource();
      src.buffer = t.buffer;
      src.playbackRate.value = t.rate || 1;
      const g = offline.createGain();
      g.gain.value = (t.volume != null) ? t.volume : 1; // 每段音量（0–200%）
      src.connect(g); g.connect(offline.destination);
      src.start(starts[i]);
      gainNodes.push(g);
    });

    // 淡入淡出：第一段末尾淡出 + 第二段开头淡入（时长用户可调，抛物线包络，不依赖重叠区）
    // 包络值乘以该段音量（setValueCurveAtTime 会整体接管增益，音量必须烘进曲线）
    // headUsed 记录每段开头已被淡入占用的秒数，防止同一增益上的曲线区间重叠
    const headUsed = new Array(N).fill(0);
    junctions.forEach(function (jn, i) {
      if (!jn.fade) return;
      const fo = Math.min(jn.fadeOutSec || 0, durOut[i], durOut[i] - headUsed[i]);
      const fi = Math.min(jn.fadeInSec || 0, durOut[i + 1]);
      if (fo > 0.05) {
        const c = makeParabola(fo, false);
        const volI = (tracks[i].volume != null) ? tracks[i].volume : 1;
        for (let k = 0; k < c.length; k++) c[k] *= volI;
        gainNodes[i].gain.setValueCurveAtTime(c, starts[i] + durOut[i] - fo, fo);
      }
      if (fi > 0.05) {
        const c = makeParabola(fi, true);
        const volJ = (tracks[i + 1].volume != null) ? tracks[i + 1].volume : 1;
        for (let k = 0; k < c.length; k++) c[k] *= volJ;
        gainNodes[i + 1].gain.setValueCurveAtTime(c, starts[i + 1], fi);
        headUsed[i + 1] = fi;
      }
    });
    rendered = await offline.startRendering();
    }
    return rendered;
  }

  async function saveSplice() {
    if (tracks.length < 2) return;
    stopPreview();
    btnSave.disabled = true;
    exportBar.hidden = false;
    exportFill.style.width = '0%';
    exportStatus.textContent = '正在渲染…';
    exportBar.classList.add('indeterminate'); // 渲染阶段无进度事件 → 流光
    try {
      await new Promise(function (r) { setTimeout(r, 30); });
      const rendered = await renderOutput();
      const name = tracks.map(function (t) { return stripExt(t.name); }).join('+') + '_拼接';
      exportBar.classList.remove('indeterminate');
      exportFill.style.width = '100%';
      exportBar.hidden = true;
      window.openSaveChoice(rendered, name, sourceIds); // 询问替换/保留原音频
    } catch (e) {
      console.error(e);
      exportStatus.textContent = '保存失败：' + (e && e.message ? e.message : e);
    } finally {
      exportBar.classList.remove('indeterminate');
      exportBar.hidden = true;
      exportFill.style.width = '0%';
      btnSave.disabled = tracks.length < 2;
    }
  }

  btnSave.addEventListener('click', function () { saveSplice(); });

  /* ---------------- 供主界面交接 ---------------- */
  window.SpliceStudio = {
    hasTracks: function () { return tracks.length > 0; },
    resetAll: resetAll,
    loadTracks: loadTracks
  };

  /* ---------------- 初始化 ---------------- */
  buildXfadeStrip();
  btnPreview.addEventListener('click', togglePreview);
  timeline.addEventListener('pointerdown', timelinePointerDown);

  // 悬停靠近试听光标 → 光标变粗提示可拖拽
  timeline.addEventListener('pointermove', function (e) {
    if (rangeDrag) return;
    const rect = timeline.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, 0, timeline.clientWidth);
    const handleLeft = parseFloat(handle.style.left) || 0;
    handle.classList.toggle('near', Math.abs(x - handleLeft) <= 8);
  });
  timeline.addEventListener('pointerleave', function () { handle.classList.remove('near'); });

  // 点击拼接页空白处（时间轴/按钮/滑块等控件之外）取消自定义试听范围
  document.addEventListener('click', function (e) {
    if (pageSplice.hidden || tracks.length < 2) return;
    if (previewRange == null && previewStartT == null) return; // 没有自定义可取消
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest('#splice-editor, #splice-files-card, #splice-upload, #splice-export-section, button, input, a, label')) return;
    previewRange = null;
    previewStartT = null;
    stopPreview();
    updatePreviewMarkers();
    showToast('已取消自定义试听范围');
  });

  overlapInput.addEventListener('input', function () {
    setOverlap(parseFloat(overlapInput.value) || 0);
  });
  fadeInput.addEventListener('change', function () {
    if (junctions[activeJunction]) junctions[activeJunction].fade = fadeInput.checked;
    spliceDirty = true;
    if (xfadeEls) xfadeEls.refresh();
    schedulePreviewRestart(); // 试听中切换淡入淡出，自动重播
  });

  /* ---------------- 交叉淡化长条：两圆点从中点（衔接点）出发，左 = 前段末尾淡出，右 = 后段开头淡入，各 0–10s ---------------- */
  function buildXfadeStrip() {
    xfadeStrip.innerHTML = '';
    const bar = document.createElement('div');
    bar.className = 'fade-bar fade-bar-curve';
    bar.innerHTML =
      '<canvas class="fade-curve"></canvas>' +
      '<div class="fade-bar-mid"></div>' +
      '<div class="fade-knob fade-knob-out" title="第一段末尾淡出：从中间向左拖动（0–10 秒）"></div>' +
      '<div class="fade-knob fade-knob-in" title="第二段开头淡入：从中间向右拖动（0–10 秒）"></div>';
    const labels = document.createElement('div');
    labels.className = 'fade-bar-labels';
    labels.innerHTML =
      '<span class="fade-label-in"></span>' +
      '<span class="fade-label-out"></span>';
    const note = document.createElement('p');
    note.className = 'fade-bar-note';
    note.textContent = '时长范围 0–10 秒，曲线为音量包络';
    xfadeStrip.appendChild(bar);
    xfadeStrip.appendChild(labels);
    xfadeStrip.appendChild(note);
    const canvas = bar.querySelector('.fade-curve');
    const knobL = bar.querySelector('.fade-knob-out');
    const knobR = bar.querySelector('.fade-knob-in');
    const labelL = labels.querySelector('.fade-label-in');
    const labelR = labels.querySelector('.fade-label-out');

    // 视图秒（0–20，10 = 衔接点）→ 音量包络：左半 = 前段淡出抛物线，右半 = 后段淡入抛物线
    function envAt(t, fo, fi) {
      if (t <= 10) {
        const start = 10 - fo;
        if (fo <= 0 || t <= start) return 1;
        const x = (t - start) / fo;
        return 1 - x * x;
      }
      if (fi <= 0 || t >= 10 + fi) return 1;
      const x = (t - 10) / fi;
      return 1 - (1 - x) * (1 - x);
    }

    function drawCurve() {
      const dpr = window.devicePixelRatio || 1;
      const W = bar.clientWidth;
      const H = bar.clientHeight;
      if (!W || !H) return;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const jn = junctions[activeJunction];
      if (!jn) return;
      const fo = clamp(jn.fadeOutSec || 0, 0, 10);
      const fi = clamp(jn.fadeInSec || 0, 0, 10);
      const pad = 4;
      const yOf = function (v) { return pad + (1 - v) * (H - pad * 2); };
      // 曲线下方渐隐填充
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = '#9adcff';
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let px = 0; px <= W; px += 2) ctx.lineTo(px, yOf(envAt(px / W * 20, fo, fi)));
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      // 包络曲线：左半（前段淡出）青色，右半（后段淡入）橙色
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(120, 220, 255, 0.95)';
      ctx.beginPath();
      for (let px = 0; px <= W / 2; px += 2) {
        const y = yOf(envAt(px / W * 20, fo, fi));
        if (px === 0) ctx.moveTo(px, y); else ctx.lineTo(px, y);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 182, 77, 0.95)';
      ctx.beginPath();
      for (let px = W / 2; px <= W; px += 2) {
        const y = yOf(envAt(px / W * 20, fo, fi));
        if (px === W / 2) ctx.moveTo(px, y); else ctx.lineTo(px, y);
      }
      ctx.stroke();
    }

    function refresh() {
      const jn = junctions[activeJunction];
      if (!jn) return;
      xfadeStrip.hidden = !jn.fade;
      knobL.style.left = ((10 - clamp(jn.fadeOutSec || 0, 0, 10)) / 20 * 100) + '%';
      knobR.style.left = ((10 + clamp(jn.fadeInSec || 0, 0, 10)) / 20 * 100) + '%';
      labelL.textContent = '前段淡出 ' + (jn.fadeOutSec || 0).toFixed(1) + 's';
      labelR.textContent = '后段淡入 ' + (jn.fadeInSec || 0).toFixed(1) + 's';
      drawCurve();
    }
    function drag(knob, isLeft) {
      knob.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        try { knob.setPointerCapture(e.pointerId); } catch (err) {}
        const rect = bar.getBoundingClientRect();
        function move(ev) {
          const jn = junctions[activeJunction];
          if (!jn) return;
          const viewT = clamp((ev.clientX - rect.left) / rect.width * 20, isLeft ? 0 : 10, isLeft ? 10 : 20);
          if (isLeft) jn.fadeOutSec = +(10 - viewT).toFixed(2);  // 中点 = 0，越往左越长
          else jn.fadeInSec = +(viewT - 10).toFixed(2);          // 中点 = 0，越往右越长
          refresh();
          spliceDirty = true;
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
      });
    }
    drag(knobL, true);
    drag(knobR, false);
    refresh();
    xfadeEls = { refresh: refresh };
  }

  window.addEventListener('resize', function () {
    if (tracks.length >= 2 && !pageSplice.hidden) {
      layoutTimeline();
      drawWaves();
    }
  });

  document.getElementById('btn-exit-splice').addEventListener('click', function () {
    if (tracks.length > 0 && spliceDirty) {
      window.confirmExit(function () {
        stopPreview();
        window.Studio.backToStudio();
      }, function () {
        saveSplice(); // 保存并退出
      });
      return;
    }
    stopPreview();
    window.Studio.backToStudio();
  });
  render();
})();
