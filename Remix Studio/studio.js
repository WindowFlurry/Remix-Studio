/* ============================================================
 * Remix Studio — 多轨编辑器主界面（Audacity 风格）
 * 导入多音频 / 波形显示与水平缩放 / 播放光标 / 选中多选 /
 * 拖拽选区剪辑 / 蒙版·拼接·叠加子界面入口 / 混音导出
 * ============================================================ */
(function () {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function stripExt(name) { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(0, i) : name; }
  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  /* ---------------- DOM ---------------- */
  const studio = document.getElementById('studio');
  const pageMask = document.getElementById('page-mask');
  const pageSplice = document.getElementById('page-splice');
  const pageOverlay = document.getElementById('page-overlay');
  const tracksWrap = document.getElementById('studio-tracks-wrap');
  const tracksContainer = document.getElementById('tracks-container');
  const playheadLayer = document.getElementById('playhead-layer');
  const fileInput = document.getElementById('studio-file-input');
  const btnImport = document.getElementById('btn-studio-import');
  const importStatus = document.getElementById('studio-import-status');
  const importBar = document.getElementById('import-bar');
  const importBarFill = importBar ? importBar.querySelector('i') : null;
  const studioEmpty = document.getElementById('studio-empty');
  const toolbar = document.getElementById('studio-toolbar');
  const btnToolMask = document.getElementById('btn-tool-mask');
  const btnToolSplice = document.getElementById('btn-tool-splice');
  const btnToolOverlay = document.getElementById('btn-tool-overlay');
  const btnToolDelete = document.getElementById('btn-tool-delete');
  const btnToolHide = document.getElementById('btn-tool-hide');
  const btnToolbarReplay = document.getElementById('btn-toolbar-replay');
  const btnMoveUp = document.getElementById('btn-move-up');
  const btnMoveDown = document.getElementById('btn-move-down');
  const filterBoxes = Array.prototype.slice.call(document.querySelectorAll('#hide-filter-group input[type="checkbox"]'));
  const btnFitWindow = document.getElementById('btn-fit-window');
  const btnFitAlign = document.getElementById('btn-fit-align');
  const btnSelectAll = document.getElementById('btn-select-all');
  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');
  const deleteModal = document.getElementById('delete-modal');
  const deleteModalTitle = document.getElementById('delete-modal-title');
  const btnDelCancel = document.getElementById('btn-del-cancel');
  const btnDelConfirm = document.getElementById('btn-del-confirm');
  const selectBar = document.getElementById('studio-select-bar');
  const selectHint = document.getElementById('studio-select-hint');
  const btnSelectCancel = document.getElementById('btn-select-cancel');
  const btnSelectConfirm = document.getElementById('btn-select-confirm');
  const btnPlay = document.getElementById('btn-studio-play');
  const btnBack5 = document.getElementById('btn-back-5');
  const btnFwd5 = document.getElementById('btn-fwd-5');
  const btnBack30 = document.getElementById('btn-back-30');
  const btnFwd30 = document.getElementById('btn-fwd-30');
  const btnSpeed1 = document.getElementById('btn-speed-1');
  const btnSpeed2 = document.getElementById('btn-speed-2');
  const btnSpeed3 = document.getElementById('btn-speed-3');
  const playControls = document.getElementById('studio-controls');
  const btnExport = document.getElementById('btn-studio-export');
  const exportStatus = document.getElementById('studio-export-status');
  const exportOverlay = document.getElementById('export-overlay');
  const exportOverlayStatus = document.getElementById('export-status');
  const exportOverlayFill = document.getElementById('export-fill');
  const exportOverlayBar = exportOverlay ? exportOverlay.querySelector('.overlay-bar') : null;
  const toast = document.getElementById('toast');

  /* ---------------- 状态 ---------------- */
  const tracks = [];       // { id, name, buffer, selected }
  let nextId = 1;
  let pxPerSec = null;     // 水平缩放：每秒像素（null=初始自适应视口）
  const MIN_PPS = 0.5, MAX_PPS = 2000;
  const LABEL_W = 160;     // 左侧信息栏宽度（px）
  const MAX_CANVAS_W = 30000; // canvas 最大宽度（避免超出浏览器上限）

  let audioCtx = null;
  let playSources = [];
  let playStartCtx = 0;
  let isPlaying = false;
  let playRaf = 0;
  let playingDuration = 0;

  // 选区（剪辑）：{ ids: [轨道id...], from, to }，from/to 为全局时间轴秒
  let selection = null;
  let selectionDrag = null;
  let selectionEls = [];
  let cursorT = 0;         // 全局播放位置（秒）
  let cursorInfo = [];     // [{ el, pps, scroll, track }]：当前光标元素与各自缩放/滚动偏移
  let hideFilter = 'all';  // 显示过滤：'all' | 'unhidden' | 'hidden'（隐藏功能，三选一）
  let playingIds = [];     // 当前正在播放的轨道 id：从头播放时保持同一批音频不换

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

  function maxDuration() {
    let m = 0;
    visibleTracks().forEach(function (t) { if (t.buffer.duration > m) m = t.buffer.duration; });
    return m;
  }

  // 轨道有效缩放：t.pps 为该轨独立缩放（ctrl+滚轮/适应当前窗口只作用于选中轨），null = 跟随全局
  function trackPps(t) { return t.pps != null ? t.pps : pxPerSec; }

  // 该轨波形水平偏移的应用与上限
  function applyTrackScroll(t) {
    const row = tracksContainer.querySelector('.track-row[data-id="' + t.id + '"]');
    if (!row) return;
    const canvas = row.querySelector('.track-canvas');
    canvas.style.transform = 'translateX(' + (-(t.scrollPx || 0)) + 'px)';
  }

  function maxScrollFor(t) {
    const row = tracksContainer.querySelector('.track-row[data-id="' + t.id + '"]');
    if (!row) return 0;
    const canvasW = parseFloat(row.querySelector('.track-canvas').style.width) || 0;
    const waveW = row.querySelector('.track-wave').clientWidth;
    return Math.max(0, canvasW - waveW);
  }

  // 视口占波形宽度的比例（决定拇指长度：放大几倍，拇指就缩短几倍）
  function scrollRatio(row) {
    const canvasW = parseFloat(row.querySelector('.track-canvas').style.width) || 0;
    const waveW = row.querySelector('.track-wave').clientWidth;
    if (canvasW <= 0) return 1;
    return Math.min(1, waveW / canvasW);
  }

  // 同步自绘滚动条：波形未超出视口时铺满并锁定（不可移动）；超出后拇指长度 = 视口/波形
  function syncScrollWidget(t) {
    const row = tracksContainer.querySelector('.track-row[data-id="' + t.id + '"]');
    if (!row) return;
    const bar = row.querySelector('.track-scroll');
    const thumb = bar ? bar.querySelector('.track-scroll-thumb') : null;
    if (!thumb || !bar.clientWidth) return;
    const max = maxScrollFor(t);
    if (max <= 0) {
      bar.classList.add('locked');
      thumb.style.width = '100%';
      thumb.style.left = '0px';
      return;
    }
    bar.classList.remove('locked');
    const barW = bar.clientWidth;
    const thumbW = Math.max(24, Math.round(barW * scrollRatio(row)));
    thumb.style.width = thumbW + 'px';
    thumb.style.left = ((t.scrollPx || 0) / max * (barW - thumbW)) + 'px';
  }

  function selectedTracks() { return tracks.filter(function (t) { return t.selected; }); }

  // 当前视图轨道（隐藏功能过滤）：'all'=全部 / 'unhidden'=未隐藏 / 'hidden'=已隐藏。
  // 隐藏的音频并未删除，只是不默认显示；切换过滤勾选可随时找回
  function visibleTracks() {
    if (hideFilter === 'hidden') return tracks.filter(function (t) { return t.hidden; });
    if (hideFilter === 'unhidden') return tracks.filter(function (t) { return !t.hidden; });
    return tracks.slice();
  }

  /* ---------------- 导入 ---------------- */
  function setupUpload() {
    btnImport.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files.length) handleFiles(fileInput.files);
      fileInput.value = '';
    });
  }

  let importBusy = false;
  async function handleFiles(list) {
    const files = Array.prototype.slice.call(list);
    if (!files.length) return;
    if (importBusy) { showToast('正在导入中，请稍候'); return; }
    importBusy = true;
    importBar.hidden = false;
    importBar.classList.add('indeterminate');
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      importStatus.textContent = '解码中 ' + (i + 1) + '/' + files.length + ' · ' + f.name;
      try {
        const ab = await f.arrayBuffer();
        const buffer = await ensureCtx().decodeAudioData(ab.slice(0));
        tracks.push({ id: nextId++, name: f.name, buffer: buffer, selected: false, pps: null, scrollPx: 0 });
        ok++;
      } catch (e) {
        console.error(e);
        showToast('无法解析「' + f.name + '」');
        alert('无法解析「' + f.name + '」，请确认是有效的音频文件（MP3/WAV）。');
      }
      importBar.classList.remove('indeterminate'); // 本个已完成 → 实宽走一格
      if (importBarFill) importBarFill.style.width = ((i + 1) / files.length * 100) + '%';
    }
    const doneMsg = ok ? '已导入 ' + ok + ' 个音频' : '';
    importStatus.textContent = doneMsg;
    setTimeout(function () {
      importBar.hidden = true;
      if (importBarFill) importBarFill.style.width = '0%';
      if (importStatus.textContent === doneMsg) importStatus.textContent = '';
    }, 2000);
    if (hideFilter === 'hidden') { hideFilter = 'unhidden'; syncFilterChecks(); } // 新导入的音频要在「未隐藏」里可见
    pxPerSec = null; // 重新铺满整个横条
    renderTracks();
    pushHistory();
    importBusy = false;
  }

  /* ---------------- 轨道渲染 ---------------- */
  function renderTracks() {
    // 隐藏视图已没有内容时自动回到「所有音频文件」
    if (hideFilter === 'hidden' && !tracks.some(function (t) { return t.hidden; })) {
      hideFilter = 'all';
      syncFilterChecks();
    }
    // 选区失效校验：引用的轨道已不存在时清除（防删除/剪切静默失效）
    if (selection && selection.ids.some(function (id) { return !trackById(id); })) clearSelectionEl();
    tracksContainer.innerHTML = '';
    if (studioEmpty) studioEmpty.hidden = tracks.length > 0;
    tracksWrap.classList.toggle('is-empty', tracks.length === 0); // 仅空状态撑起大舞台，有轨道时不留空底
    (selectMode === 'hide' ? tracks : visibleTracks()).forEach(function (t) { // 隐藏模式：全部音频（含已隐藏）都显示出来勾选
      const row = document.createElement('div');
      row.className = 'track-row' + (t.selected ? ' selected' : '') + (t.hidden ? ' hidden-track' : '');
      row.dataset.id = t.id;

      const label = document.createElement('div');
      label.className = 'track-label';
      label.innerHTML = '<input type="checkbox" class="track-check">' +
        '<span class="track-grip" title="拖动换序">⠿</span>' +
        '<span class="track-name"></span>' +
        (t.hidden ? '<span class="track-hidden-tag">已隐藏</span>' : '') +
        '<button class="track-del" type="button" title="删除该音频">✕</button>';
      label.querySelector('.track-name').textContent = t.name;
      label.title = t.name + '（' + formatTime(t.buffer.duration) + '）';

      const cb = label.querySelector('.track-check');
      cb.addEventListener('click', function (e) { e.stopPropagation(); });
      cb.addEventListener('change', function () { toggleCheck(t, cb.checked); });

      // 轨道 ✕ 删除（带确认，与工具栏删除按钮一致）
      label.querySelector('.track-del').addEventListener('click', function (e) {
        e.stopPropagation();
        askDelete([t]);
      });

      // 拖拽换序（拖 label，不影响波形交互）
      label.draggable = true;
      label.addEventListener('dragstart', function (e) {
        if (reorderLocked) { // 工具栏操作进行中：禁止换序
          e.preventDefault();
          showToast('当前操作进行中，点击空白处取消后再调整顺序');
          return;
        }
        dragLabelIndex = tracks.indexOf(t);
        label.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(dragLabelIndex)); } catch (err) {}
      });
      label.addEventListener('dragend', function () {
        dragLabelIndex = -1;
        label.classList.remove('dragging');
        clearLabelDragover();
      });
      label.addEventListener('dragover', function (e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (dragLabelIndex !== -1 && dragLabelIndex !== tracks.indexOf(t)) label.classList.add('dragover');
      });
      label.addEventListener('dragleave', function () { label.classList.remove('dragover'); });
      label.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        label.classList.remove('dragover');
        const from = dragLabelIndex;
        const to = tracks.indexOf(t);
        if (from !== -1 && to !== -1 && from !== to) {
          const moved = tracks.splice(from, 1)[0];
          tracks.splice(to, 0, moved);
          renderTracks();
          pushHistory();
        }
        dragLabelIndex = -1;
      });

      const wave = document.createElement('div');
      wave.className = 'track-wave';
      const canvas = document.createElement('canvas');
      canvas.className = 'track-canvas';
      wave.appendChild(canvas);

      // 自绘横向滚动条 + 实时时间进度（常驻预留空间）
      // 拇指长度 = 视口占波形的比例（放大 2 倍拇指缩短一半）；拖拇指平移，点轨道跳转
      const sliderRow = document.createElement('div');
      sliderRow.className = 'track-slider';
      const timeEl = document.createElement('span');
      timeEl.className = 'track-time';
      timeEl.textContent = '00:00 / ' + formatTime(t.buffer.duration);
      const scroller = document.createElement('div');
      scroller.className = 'track-scroll';
      scroller.title = '左右移动波形：拖动滑块，或点击轨道让滑块跳过去';
      scroller.innerHTML = '<div class="track-scroll-thumb"></div>';
      sliderRow.appendChild(timeEl);
      sliderRow.appendChild(scroller);
      wave.appendChild(sliderRow);

      row.appendChild(label);
      row.appendChild(wave);
      tracksContainer.appendChild(row);

      // 自绘滚动条交互：拖拇指 = 平移；点轨道 = 拇指中心跳到点击处并继续拖
      scroller.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        const max = maxScrollFor(t);
        if (max <= 0) return; // 波形未超出视口：无可移动范围
        const thumb = scroller.querySelector('.track-scroll-thumb');
        const barW = scroller.clientWidth;
        const thumbW = Math.max(24, Math.round(barW * scrollRatio(row)));
        const range = Math.max(1, barW - thumbW);
        const rect = scroller.getBoundingClientRect();
        const thumbLeft = parseFloat(thumb.style.left) || 0;
        const grabOffset = (e.target === thumb) ? (e.clientX - rect.left - thumbLeft) : thumbW / 2;
        scrollDragging = true;
        try { scroller.setPointerCapture(e.pointerId); } catch (err) {}
        function apply(clientX) {
          const x = clamp(clientX - rect.left - grabOffset, 0, range);
          t.scrollPx = x / range * max;
          applyTrackScroll(t);
          syncScrollWidget(t);
          renderPlayheads();
          if (selection) updateSelectionEl();
        }
        apply(e.clientX);
        function move(ev) { apply(ev.clientX); }
        function up() {
          scrollDragging = false;
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
        }
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });

      label.addEventListener('click', function (e) {
        onLabelClick(t, e);
      });
      canvas.addEventListener('pointerdown', function (e) { onWavePointerDown(t, canvas, e); });
    });

    layoutTracks();
    drawAllWaves();
    applySelectMode();
    renderPlayheads();
    playControls.hidden = visibleTracks().length === 0; // 独立播放键：有可见音频才显示
    updateImportStatus();
    updateExportBtn();
    if (selection) updateSelectionEl(); // 重建后按新布局重画选区
  }

  // 导入状态栏 + 选中状态文字（所有轨道/选中变化都会刷新）
  /* ---------------- 撤销 / 重做（状态快照，覆盖子界面回写等一切轨道变更） ---------------- */
  const history = [];   // 快照数组：每项 = 轨道列表浅拷贝（AudioBuffer 不可变，可安全共享引用）
  let historyIdx = -1;

  function snapshotState() {
    return tracks.map(function (t) {
      return { id: t.id, name: t.name, buffer: t.buffer, selected: false, pps: t.pps, scrollPx: t.scrollPx || 0, hidden: !!t.hidden };
    });
  }

  // 任何轨道变更完成后调用：记录新状态（子界面保存、导入、删除、剪切、分割均覆盖）
  function pushHistory() {
    history.splice(historyIdx + 1);
    history.push(snapshotState());
    if (history.length > 50) history.shift();
    historyIdx = history.length - 1;
    updateHistoryBtns();
  }

  function updateHistoryBtns() {
    btnUndo.disabled = historyIdx <= 0;            // 没有可撤销的操作
    btnRedo.disabled = historyIdx >= history.length - 1;
  }

  function restoreState(s) {
    stopAllPlayback();
    tracks.length = 0;
    s.forEach(function (t) {
      tracks.push({ id: t.id, name: t.name, buffer: t.buffer, selected: false, pps: t.pps, scrollPx: t.scrollPx || 0, hidden: !!t.hidden });
    });
    clearSelectionEl();
    cursorT = 0;
    pxPerSec = null; // 重新适配铺满
    renderTracks();
  }

  function undo() {
    if (historyIdx <= 0) { showToast('没有可以撤销的操作'); return; }
    historyIdx--;
    restoreState(history[historyIdx]);
    updateHistoryBtns();
    showToast('已撤销');
  }

  function redo() {
    if (historyIdx >= history.length - 1) { showToast('没有可以恢复的操作'); return; }
    historyIdx++;
    restoreState(history[historyIdx]);
    updateHistoryBtns();
    showToast('已恢复');
  }

  btnUndo.addEventListener('click', undo);
  btnRedo.addEventListener('click', redo);

  function updateImportStatus() {
    const sel = selectedTracks();
    if (!tracks.length) {
      importStatus.textContent = '';
      return;
    }
    if (!sel.length) {
      const hidCount = tracks.filter(function (t) { return t.hidden; }).length;
      importStatus.textContent = '已导入 ' + tracks.length + ' 段音频' + (hidCount ? '（隐藏 ' + hidCount + ' 段）' : '');
      return;
    }
    if (sel.length === 1) {
      importStatus.textContent = '当前已选中：' + sel[0].name + '（选中 1 项）';
      return;
    }
    const names = sel.slice(0, 2).map(function (t) { return t.name; }).join('、');
    importStatus.textContent = '已选中 ' + sel.length + ' 项：' + names + (sel.length > 2 ? ' 等' : '');
  }

  // 适应当前窗口：有选中 → 仅选中音频各自铺满；无选中 → 等同全选（每条各自铺满并复位滚动）
  function fitZoom() {
    const avail = Math.max(100, tracksWrap.clientWidth - LABEL_W - 2);
    const sel = selectedTracks();
    const list = sel.length ? sel : visibleTracks();
    list.forEach(function (t) {
      t.pps = clamp(avail / Math.max(0.001, t.buffer.duration), MIN_PPS, MAX_PPS);
      t.scrollPx = 0;
    });
    if (!sel.length) {
      pxPerSec = clamp(avail / Math.max(0.001, maxDuration()), MIN_PPS, MAX_PPS);
    }
  }

  function layoutTracks() {
    if (pxPerSec == null && maxDuration() > 0) {
      const avail = Math.max(100, tracksWrap.clientWidth - LABEL_W - 2);
      pxPerSec = clamp(avail / Math.max(0.001, maxDuration()), MIN_PPS, MAX_PPS);
    }
    // 每行宽度 = 可见视口宽度（容器不再被最宽波形撑开）：
    // 波形超出视口的部分由行内裁剪，缩放范围 = 画布宽 − 视口宽，滑块因此有真实的可移动范围
    tracks.forEach(function (t) {
      const row = tracksContainer.querySelector('.track-row[data-id="' + t.id + '"]');
      if (!row) return;
      const w = Math.min(MAX_CANVAS_W, Math.max(1, Math.round(t.buffer.duration * trackPps(t))));
      row.querySelector('.track-canvas').style.width = w + 'px';
      // 缩放后修正滚动范围并应用偏移
      t.scrollPx = clamp(t.scrollPx || 0, 0, maxScrollFor(t));
      applyTrackScroll(t);
      syncScrollWidget(t);
    });
  }

  // 逐列峰值绘制波形（复用拼接界面的思路）
  function drawWave(canvas, buffer) {
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
    const mid = cssH / 2;

    ctx.fillStyle = 'rgba(242,238,255,0.5)';
    for (let x = 0; x < cssW; x++) {
      const s = Math.floor(buffer.length * x / cssW);
      const e = Math.max(1, Math.floor(buffer.length * (x + 1) / cssW));
      const step = Math.max(1, Math.floor((e - s) / 400));
      let peak = 0;
      for (let j = s; j < e; j += step) {
        const v = Math.abs((ch0[j] + ch1[j]) * 0.5);
        if (v > peak) peak = v;
      }
      const h = Math.max(1, peak * (cssH / 2 - 2));
      ctx.fillRect(x, mid - h, 1, h * 2);
    }
  }

  function drawAllWaves() {
    tracks.forEach(function (t) {
      const row = tracksContainer.querySelector('.track-row[data-id="' + t.id + '"]');
      if (!row) return;
      drawWave(row.querySelector('.track-canvas'), t.buffer);
    });
  }

  /* ---------------- 水平缩放（ctrl + 滚轮） ---------------- */
  tracksWrap.addEventListener('wheel', function (e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.2 : (1 / 1.2);
    const wrapRect = tracksWrap.getBoundingClientRect();
    const relX = clamp(e.clientX - wrapRect.left, 0, tracksWrap.clientWidth) - LABEL_W; // 鼠标在波形视口内的位置
    const sel = selectedTracks();
    if (sel.length) {
      // 有选中：以鼠标为中心只缩放选中音频（pps 上限保证波形宽度不超画布上限，避免压扁错位）
      sel.forEach(function (t) {
        const oldPps = trackPps(t);
        const tMouse = ((t.scrollPx || 0) + relX) / oldPps;
        t.pps = clamp(oldPps * factor, MIN_PPS, Math.min(MAX_PPS, MAX_CANVAS_W / Math.max(0.001, t.buffer.duration)));
        t.scrollPx = Math.max(0, tMouse * t.pps - relX); // 缩放后鼠标仍对准同一时刻
      });
    } else {
      // 无选中：全部统一缩放（每轨以鼠标为锚点同步缩放，滚动位置各轨独立保留）
      if (pxPerSec == null && maxDuration() > 0) {
        const avail = Math.max(100, tracksWrap.clientWidth - LABEL_W - 2);
        pxPerSec = clamp(avail / Math.max(0.001, maxDuration()), MIN_PPS, MAX_PPS);
      }
      const newPps = clamp(pxPerSec * factor, MIN_PPS, Math.min(MAX_PPS, MAX_CANVAS_W / Math.max(0.001, maxDuration())));
      tracks.forEach(function (t) {
        const oldPps = trackPps(t);
        const tMouse = ((t.scrollPx || 0) + relX) / oldPps;
        t.pps = null; // 回归全局比例
        t.scrollPx = Math.max(0, tMouse * newPps - relX);
      });
      pxPerSec = newPps;
    }
    layoutTracks(); // 内部会 clamp 每轨 scrollPx 并应用位移
    drawAllWaves();
    renderPlayheads();
    if (selPlay && selection) buildSelCursor(); // 选区光标随缩放重建
    if (selection) updateSelectionEl();
  }, { passive: false });

  /* ---------------- 播放 ---------------- */
  function togglePlay() {
    if (isPlaying) {
      pauseCapture();      // 暂停：记住位置
      stopPlay();
      renderPlayheads();
    } else {
      startPlay();         // 继续：从记住的位置播放
    }
  }

  // 从头播放：光标回开头；正在播放时同一批音频从开头重播（不改变播放对象）
  function replayFromStart() {
    if (isPlaying) {
      const set = playingIds.map(trackById).filter(Boolean);
      if (!set.length) { seekTo(0); return; }
      stopAllPlayback();
      cursorT = 0;
      startPlay(set);
      return;
    }
    seekTo(0); // 未播放：仅把光标移回开头（顺带停掉选区播放）
  }

  /* ---------------- 播放（从光标位置开始） ---------------- */
  // 暂停语义：记住当前播放位置，下次播放从这继续
  function pauseCapture() {
    if (isPlaying && audioCtx) {
      const elapsed = Math.max(0, audioCtx.currentTime - playStartCtx);
      cursorT = Math.min(cursorT + elapsed * playSpeed, Math.max(0, maxDuration()));
    }
  }

  function startPlay(forcedList) {
    if (!visibleTracks().length) return;
    stopAllPlayback(); // 播放原则：开始播放前无条件停掉一切（宁重勿错）
    const toPlay = forcedList && forcedList.length ? forcedList : (selectedTracks().length ? selectedTracks() : visibleTracks());
    playingIds = toPlay.map(function (t) { return t.id; }); // 记住播放对象：从头播放时保持不变
    if (!toPlay.length) return;
    const ctx = ensureCtx();
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    // 光标停在所有（选中）轨结尾 → 从头开始播
    if (cursorT > 0 && toPlay.every(function (t) { return cursorT >= t.buffer.duration - 0.01; })) {
      cursorT = 0;
      renderPlayheads();
    }
    playStartCtx = ctx.currentTime + 0.05;
    playingDuration = 0;
    playSources = [];
    toPlay.forEach(function (t) {
      if (cursorT >= t.buffer.duration - 0.01) return; // 该轨已到结尾，不发声
      const src = ctx.createBufferSource();
      src.buffer = t.buffer;
      src.playbackRate.value = playSpeed; // 倍速播放（1x/2x/3x）
      src.connect(ctx.destination);
      src.start(playStartCtx, cursorT);
      playSources.push(src);
      const remain = (t.buffer.duration - cursorT) / playSpeed;
      if (remain > playingDuration) playingDuration = remain;
    });
    if (!playSources.length) return;
    isPlaying = true;
    setPlayBtns(true);
    updatePlayhead();
  }

  function setPlayBtns(playing) {
    btnPlay.textContent = playing ? '⏸︎ 暂停' : '▶︎ 播放';
    playheadLayer.classList.toggle('playing', playing); // 播放中光标脉冲（纯视觉）
  }

  function stopPlay() {
    playSources.forEach(function (s) { try { s.stop(); } catch (e) {} try { s.disconnect(); } catch (e) {} });
    playSources = [];
    isPlaying = false;
    if (playRaf) { cancelAnimationFrame(playRaf); playRaf = 0; }
    setPlayBtns(false);
  }

  // 停掉主界面一切播放（主播放 + 选区播放）
  function stopAllPlayback() {
    if (previewSrcs.length) stopSelPreview();
    stopPlay();
  }

  function selectionSignature() {
    return tracks.filter(function (t) { return t.selected; }).map(function (t) { return t.id; }).join(',');
  }

  // 光标跳转（播放中则从新位置继续播）；定位属于主光标操作 → 停掉选区播放
  function seekTo(t) {
    if (previewSrcs.length) stopSelPreview();
    cursorT = clamp(t, 0, maxDuration());
    renderPlayheads();
    if (isPlaying) { stopPlay(); startPlay(); }
  }

  // 播放中的真实当前位置：cursorT 只是本次播放的起点，需叠加已播时长。
  // 旧逻辑直接读 cursorT → 播放中按方向键/拖光标都从旧起点计算（跳回开头/错播的根因）
  function currentPlayPos() {
    if (isPlaying && audioCtx) {
      const elapsed = Math.max(0, audioCtx.currentTime - playStartCtx);
      return Math.min(cursorT + elapsed * playSpeed, Math.max(0, maxDuration()));
    }
    return cursorT;
  }

  function nudgePlay(dt) { seekTo(currentPlayPos() + dt); }

  // 光标渲染：无选中 = 一根纵贯所有轨道的长光标；有选中 = 每条选中轨道一根短光标（按各轨缩放定位）
  const cursorHit = document.createElement('div');
  cursorHit.className = 'playhead-hit';
  cursorHit.hidden = true;

  function ensureLayer() {
    if (playheadLayer.parentNode !== tracksContainer) tracksContainer.appendChild(playheadLayer);
  }

  // 光标在某轨上的屏幕 x（考虑该轨缩放与独立滚动偏移）；视口外则隐藏
  function placeCursorEl(el, t, pos) {
    const row = tracksContainer.querySelector('.track-row[data-id="' + t.id + '"]');
    if (!row) { el.style.display = 'none'; return; }
    const rel = pos * trackPps(t) - (t.scrollPx || 0);
    const waveW = row.querySelector('.track-wave').clientWidth;
    if (rel < -2 || rel > waveW + 2) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.style.top = row.offsetTop + 'px';
    el.style.height = row.offsetHeight + 'px';
    el.style.left = (LABEL_W + rel) + 'px';
  }

  function renderPlayheads() {
    playheadLayer.innerHTML = '';
    ensureLayer();
    cursorInfo = [];
    if (!visibleTracks().length || studio.hidden) { hideCursorHit(); return; }
    if (previewSrcs.length) { playheadLayer.appendChild(cursorHit); hideCursorHit(); return; } // 选区播放中主光标隐藏
    const pos = Math.min(currentPlayPos(), maxDuration()); // 播放中取真实位置（缩放/滚动时视觉不回跳）
    const sel = selectedTracks();
    const list = sel.length ? sel : visibleTracks(); // 无选中=每轨一段（对齐时视觉为连续长光标）
    list.forEach(function (t) {
      const el = document.createElement('div');
      el.className = 'playhead-seg';
      placeCursorEl(el, t, pos);
      playheadLayer.appendChild(el);
      cursorInfo.push({ el: el, pps: trackPps(t), scroll: t.scrollPx || 0, track: t });
    });
    playheadLayer.appendChild(cursorHit);
    positionCursorEls(pos); // 首次摆放 + 同步时间文本
  }

  // 按各轨缩放与滚动偏移摆放光标；同步时间文本；播放时光标越界自动跟随
  let scrollDragging = false;
  function positionCursorEls(pos) {
    cursorInfo.forEach(function (info) {
      const t = info.track;
      const row = tracksContainer.querySelector('.track-row[data-id="' + t.id + '"]');
      if (row) {
        const wave = row.querySelector('.track-wave');
        const viewportW = wave.clientWidth;
        if (isPlaying && !scrollDragging) {
          const rel = pos * trackPps(t) - (t.scrollPx || 0);
          if (rel > viewportW * 0.85 || rel < 0) {
            t.scrollPx = clamp(pos * trackPps(t) - viewportW * 0.5, 0, maxScrollFor(t));
            applyTrackScroll(t);
            syncScrollWidget(t);
          }
        }
        const timeEl = row.querySelector('.track-time');
        if (timeEl) {
          timeEl.textContent = formatTime(Math.min(pos, t.buffer.duration)) + ' / ' + formatTime(t.buffer.duration);
        }
      }
      placeCursorEl(info.el, t, pos);
    });
    if (recordMode) updateRecordBox(); // 记录模式：范围预览恒显示并跟随光标/播放推进
  }

  function updatePlayhead() {
    if (!isPlaying || !playSources.length) { playRaf = 0; return; }
    const elapsed = Math.max(0, audioCtx.currentTime - playStartCtx);
    positionCursorEls(cursorT + elapsed * playSpeed);
    if (elapsed >= playingDuration + 0.1) {
      stopPlay();
      cursorT = 0; // 播放结束光标回开头
      renderPlayheads();
      return;
    }
    playRaf = requestAnimationFrame(updatePlayhead);
  }

  /* ---------------- 光标抓取：鼠标靠近变粗、按住拖拽定位 ---------------- */
  let cursorDragging = false;

  function hideCursorHit() {
    cursorHit.hidden = true;
    cursorInfo.forEach(function (info) { info.el.classList.remove('near'); });
  }

  // 命中检测：返回光标附近（横向 ±tol，纵向在段内）的光标信息
  function hitCursorInfo(e, tol) {
    if (!cursorInfo.length) return null;
    const rect = tracksContainer.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    for (const info of cursorInfo) {
      const el = info.el;
      if (el.style.display === 'none') continue; // 视口外隐藏段不参与命中
      const left = parseFloat(el.style.left) || 0;
      const top = el.offsetTop;
      const h = el.offsetHeight;
      if (my >= top - 2 && my <= top + h + 2 && Math.abs(mx - left) <= tol) return info;
    }
    return null;
  }

  // 光标拖拽（光标优先于选区：靠近光标按下即移动光标）
  function startCursorDrag(pps, scrollPx) {
    if (cursorDragging) return;
    cursorDragging = true;
    const wasPlaying = isPlaying;
    let dragT = currentPlayPos(); // 播放中取真实当前位置，杜绝“松手跳回播放起点”
    if (wasPlaying) stopAllPlayback(); // 拖拽期间暂停：旧逻辑音频继续走而锚点被改 → 声画分离/错播
    cursorT = dragT;
    renderPlayheads();
    cursorInfo.forEach(function (info) { info.el.classList.add('drag'); });
    document.body.classList.add('cursor-grabbing');
    function move(ev) {
      const rect = tracksContainer.getBoundingClientRect();
      dragT = clamp((ev.clientX - rect.left - LABEL_W + (scrollPx || 0)) / pps, 0, maxDuration());
      cursorT = dragT;
      positionCursorEls(cursorT);
      cursorHit.style.left = (LABEL_W + cursorT * pps - (scrollPx || 0)) + 'px';
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      cursorDragging = false;
      document.body.classList.remove('cursor-grabbing');
      cursorInfo.forEach(function (info) { info.el.classList.remove('drag'); });
      cursorT = dragT;
      renderPlayheads();
      if (wasPlaying) startPlay(); // 从松手位置继续播放
      else seekTo(dragT);          // 未播放：仅定位
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  tracksWrap.addEventListener('pointermove', function (e) {
    if (cursorDragging || studio.hidden || !cursorInfo.length) return;
    const hit = hitCursorInfo(e, 8);
    if (hit) {
      cursorHit.hidden = false;
      cursorHit.dataset.pps = String(hit.pps);
      cursorHit.dataset.scroll = String(hit.scroll || 0);
      cursorHit.style.left = hit.el.style.left;
      cursorHit.style.top = hit.el.style.top;
      cursorHit.style.height = hit.el.style.height;
      cursorInfo.forEach(function (info) { info.el.classList.toggle('near', info === hit); }); // 只有命中段加粗
    } else {
      hideCursorHit();
    }
  });
  tracksWrap.addEventListener('pointerleave', function () {
    if (!cursorDragging) hideCursorHit();
  });

  cursorHit.addEventListener('pointerdown', function (e) {
    if (cursorHit.hidden || cursorHit.dataset.pps == null) return;
    e.preventDefault();
    e.stopPropagation();
    try { cursorHit.setPointerCapture(e.pointerId); } catch (err) {}
    startCursorDrag(parseFloat(cursorHit.dataset.pps), parseFloat(cursorHit.dataset.scroll) || 0);
  });

  /* ---------------- 选中 / 多选 ---------------- */
  function onLabelClick(track, e) {
    if (selectMode) {
      toggleCheck(track, selectMode === 'mask' ? true : !track.checked);
      return;
    }
    const before = selectionSignature();
    if (e.ctrlKey || e.metaKey) {
      track.selected = !track.selected;
    } else {
      tracks.forEach(function (x) { x.selected = (x === track); });
    }
    // 选中集合变化 → 停止一切播放、拖拽选区失效、光标回起点（宁重勿错）
    if (selectionSignature() !== before) {
      stopAllPlayback();
      cursorT = 0;
      clearSelectionEl();
    }
    applySelectionClasses();
  }

  function applySelectionClasses() {
    tracks.forEach(function (t) {
      const row = tracksContainer.querySelector('.track-row[data-id="' + t.id + '"]');
      if (row) row.classList.toggle('selected', !!t.selected);
    });
    // 全选按钮状态灯
    if (btnSelectAll) {
      const vis = visibleTracks();
      btnSelectAll.classList.toggle('active', vis.length > 0 && vis.every(function (x) { return x.selected; }));
    }
    updateImportStatus();
    renderPlayheads(); // 选中变化 → 光标形态跟随（长光标 ↔ 每选中轨短光标）
  }

  /* ---------------- 轨道拖拽换序 ---------------- */
  let dragLabelIndex = -1;
  let reorderLocked = false; // 工具栏按钮点击后锁定换序，点空白取消
  function clearLabelDragover() {
    const labels = tracksContainer.querySelectorAll('.track-label');
    for (const el of labels) el.classList.remove('dragover');
  }

  function selectAll() {
    const before = selectionSignature();
    visibleTracks().forEach(function (t) { t.selected = true; });
    if (selectionSignature() !== before) { stopAllPlayback(); cursorT = 0; clearSelectionEl(); }
    applySelectionClasses();
  }

  function clearSelection() {
    const before = selectionSignature();
    tracks.forEach(function (t) { t.selected = false; });
    if (selectionSignature() !== before) { stopAllPlayback(); cursorT = 0; clearSelectionEl(); }
    applySelectionClasses();
  }

  /* ---------------- 选择模式（勾选小方框） ---------------- */
  let selectMode = null; // null | 'mask' | 'splice' | 'overlay'

  function toggleCheck(track, val) {
    if (selectMode === 'mask') {
      // 单选模式：点谁选谁
      tracks.forEach(function (x) { x.checked = (x === track); });
    } else {
      track.checked = val !== undefined ? !!val : !track.checked;
      if (selectMode === 'hide') track._hideTouched = true; // 隐藏模式：记录用户动过的文件
    }
    applySelectMode();
  }

  function enterSelectMode(mode) {
    selectMode = mode;
    clearSelection();
    clearSelectionEl();
    tracks.forEach(function (t) { t.checked = false; t._hideTouched = false; });
    applySelectMode();
    renderTracks(); // 隐藏模式需要显示全部音频；其他模式恢复过滤视图
  }

  function exitSelectMode() {
    selectMode = null;
    tracks.forEach(function (t) { t.checked = false; t._hideTouched = false; });
    applySelectMode();
    renderTracks(); // 从隐藏模式（全量显示）回到过滤视图
  }

  function applySelectMode() {
    tracksContainer.classList.toggle('select-mode', !!selectMode);
    tracks.forEach(function (t) {
      const row = tracksContainer.querySelector('.track-row[data-id="' + t.id + '"]');
      if (!row) return;
      const cb = row.querySelector('.track-check');
      if (cb) cb.checked = !!t.checked;
    });
    selectBar.hidden = !selectMode;
    // 工具栏四按钮常亮状态
    btnToolMask.classList.toggle('active', selectMode === 'mask');
    btnToolSplice.classList.toggle('active', selectMode === 'splice');
    btnToolOverlay.classList.toggle('active', selectMode === 'overlay');
    btnToolDelete.classList.toggle('active', selectMode === 'delete');
    btnToolHide.classList.toggle('active', selectMode === 'hide');
    if (selectMode) {
      const hints = {
        mask: '勾选一个音频，点击「确定」进入蒙版',
        splice: '勾选两个音频，点击「确定」进入拼接',
        overlay: '勾选两个音频，点击「确定」进入叠加',
        delete: '勾选要删除的音频，点击「确定」删除',
        hide: '勾选：隐藏；取消勾选：恢复显示；未更改项保持原状'
      };
      selectHint.textContent = hints[selectMode] || '';
    }
  }

  function confirmSelect() {
    const checked = tracks.filter(function (t) { return t.checked; });
    if (selectMode === 'mask') {
      if (checked.length !== 1) { alert('请选择一个音频'); return; }
      exitSelectMode();
      openMask(checked[0]);
    } else if (selectMode === 'splice') {
      if (checked.length !== 2) { alert('请选择两个音频'); return; }
      exitSelectMode();
      openSplice(checked);
    } else if (selectMode === 'overlay') {
      if (checked.length !== 2) { alert('请选择两个音频'); return; }
      exitSelectMode();
      openOverlay(checked);
    } else if (selectMode === 'delete') {
      if (!checked.length) { alert('请选择要删除的音频'); return; }
      exitSelectMode();
      askDelete(checked);
    } else if (selectMode === 'hide') {
      // 只应用用户动过的文件：勾选 = 隐藏，取消勾选 = 恢复显示；没动过的保持原状
      const states = tracks
        .filter(function (t) { return t._hideTouched; })
        .map(function (t) { return { t: t, on: t.checked }; });
      exitSelectMode();
      applyHideTouched(states);
    }
  }

  /* ---------------- 隐藏 / 上下移动 ---------------- */
  // 应用本次隐藏操作：只处理用户动过的文件（勾选 = 隐藏，取消勾选 = 恢复显示）
  function applyHideTouched(states) {
    stopAllPlayback();
    let hid = 0, show = 0;
    states.forEach(function (s) {
      if (!!s.t.hidden !== s.on) {
        s.t.hidden = s.on;
        if (s.on) hid++; else show++;
      }
      s.t._hideTouched = false;
      s.t.selected = false;
      s.t.checked = false;
    });
    if (!hid && !show) { showToast('未做任何更改'); return; }
    if (hideFilter === 'all') { hideFilter = 'unhidden'; syncFilterChecks(); } // 使用隐藏后默认查看「未隐藏」，保持主界面干净
    clearSelectionEl();
    renderTracks(); // 隐藏视图被清空时会在 renderTracks 中自动切回「所有」
    pushHistory();
    showToast(hid && show ? '已隐藏 ' + hid + ' 个、恢复显示 ' + show + ' 个音频'
      : (hid ? '已隐藏 ' + hid + ' 个音频（可在「隐藏文件」中找回）' : '已恢复显示 ' + show + ' 个音频'));
  }

  // 上移/下移选中音频（整组保持相对顺序挪一格）
  function moveSelected(dir) {
    reorderLocked = false; // 按钮完成的换序即刻生效，不进入换序锁定
    const sel = selectedTracks();
    if (!sel.length) { showToast('请先选中要移动的音频'); return; }
    const selSet = {};
    sel.forEach(function (t) { selSet[t.id] = true; });
    let moved = false;
    if (dir < 0) {
      for (let i = 1; i < tracks.length; i++) {
        if (selSet[tracks[i].id] && !selSet[tracks[i - 1].id]) {
          const tmp = tracks[i - 1]; tracks[i - 1] = tracks[i]; tracks[i] = tmp; moved = true;
        }
      }
    } else {
      for (let i = tracks.length - 2; i >= 0; i--) {
        if (selSet[tracks[i].id] && !selSet[tracks[i + 1].id]) {
          const tmp = tracks[i + 1]; tracks[i + 1] = tracks[i]; tracks[i] = tmp; moved = true;
        }
      }
    }
    if (!moved) { showToast(dir < 0 ? '已在最顶部' : '已在最底部'); return; }
    renderTracks();
    pushHistory();
  }

  /* ---------------- 删除 ---------------- */
  const deleteCbRef = { cb: null };
  function askDelete(list) {
    if (!list || !list.length) { showToast('请先选择要删除的音频'); return; }
    if (previewSrcs.length) stopSelPreview();
    let names;
    if (list.length === 1) {
      names = '「' + list[0].name + '」';
    } else if (list.length <= 3) {
      names = list.map(function (t) { return '「' + t.name + '」'; }).join('、');
    } else {
      names = '「' + list[0].name + '」「' + list[1].name + '」等 ' + list.length + ' 个音频';
    }
    deleteModalTitle.textContent = '确定要删除' + names + '吗？';
    deleteCbRef.cb = function () {
      if (isPlaying) stopPlay();
      const ids = {};
      list.forEach(function (t) { ids[t.id] = true; });
      for (let i = tracks.length - 1; i >= 0; i--) {
        if (ids[tracks[i].id]) tracks.splice(i, 1);
      }
      clearSelectionEl();
      renderTracks();
      pushHistory();
      showToast('已删除 ' + list.length + ' 个音频');
    };
    deleteModal.hidden = false;
  }

  /* ---------------- 子界面跳转 ---------------- */
  function showPage(page) {
    stopSelPreview();     // 播放互斥：切页停掉一切主界面播放
    pauseCapture();       // 记住中断位置，回到主界面按播放可继续
    stopPlay();
    studio.hidden = page !== null;
    pageMask.hidden = page !== pageMask;
    pageSplice.hidden = page !== pageSplice;
    pageOverlay.hidden = page !== pageOverlay;
    window.scrollTo(0, 0);
  }

  function openMask(t) {
    if (!t) return;
    clearSelection();
    showPage(pageMask);
    window.MaskStudio.open(t.name, t.buffer, t.id);
  }

  function openSplice(list) {
    if (!list || list.length !== 2) return;
    const ids = list.map(function (t) { return t.id; });
    clearSelection();
    showPage(pageSplice);
    window.SpliceStudio.loadTracks(list.map(function (t) { return { name: t.name, buffer: t.buffer }; }), ids);
  }

  // 工具栏按钮：常亮 toggle（再次点击 = 取消勾选模式）；已有足够选中时直接进入
  function onTool(mode) {
    if (selectMode === mode) { exitSelectMode(); return; }
    const sel = selectedTracks();
    if (mode === 'mask' && sel.length === 1) { openMask(sel[0]); return; }
    if (mode === 'splice' && sel.length === 2) { openSplice(sel); return; }
    if (mode === 'overlay' && sel.length === 2) { openOverlay(sel); return; }
    enterSelectMode(mode);
  }

  function openOverlay(list) {
    if (!list || list.length !== 2) return;
    const ids = list.map(function (t) { return t.id; });
    clearSelection();
    showPage(pageOverlay);
    window.OverlayStudio.loadTracks(list.map(function (t) { return { name: t.name, buffer: t.buffer }; }), ids);
  }

  /* ---------------- 回写（子界面「保存并继续」） ---------------- */
  window.Studio = {
    onChildSave: function (buffer, name, replacedIds) {
      // 删除被替换/合并的轨道，插入结果轨道
      const idSet = {};
      (replacedIds || []).forEach(function (id) { idSet[id] = true; });
      for (let i = tracks.length - 1; i >= 0; i--) {
        if (idSet[tracks[i].id]) tracks.splice(i, 1);
      }
      if (hideFilter === 'hidden') { hideFilter = 'unhidden'; syncFilterChecks(); } // 保存结果要在「未隐藏」里可见
      tracks.push({ id: nextId++, name: name, buffer: buffer, selected: false, pps: null, scrollPx: 0 });
      showPage(null);
      renderTracks();
      pushHistory();
      showToast((replacedIds && replacedIds.length) ? '已替换原音频' : '已保留原音频，结果新增为一条');
    },
    backToStudio: function () {
      showPage(null);
      renderTracks();
    },
    getTracks: function () { return tracks; }
  };

  /* ---------------- 拖拽选区（剪辑） ---------------- */
  // 无选中轨道：在按下的那条轨道上做单轨选区；有选中轨道且按下的轨道也被选中：所有选中轨道同步选区
  function onWavePointerDown(track, canvas, e) {
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {} // 拖出窗口也持续收 move/up
    if (previewSrcs.length) stopSelPreview(); // 开始新的波形交互：先停选区播放
    // 光标优先：靠近光标按下 → 拖拽光标，不产生选区
    const hitInfo = hitCursorInfo(e, 10);
    if (hitInfo) {
      startCursorDrag(hitInfo.pps, hitInfo.scroll);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, 0, rect.width);
    const t = (x + (track.scrollPx || 0)) / trackPps(track); // 按该轨缩放与滚动偏移换算时间
    // 已有单轨选区且按下点在其内部 → 开始拖拽剪切
    if (selection && selection.ids.length === 1 && selection.ids[0] === track.id &&
        t >= selection.from && t <= selection.to) {
      startSelectionDrag(e);
      return;
    }
    const sel = selectedTracks();
    const ids = (sel.length && track.selected) ? sel.map(function (s) { return s.id; }) : [track.id];
    selectionDrag = { canvas: canvas, track: track, startX: x, ids: ids, moved: false, lastX: x };
    clearSelectionEls();
    window.addEventListener('pointermove', onSelectMove);
    window.addEventListener('pointerup', onSelectUp);
    window.addEventListener('pointercancel', onSelectUp);
  }

  function onSelectMove(e) {
    if (!selectionDrag) return;
    const rect = selectionDrag.canvas.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, 0, rect.width);
    selectionDrag.lastX = x; // 记录最后位置：拖出窗口触发 pointercancel 时 clientX 不可用
    if (!selectionDrag.moved && Math.abs(x - selectionDrag.startX) > 4) selectionDrag.moved = true;
    if (selectionDrag.moved) {
      const a = Math.min(selectionDrag.startX, x);
      const b = Math.max(selectionDrag.startX, x);
      // 拖拽发生在某一条轨道上，按该轨缩放换算时间，再按各轨缩放渲染
      const aT = (a + (selectionDrag.track.scrollPx || 0)) / trackPps(selectionDrag.track);
      const bT = (b + (selectionDrag.track.scrollPx || 0)) / trackPps(selectionDrag.track);
      showSelectionRanges(selectionDrag.ids, aT, bT);
    }
  }

  function onSelectUp(e) {
    if (!selectionDrag) return;
    const drag = selectionDrag;
    selectionDrag = null;
    window.removeEventListener('pointermove', onSelectMove);
    window.removeEventListener('pointerup', onSelectUp);
    window.removeEventListener('pointercancel', onSelectUp);

    // pointerup / pointercancel 统一用最后记录位置（拉到最前/最后拖出窗口也能正常成选区）
    const x = (drag.lastX != null) ? drag.lastX : drag.startX;

    // 单击（未拖动且非取消）：未选中轨 → 选中它并把光标放到点击处；已选中轨 → 仅定位
    if (!drag.moved) {
      if (e.type === 'pointercancel') { clearSelectionEls(); return; }
      const target = drag.track;
      const tClick = clamp((x + (target.scrollPx || 0)) / trackPps(target), 0, maxDuration());
      if (!target.selected) {
        stopAllPlayback();
        cursorT = tClick; // 宁重置也不播错：切到新选中轨
        tracks.forEach(function (xx) { xx.selected = (xx === target); });
        clearSelectionEl();
        applySelectionClasses();
      } else {
        seekTo(tClick);
      }
      return;
    }

    const a = Math.min(drag.startX, x);
    const b = Math.max(drag.startX, x);
    const from = (a + (drag.track.scrollPx || 0)) / trackPps(drag.track);
    const to = (b + (drag.track.scrollPx || 0)) / trackPps(drag.track);
    if (to - from < 0.05) { clearSelectionEls(); return; }
    // 任何时候选中某一段（含多段自定义）→ 停止当前播放；光标位置保留（暂停语义）
    pauseCapture();
    stopAllPlayback();
    selection = { ids: drag.ids, from: from, to: to };
    showSelectionRanges(drag.ids, from, to);
    showSelectionTools();
    renderPlayheads();
  }

  function clearSelectionEls() {
    selectionEls.forEach(function (el) { el.remove(); });
    selectionEls = [];
  }

  // 选区渲染：传入时间，各轨道按自己的缩放与滚动偏移换算像素（视口外裁剪）
  function showSelectionRanges(ids, aT, bT) {
    clearSelectionEls();
    ids.forEach(function (id) {
      const t = trackById(id);
      const row = tracksContainer.querySelector('.track-row[data-id="' + id + '"]');
      if (!t || !row) return;
      const wave = row.querySelector('.track-wave');
      const pps = trackPps(t);
      const sc = t.scrollPx || 0;
      const relA = aT * pps - sc;
      const relB = bT * pps - sc;
      if (relB <= 0 || relA >= wave.clientWidth) return; // 完全在视口外
      const visA = Math.max(relA, 0);
      const visB = Math.min(relB, wave.clientWidth);
      const el = document.createElement('div');
      el.className = 'selection-range';
      el.style.top = row.offsetTop + 'px';
      el.style.height = row.offsetHeight + 'px';
      el.style.left = (LABEL_W + visA) + 'px';
      el.style.width = Math.max(1, visB - visA) + 'px';
      tracksContainer.appendChild(el);
      selectionEls.push(el);
    });
  }

  function clearSelectionEl() {
    clearSelectionEls();
    selection = null;
    hideSelectionTools();
    if (previewSrcs.length) stopSelPreview(); // 选区没了，其播放也停止
  }

  function updateSelectionEl() {
    if (!selection) return;
    showSelectionRanges(selection.ids, selection.from, selection.to);
  }

  /* 选区操作条 */
  const selectionTools = document.createElement('div');
  selectionTools.className = 'selection-tools';
  selectionTools.id = 'selection-tools';
  function ensureSelectionTools() {
    if (!selectionTools.parentNode) studio.appendChild(selectionTools);
  }
  let btnCutSel = null;
  function showSelectionTools() {
    ensureSelectionTools();
    // 选中多段音频（多轨选区或多选状态）时无法剪切
    if (btnCutSel) {
      const blocked = (selection && selection.ids.length > 1) || selectedTracks().length > 1;
      btnCutSel.disabled = blocked;
      btnCutSel.title = blocked
        ? '选中多段音频时无法剪切'
        : '剪下选区：原音频去掉该段，选区生成新轨道（Shift+拖选区拖拽也可）';
    }
    selectionTools.hidden = false;
  }
  function hideSelectionTools() {
    selectionTools.hidden = true;
  }
  function buildSelectionTools() {
    selectionTools.innerHTML = '';
    const mk = function (label, title, cb) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-small';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', cb);
      selectionTools.appendChild(b);
      return b;
    };
    mk('删除', '删除选区（Backspace）', deleteSelection);
    mk('单次播放', '单次播放选区（Space）', function () { toggleSelPreview(false); });
    mk('重复播放', '循环播放选区（Shift+Space）', function () { toggleSelPreview(true); });
    btnCutSel = mk('剪切为新轨道', '剪下选区：原音频去掉该段，选区生成新轨道', cutSelection);
    mk('复制', '复制选区为新轨道（原音频完整保留）', copySelection);
  }

  // 选区播放按钮：正在以相同模式播放时再点 = 停止；否则开始/切换模式
  function toggleSelPreview(loop) {
    if (previewSrcs.length && selPlay && selPlay.loop === loop) stopSelPreview();
    else playSelection(loop);
  }

  function trackById(id) { return tracks.filter(function (t) { return t.id === id; })[0]; }

  function deleteSelection() {
    if (!selection) return;
    if (previewSrcs.length) stopSelPreview();
    // 多轨选区：每条选中轨道都删除对应范围
    const targets = selection.ids.map(trackById).filter(Boolean);
    if (!targets.length) { showToast('选区已失效，请重新框选'); clearSelectionEl(); return; }
    targets.forEach(function (t) {
      t.buffer = removeRange(t.buffer, selection.from, selection.to);
    });
    clearSelectionEl();
    renderTracks();
    pushHistory();
  }

  function sliceBuffer(buffer, from, to) {
    const sr = buffer.sampleRate;
    const len = Math.max(1, Math.round((to - from) * sr));
    const out = ensureCtx().createBuffer(buffer.numberOfChannels, len, sr);
    const a0 = Math.max(0, Math.floor(from * sr));
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const src = buffer.getChannelData(c);
      const dst = out.getChannelData(c);
      for (let i = 0; i < len; i++) dst[i] = src[a0 + i] || 0;
    }
    return out;
  }

  function removeRange(buffer, from, to) {
    const sr = buffer.sampleRate;
    const a0 = Math.floor(from * sr);
    const a1 = Math.floor(to * sr);
    const len = Math.max(1, buffer.length - (a1 - a0));
    const out = ensureCtx().createBuffer(buffer.numberOfChannels, len, sr);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const src = buffer.getChannelData(c);
      const dst = out.getChannelData(c);
      dst.set(src.subarray(0, a0), 0);
      dst.set(src.subarray(a1), a0);
    }
    return out;
  }

  // 剪切：询问前后两段是否拼接；否则前/内/后各自独立成列
  function cutSelection() {
    if (!selection || selection.ids.length !== 1) { showToast('选中多段音频时无法剪切'); return; }
    if (selectedTracks().length > 1) { showToast('选中多段音频时无法剪切'); return; }
    if (previewSrcs.length) stopSelPreview();
    const track = trackById(selection.ids[0]);
    if (!track) { showToast('选区已失效，请重新框选'); clearSelectionEl(); return; }
    const idx = tracks.indexOf(track);
    const dur = track.buffer.duration;
    const from = selection.from, to = selection.to;
    stopAllPlayback();
    const joinBack = window.confirm('剪切后，是否把「范围前」和「范围后」的音频直接拼接在一起？\n\n确定 = 前后两段拼成一条（共 2 列）\n取消 = 前、片段、后各自独立成列（共 3 列）');
    let nt = null;
    if (joinBack) {
      const slice = sliceBuffer(track.buffer, from, to);
      track.buffer = removeRange(track.buffer, from, to);
      nt = { id: nextId++, name: stripExt(track.name) + '_片段', buffer: slice, selected: true, pps: null, scrollPx: 0 };
      tracks.splice(idx + 1, 0, nt);
    } else {
      const parts = [];
      if (from > 0.05) parts.push({ name: stripExt(track.name) + '_前', buffer: sliceBuffer(track.buffer, 0, from) });
      parts.push({ name: stripExt(track.name) + '_片段', buffer: sliceBuffer(track.buffer, from, to), sel: true });
      if (dur - to > 0.05) parts.push({ name: stripExt(track.name) + '_后', buffer: sliceBuffer(track.buffer, to, dur) });
      const inserted = parts.map(function (p) {
        return { id: nextId++, name: p.name, buffer: p.buffer, selected: !!p.sel, pps: null, scrollPx: 0 };
      });
      tracks.splice.apply(tracks, [idx, 1].concat(inserted));
      nt = inserted.filter(function (p) { return p.selected; })[0] || null;
    }
    clearSelectionEl();
    cursorT = 0;
    renderTracks();
    pushHistory();
    showToast(joinBack ? '已剪切：前后两段已拼接' : '已剪切：前 / 片段 / 后 各自独立成列');
  }

  // 复制：范围内音频生成新轨道（插在原轨道后一位），原音频完整保留
  function copySelection() {
    if (!selection || selection.ids.length !== 1) { showToast('选中多段音频时无法复制'); return; }
    if (previewSrcs.length) stopSelPreview();
    const track = trackById(selection.ids[0]);
    if (!track) { showToast('选区已失效，请重新框选'); clearSelectionEl(); return; }
    const idx = tracks.indexOf(track);
    const slice = sliceBuffer(track.buffer, selection.from, selection.to);
    tracks.splice(idx + 1, 0, { id: nextId++, name: stripExt(track.name) + '_副本', buffer: slice, selected: false, pps: null, scrollPx: 0 });
    clearSelectionEl();
    renderTracks();
    pushHistory();
    showToast('已复制选区为新轨道（原音频完整保留）');
  }

  // 两段 buffer 首尾拼接
  function concatBuffers(a, b) {
    const ctx = ensureCtx();
    const out = ctx.createBuffer(a.numberOfChannels, a.length + b.length, a.sampleRate);
    for (let c = 0; c < out.numberOfChannels; c++) {
      out.getChannelData(c).set(a.getChannelData(c), 0);
      out.getChannelData(c).set(b.getChannelData(c), a.length);
    }
    return out;
  }

  let previewSrcs = [];
  let selPlay = null;      // { ctx, t0, from, to, loop }：选区播放状态
  let selRaf = 0;
  let selCursorEls = [];

  // 停止选区播放：停源 + 清选区内光标 + 恢复主光标
  function stopSelPreview() {
    previewSrcs.forEach(function (s) {
      try { s.stop(); } catch (e) {}
      try { s.disconnect(); } catch (e) {}
    });
    previewSrcs = [];
    selPlay = null;
    if (selRaf) { cancelAnimationFrame(selRaf); selRaf = 0; }
    selCursorEls.forEach(function (el) { el.remove(); });
    selCursorEls = [];
    renderPlayheads();
  }

  // 选区播放光标：每条选区轨道一根，只在选区范围内移动（循环则到尾跳回头）
  function buildSelCursor() {
    selCursorEls.forEach(function (el) { el.remove(); });
    selCursorEls = [];
    if (!selPlay || !selection) return;
    selection.ids.forEach(function (id) {
      const t = trackById(id);
      const row = tracksContainer.querySelector('.track-row[data-id="' + id + '"]');
      if (!t || !row) return;
      const el = document.createElement('div');
      el.className = 'playhead-seg';
      el.style.top = row.offsetTop + 'px';
      el.style.height = row.offsetHeight + 'px';
      el.style.left = (LABEL_W + selPlay.from * trackPps(t) - (t.scrollPx || 0)) + 'px';
      playheadLayer.appendChild(el);
      selCursorEls.push(el);
    });
    cancelAnimationFrame(selRaf);
    selRaf = requestAnimationFrame(updateSelCursor);
  }

  function updateSelCursor() {
    if (!selPlay) { selRaf = 0; return; }
    const elapsed = Math.max(0, selPlay.ctx.currentTime - selPlay.t0);
    let pos = selPlay.from + elapsed;
    const len = Math.max(0.05, selPlay.to - selPlay.from);
    if (selPlay.loop) pos = selPlay.from + ((pos - selPlay.from) % len);
    else pos = Math.min(pos, selPlay.to);
    pos = Math.min(pos, maxDuration());
    // 各轨道按自己的缩放与滚动偏移定位光标（与 selection.ids 顺序对应）
    selection.ids.forEach(function (id, i) {
      const t = trackById(id);
      const el = selCursorEls[i];
      if (t && el) el.style.left = (LABEL_W + pos * trackPps(t) - (t.scrollPx || 0)) + 'px';
    });
    selRaf = requestAnimationFrame(updateSelCursor);
  }

  // 播放选区：多轨选区时各轨道同时播放各自对应范围
  function playSelection(loop) {
    if (!selection) return;
    stopSelPreview();
    if (isPlaying) stopPlay(); // 播放互斥：选区播放优先，停掉主播放
    const ctx = ensureCtx();
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    const t0 = ctx.currentTime + 0.03;
    selPlay = { ctx: ctx, t0: t0, from: selection.from, to: selection.to, loop: loop };
    selection.ids.forEach(function (id) {
      const track = trackById(id);
      if (!track) return;
      const dur = track.buffer.duration;
      const s = Math.min(selection.from, dur);
      const en = Math.min(selection.to, dur);
      if (en - s < 0.02) return; // 该轨短于选区起点，跳过
      const src = ctx.createBufferSource();
      src.buffer = track.buffer;
      src.connect(ctx.destination);
      if (loop) { src.loop = true; src.loopStart = s; src.loopEnd = en; src.start(t0, s); }
      else { src.start(t0, s, en - s); }
      previewSrcs.push(src);
    });
    if (!previewSrcs.length) { selPlay = null; return; }
    // 非循环：最后一个源播完 → 停止并恢复主光标
    const batch = t0;
    previewSrcs[previewSrcs.length - 1].onended = function () {
      if (!selPlay || selPlay.t0 !== batch) return; // 已被新播放取代
      stopSelPreview();
    };
    renderPlayheads();  // 先隐藏主光标
    buildSelCursor();   // 再放置选区内光标（唯一光标）
  }

  /* 拖拽剪切：把选区拖到轨道间隙新建轨道 */
  let cutDrag = null;
  function startSelectionDrag(e) {
    cutDrag = { startY: e.clientY, sourceId: selection.ids[0] };
    window.addEventListener('pointermove', onCutMove);
    window.addEventListener('pointerup', onCutUp);
    window.addEventListener('pointercancel', onCutUp);
  }
  function onCutMove(e) {
    if (!cutDrag) return;
    // 简单指示：跟随鼠标的提示已由 CSS 光标体现，此处不再画拖拽指示
  }
  function onCutUp(e) {
    if (!cutDrag) return;
    const drag = cutDrag;
    cutDrag = null;
    window.removeEventListener('pointermove', onCutMove);
    window.removeEventListener('pointerup', onCutUp);
    window.removeEventListener('pointercancel', onCutUp);
    if (Math.abs(e.clientY - drag.startY) < 8) return; // 没拖够距离，忽略
    cutSelection();
  }

  /* ---------------- 导出（多选弹窗 → 确认 → 混音所选） ---------------- */
  const exportModal = document.getElementById('export-modal');
  const exportCheckList = document.getElementById('export-check-list');
  const exportStep1 = document.getElementById('export-modal-step1');
  const exportStep2 = document.getElementById('export-modal-step2');
  const exportConfirmText = document.getElementById('export-confirm-text');
  const btnExportCancel = document.getElementById('btn-export-cancel');
  const btnExportNext = document.getElementById('btn-export-next');
  const btnExportBack = document.getElementById('btn-export-back');
  const btnExportConfirm = document.getElementById('btn-export-confirm');
  let exportPendingIds = [];

  function openExportModal() {
    const vis = visibleTracks();
    if (!vis.length) return;
    if (vis.length > 1) {
      // 多文件：先勾选要导出的音频（默认一个都不选，可用顶部「全选」一键勾选/取消）
      exportCheckList.innerHTML = '';
      const masterLabel = document.createElement('label');
      masterLabel.className = 'export-check-item export-check-all';
      const master = document.createElement('input');
      master.type = 'checkbox';
      const masterSpan = document.createElement('span');
      masterSpan.textContent = '全选';
      masterLabel.appendChild(master);
      masterLabel.appendChild(masterSpan);
      exportCheckList.appendChild(masterLabel);
      const itemBoxes = [];
      const syncMaster = function () {
        master.checked = itemBoxes.length > 0 && itemBoxes.every(function (b) { return b.checked; });
      };
      master.addEventListener('change', function () {
        itemBoxes.forEach(function (b) { b.checked = master.checked; });
      });
      vis.forEach(function (t) {
        const lab = document.createElement('label');
        lab.className = 'export-check-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'export-item-check';
        cb.checked = false; // 默认初始状态：一个都不选
        cb.dataset.id = String(t.id);
        cb.addEventListener('change', syncMaster);
        lab.appendChild(cb);
        const span = document.createElement('span');
        span.textContent = t.name;
        span.title = t.name;
        lab.appendChild(span);
        exportCheckList.appendChild(lab);
        itemBoxes.push(cb);
      });
      exportStep1.hidden = false;
      exportStep2.hidden = true;
    } else {
      // 单文件：跳过选择，直接确认
      exportPendingIds = [vis[0].id];
      exportConfirmText.textContent = '确定要导出「' + vis[0].name + '」吗？';
      exportStep1.hidden = true;
      exportStep2.hidden = false;
    }
    exportModal.hidden = false;
  }

  btnExportCancel.addEventListener('click', function () { exportModal.hidden = true; });
  btnExportBack.addEventListener('click', function () {
    if (tracks.length > 1) {
      exportStep2.hidden = true;
      exportStep1.hidden = false;
    } else {
      exportModal.hidden = true;
    }
  });
  btnExportNext.addEventListener('click', function () {
    exportPendingIds = [];
    const boxes = exportCheckList.querySelectorAll('.export-item-check');
    for (const cb of boxes) {
      if (cb.checked) exportPendingIds.push(parseFloat(cb.dataset.id));
    }
    if (!exportPendingIds.length) { showToast('请至少选择一个音频'); return; }
    exportConfirmText.textContent = '确定要导出所选 ' + exportPendingIds.length + ' 段音频的混音吗？';
    exportStep1.hidden = true;
    exportStep2.hidden = false;
  });
  btnExportConfirm.addEventListener('click', function () {
    exportModal.hidden = true;
    doExport(exportPendingIds.slice());
  });

  btnExport.addEventListener('click', openExportModal);

  async function doExport(ids) {
    const list = ids.map(trackById).filter(Boolean);
    if (!list.length) return;
    stopAllPlayback();
    btnExport.disabled = true;
    exportStatus.textContent = '正在渲染…';
    exportOverlay.hidden = false; // 与蒙版保存同款进度遮罩
    if (exportOverlayBar) exportOverlayBar.classList.add('indeterminate');
    if (exportOverlayStatus) exportOverlayStatus.textContent = '正在渲染…';
    if (exportOverlayFill) exportOverlayFill.style.width = '0%';
    try {
      const rendered = await renderAllMix(list);
      const left = rendered.getChannelData(0);
      const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left;
      const wantMp3 = typeof window.lamejs !== 'undefined';
      let blob; let ext = 'wav';
      if (wantMp3) {
        if (exportOverlayBar) exportOverlayBar.classList.remove('indeterminate'); // 编码阶段有真实百分比
        try {
          blob = await Exporter.encodeMp3Async(left, right, rendered.sampleRate, function (p) {
            const pct = Math.round(p * 100);
            if (exportOverlayFill) exportOverlayFill.style.width = pct + '%';
            const msg = '正在编码 ' + pct + '%';
            if (exportOverlayStatus) exportOverlayStatus.textContent = msg;
            exportStatus.textContent = msg;
          });
          ext = 'mp3';
        }
        catch (err) { blob = Exporter.encodeWav(left, right, rendered.sampleRate); }
      } else {
        blob = Exporter.encodeWav(left, right, rendered.sampleRate);
      }
      const filename = list.length === 1 ? stripExt(list[0].name) : '混音导出';
      if (exportOverlayStatus) exportOverlayStatus.textContent = '正在保存…';
      Exporter.download(blob, filename + '.' + ext);
      exportStatus.textContent = ext === 'mp3' ? '导出完成' : '已导出 WAV（MP3 编码不可用）';
    } catch (e) {
      console.error(e);
      exportStatus.textContent = '导出失败：' + (e && e.message ? e.message : e);
    } finally {
      exportOverlay.hidden = true;
      if (exportOverlayBar) exportOverlayBar.classList.remove('indeterminate');
      btnExport.disabled = false;
    }
  }

  async function renderAllMix(list) {
    list = list || tracks;
    let dur = 0;
    list.forEach(function (t) { if (t.buffer.duration > dur) dur = t.buffer.duration; });
    const sr = list[0].buffer.sampleRate;
    const len = Math.max(1, Math.ceil(dur * sr));
    const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offline = new Ctor(2, len, sr);
    list.forEach(function (t) {
      const src = offline.createBufferSource();
      src.buffer = t.buffer;
      src.connect(offline.destination);
      src.start(0);
    });
    return await offline.startRendering();
  }

  function updateExportBtn() { btnExport.disabled = visibleTracks().length === 0; }

  /* ---------------- 快捷键 ---------------- */
  document.addEventListener('keydown', function (e) {
    if (studio.hidden) return;
    const t = e.target;
    const isRange = t && t.tagName === 'INPUT' && t.type === 'range';
    const inText = t && !isRange && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t && t.isContentEditable));
    if (inText) return;

    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault(); selectAll(); return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (selection) { e.preventDefault(); deleteSelection(); return; }
      // 删除选中的轨道（与删除按钮同样先确认）
      const sel = selectedTracks();
      if (sel.length) {
        e.preventDefault();
        askDelete(sel);
        return;
      }
    }
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      // 选区存在且其轨道仍有效 → 空格控制选区播放；否则控制主播放（防残留选区劫持）
      const selValid = selection && selection.ids.every(function (id) { return trackById(id); });
      if (selValid) {
        if (previewSrcs.length) stopSelPreview();
        else playSelection(e.shiftKey);
        return;
      }
      togglePlay(); // 播放/暂停（继续）
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.repeat) { e.preventDefault(); return; } // 屏蔽系统连发，用自制节流
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      nudgePlay(dir * 5); // 立即步进一次
      startArrowRepeat(dir);
      return;
    }
    if (e.key === 'Escape') {
      if (selectMode) { exitSelectMode(); return; }
      if (selection) { clearSelectionEl(); return; }
      clearSelection();
    }
  });

  // 长按左右方向键：400ms 后以 120ms/步 连续移动光标（±5s/步）
  let arrowRep = null;
  function stopArrowRepeat() {
    if (arrowRep) {
      clearTimeout(arrowRep.t);
      clearInterval(arrowRep.i);
      arrowRep = null;
    }
  }
  function startArrowRepeat(dir) {
    stopArrowRepeat();
    arrowRep = {};
    arrowRep.t = setTimeout(function () {
      arrowRep.i = setInterval(function () { nudgePlay(dir * 5); }, 120);
    }, 400);
  }
  document.addEventListener('keyup', function (e) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') stopArrowRepeat();
  });
  window.addEventListener('blur', stopArrowRepeat);

  // 点击空白处：轨道区空白只取消轨道选中（保留拖拽选区）；其他空白全部取消；均解锁换序
  document.addEventListener('click', function (e) {
    if (studio.hidden) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (recordMode) { // 记录模式中点空白 = 退出记录并清掉预览框（下次记录不残留）
      recordMode = null;
      clearRecordEls();
      showToast('已退出记录模式');
    }
    if (t.closest('.track-row, .selection-range, .selection-tools, #studio-toolbar, .studio-controls, button, input, a, label, canvas')) return;
    reorderLocked = false;
    if (t === tracksContainer || t === tracksWrap || t === playheadLayer) { clearSelection(); return; }
    clearSelection();
    clearSelectionEl();
  });

  /* ---------------- 退出确认弹窗（供所有子界面共用） ---------------- */
  const exitModal = document.getElementById('exit-modal');
  const btnExitStay = document.getElementById('btn-exit-stay');
  const btnExitLeave = document.getElementById('btn-exit-leave');
  const btnExitSave = document.getElementById('btn-exit-save');
  let exitCb = null;
  let exitSaveCb = null;
  // onLeave：不保存直接退；onSaveExit：先渲染保存（走替换/保留弹窗）再回主界面
  window.confirmExit = function (onLeave, onSaveExit) {
    exitCb = onLeave || null;
    exitSaveCb = onSaveExit || null;
    btnExitSave.hidden = !onSaveExit;
    exitModal.hidden = false;
  };
  btnExitStay.addEventListener('click', function () {
    exitModal.hidden = true;
    exitCb = null;
    exitSaveCb = null;
  });
  btnExitLeave.addEventListener('click', function () {
    exitModal.hidden = true;
    const cb = exitCb;
    exitCb = null;
    exitSaveCb = null;
    if (cb) cb();
  });
  btnExitSave.addEventListener('click', function () {
    exitModal.hidden = true;
    const cb = exitSaveCb;
    exitCb = null;
    exitSaveCb = null;
    if (cb) cb();
  });

  /* ---------------- 保存选择弹窗（替换/保留原音频，三子界面共用） ---------------- */
  const saveModal = document.getElementById('save-modal');
  const btnSaveKeep = document.getElementById('btn-save-keep');
  const btnSaveReplace = document.getElementById('btn-save-replace');
  let saveCb = null;
  // 子界面渲染完成后调用：用户选「替换」→ 删 replacedIds 并插入结果；「保留」→ 只插入结果
  window.openSaveChoice = function (buffer, name, replacedIds) {
    saveCb = function (replace) {
      window.Studio.onChildSave(buffer, name, replace ? (replacedIds || []) : []);
    };
    saveModal.hidden = false;
  };
  btnSaveReplace.addEventListener('click', function () {
    saveModal.hidden = true;
    const cb = saveCb; saveCb = null;
    if (cb) cb(true);
  });
  btnSaveKeep.addEventListener('click', function () {
    saveModal.hidden = true;
    const cb = saveCb; saveCb = null;
    if (cb) cb(false);
  });
  const btnSaveCancel = document.getElementById('btn-save-cancel');
  btnSaveCancel.addEventListener('click', function () {
    // 取消：不替换也不新增，关闭弹窗即可——子界面的当前设计从未被改动
    saveModal.hidden = true;
    saveCb = null;
  });

  /* ---------------- 初始化 ---------------- */
  buildSelectionTools();
  setupUpload();
  renderTracks();
  pushHistory();

  // 功能栏按钮（常驻）+ 选择模式底部栏；工具栏任一按钮点击后锁定换序
  toolbar.addEventListener('click', function () { reorderLocked = true; }, true);
  btnToolMask.addEventListener('click', function () { onTool('mask'); });
  btnToolSplice.addEventListener('click', function () { onTool('splice'); });
  btnToolOverlay.addEventListener('click', function () { onTool('overlay'); });
  btnSelectCancel.addEventListener('click', exitSelectMode);
  btnSelectConfirm.addEventListener('click', confirmSelect);

  // 删除按钮 + 删除确认弹窗（高亮时再次点击 = 退出删除模式，与其他工具按钮一致）
  btnToolDelete.addEventListener('click', function () {
    if (selectMode === 'delete') { exitSelectMode(); return; }
    const sel = selectedTracks();
    if (sel.length) { askDelete(sel); return; }
    enterSelectMode('delete');
  });
  btnDelCancel.addEventListener('click', function () {
    deleteModal.hidden = true;
    deleteCbRef.cb = null;
  });
  btnDelConfirm.addEventListener('click', function () {
    deleteModal.hidden = true;
    const cb = deleteCbRef.cb;
    deleteCbRef.cb = null;
    if (cb) cb();
  });

  // 播放按钮（独立键 + 工具栏键）+ ±5s 按钮
  btnPlay.addEventListener('click', togglePlay);
  btnToolbarReplay.addEventListener('click', replayFromStart);
  btnBack5.addEventListener('click', function () { nudgePlay(-5); });
  btnFwd5.addEventListener('click', function () { nudgePlay(5); });
  btnBack30.addEventListener('click', function () { nudgePlay(-30); });
  btnFwd30.addEventListener('click', function () { nudgePlay(30); });

  // 倍速播放（1x/2x/3x）：切换时保持当前光标位置
  let playSpeed = 1;
  function setPlaySpeed(v) {
    const wasPlaying = isPlaying;
    if (wasPlaying) pauseCapture();
    stopPlay();
    playSpeed = v;
    btnSpeed1.classList.toggle('active', v === 1);
    btnSpeed2.classList.toggle('active', v === 2);
    btnSpeed3.classList.toggle('active', v === 3);
    if (wasPlaying) startPlay();
    else renderPlayheads();
  }
  btnSpeed1.addEventListener('click', function () { setPlaySpeed(1); });
  btnSpeed2.addEventListener('click', function () { setPlaySpeed(2); });
  btnSpeed3.addEventListener('click', function () { setPlaySpeed(3); });

  // 适应当前窗口：撤销 ctrl+滚轮的细致调节，所有波形复原为铺满横条
  btnFitWindow.addEventListener('click', function () {
    if (!tracks.length) return;
    fitZoom();
    layoutTracks();
    drawAllWaves();
    renderPlayheads();
    if (selPlay && selection) buildSelCursor();
    if (selection) updateSelectionEl();
    showToast('已适应当前窗口');
  });

  // 对齐时间轴：所有音频以最长者为标准铺满（需无选中）
  btnFitAlign.addEventListener('click', function () {
    if (!tracks.length) return;
    if (selectedTracks().length) { showToast('对齐时间轴需要先取消选中'); return; }
    tracks.forEach(function (t) { t.pps = null; t.scrollPx = 0; });
    const avail = Math.max(100, tracksWrap.clientWidth - LABEL_W - 2);
    pxPerSec = clamp(avail / Math.max(0.001, maxDuration()), MIN_PPS, MAX_PPS);
    layoutTracks();
    drawAllWaves();
    renderPlayheads();
    if (selection) updateSelectionEl();
    showToast('已对齐时间轴（以最长音频为标准）');
  });

  // 全选按钮：全选状态时再按 = 取消全选（只针对可见音频）
  btnSelectAll.addEventListener('click', function () {
    const vis = visibleTracks();
    if (vis.length && vis.every(function (x) { return x.selected; })) clearSelection();
    else selectAll();
  });

  // 上移/下移选中音频
  btnMoveUp.addEventListener('click', function () { moveSelected(-1); });
  btnMoveDown.addEventListener('click', function () { moveSelected(1); });

  // 隐藏：进入勾选模式（所有隐藏 + 未隐藏的音频都显示出来，前面带多选框，默认全不勾）；
  // 勾选 = 隐藏，取消勾选已隐藏的 = 恢复显示；没动过的文件保持原状
  btnToolHide.addEventListener('click', function () {
    if (selectMode === 'hide') { exitSelectMode(); return; }
    enterSelectMode('hide');
  });

  // 显示过滤三选一（必须且只能勾选一个）：所有音频文件 / 未隐藏 / 隐藏文件
  function syncFilterChecks() {
    filterBoxes.forEach(function (cb) { cb.checked = cb.dataset.filter === hideFilter; });
  }
  filterBoxes.forEach(function (cb) {
    cb.addEventListener('change', function () {
      if (cb.checked) {
        hideFilter = cb.dataset.filter;
        syncFilterChecks();
        renderTracks();
      } else {
        cb.checked = true; // 三框必须有一个勾：取消当前勾选无效
      }
    });
  });
  syncFilterChecks(); // 初始状态：还没有使用过隐藏 → 勾选「所有音频文件」

  /* ---------------- 右键光标菜单（分割/删除/重复/复制/记录自定义范围） ---------------- */
  const ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctx-menu';
  ctxMenu.hidden = true;
  document.body.appendChild(ctxMenu);
  let ctxTarget = null;
  let ctxSub = null;         // 当前子菜单：null | 'del' | 'rep' | 'copy'
  let recordMode = null;     // 记录自定义范围模式：{ trackId, from } 或 null

  // 删除/重复/复制：前半段 = [0,t]，后半段 = [t, end]
  function delHalf(track, t, front) {
    stopAllPlayback();
    track.buffer = front ? sliceBuffer(track.buffer, t, track.buffer.duration)
                         : sliceBuffer(track.buffer, 0, t);
    cursorT = 0;
    clearSelectionEl();
    renderTracks();
    pushHistory();
    showToast(front ? '已删除前半段' : '已删除后半段');
  }

  function repeatHalf(track, t, front) {
    stopAllPlayback();
    const seg = front ? sliceBuffer(track.buffer, 0, t) : sliceBuffer(track.buffer, t, track.buffer.duration);
    track.buffer = front ? concatBuffers(seg, track.buffer) : concatBuffers(track.buffer, seg);
    clearSelectionEl();
    renderTracks();
    pushHistory();
    showToast(front ? '已在光标后重复前半段' : '已在光标后接上后半段');
  }

  function copyHalf(track, t, front) {
    stopAllPlayback();
    const seg = front ? sliceBuffer(track.buffer, 0, t) : sliceBuffer(track.buffer, t, track.buffer.duration);
    const idx = tracks.indexOf(track);
    tracks.splice(idx + 1, 0, { id: nextId++, name: stripExt(track.name) + (front ? '_前半' : '_后半'), buffer: seg, selected: false, pps: null, scrollPx: 0 });
    clearSelectionEl();
    renderTracks();
    pushHistory();
    showToast(front ? '已复制前半段为新轨道' : '已复制后半段为新轨道');
  }

  // 记录自定义范围：进入时必须暂停（光标不动），播放推进，结束记录即定义选区
  function startRecord(track) {
    stopAllPlayback(); // 不管之前是否在播放都先暂停
    recordMode = { trackId: track.id, from: cursorT };
    updateRecordBox();
    showToast('记录模式已开启：按空格/播放键开始播放，再次右键选「结束记录」');
    renderCtxMenu();
  }

  function endRecord() {
    if (!recordMode) return;
    const track = trackById(recordMode.trackId);
    const from = recordMode.from;
    if (isPlaying) { pauseCapture(); stopPlay(); } // 结束时把播放位置落到光标
    const to = cursorT;
    recordMode = null;
    clearRecordEls();
    if (!track || to - from < 0.05) {
      showToast('记录范围太短，已取消');
      renderCtxMenu();
      return;
    }
    selection = { ids: [track.id], from: Math.min(from, to), to: Math.max(from, to) };
    updateSelectionEl();
    showSelectionTools();
    renderPlayheads();
    showToast('已记录自定义范围（与拖拽选区相同，可播放/删除/剪切）');
    renderCtxMenu();
  }

  function exitRecord() {
    recordMode = null;
    clearRecordEls();
    showToast('已退出记录模式（光标留在当前位置）');
    renderCtxMenu();
  }

  /* 记录模式实时范围预览：自定义范围模式中恒显示（从起点到当前光标）；
     点页面空白处退出记录模式并清框 → 下一次记录不会残留上次的框 */
  const recordEls = [];
  function clearRecordEls() {
    recordEls.forEach(function (el) { el.remove(); });
    recordEls.length = 0;
  }
  function updateRecordBox() {
    clearRecordEls();
    if (!recordMode) return;
    const t = trackById(recordMode.trackId);
    if (!t) return;
    const pos = Math.min(currentPlayPos(), maxDuration());
    const a = Math.min(recordMode.from, pos);
    const b = Math.max(recordMode.from, pos);
    if (b - a < 0.001) return; // 还没拉开距离不画
    const row = tracksContainer.querySelector('.track-row[data-id="' + t.id + '"]');
    if (!row) return;
    const wave = row.querySelector('.track-wave');
    const p = trackPps(t);
    const sc = t.scrollPx || 0;
    const relA = a * p - sc;
    const relB = b * p - sc;
    if (relB < 0 || relA > wave.clientWidth) return; // 视口外不画
    const el = document.createElement('div');
    el.className = 'selection-range record-range';
    el.style.left = Math.max(0, relA) + 'px';
    el.style.width = Math.max(2, Math.min(relB, wave.clientWidth) - Math.max(0, relA)) + 'px';
    el.style.top = '0px';
    el.style.height = '100%';
    wave.appendChild(el);
    recordEls.push(el);
  }

  function renderCtxMenu() {
    let items;
    if (recordMode) {
      items = [
        { label: '结束记录自定义范围', fn: endRecord },
        { label: '✕ 退出记录自定义范围', fn: exitRecord }
      ];
    } else if (ctxSub) {
      const acts = {
        del:  { front: function () { delHalf(ctxTarget.track, ctxTarget.t, true); },  back: function () { delHalf(ctxTarget.track, ctxTarget.t, false); } },
        rep:  { front: function () { repeatHalf(ctxTarget.track, ctxTarget.t, true); }, back: function () { repeatHalf(ctxTarget.track, ctxTarget.t, false); } },
        copy: { front: function () { copyHalf(ctxTarget.track, ctxTarget.t, true); },  back: function () { copyHalf(ctxTarget.track, ctxTarget.t, false); } }
      };
      items = [
        { label: '前半段', fn: acts[ctxSub].front },
        { label: '后半段', fn: acts[ctxSub].back },
        { label: '← 返回', fn: function () { ctxSub = null; renderCtxMenu(); }, keepOpen: true }
      ];
    } else {
      items = [
        { label: '分割', fn: function () { splitTrack(ctxTarget.track, ctxTarget.t); } },
        { label: '删除 ▸', fn: function () { ctxSub = 'del'; renderCtxMenu(); }, keepOpen: true },
        { label: '重复 ▸', fn: function () { ctxSub = 'rep'; renderCtxMenu(); }, keepOpen: true },
        { label: '复制 ▸', fn: function () { ctxSub = 'copy'; renderCtxMenu(); }, keepOpen: true },
        { label: '开始记录自定义范围', fn: function () { startRecord(ctxTarget.track); } }
      ];
    }
    ctxMenu.innerHTML = '';
    items.forEach(function (it) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-item';
      b.textContent = it.label;
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        if (it.keepOpen) { it.fn(); return; } // 子菜单切换保持菜单打开
        ctxMenu.hidden = true;
        ctxSub = null;
        it.fn();
      });
      ctxMenu.appendChild(b);
    });
  }

  tracksWrap.addEventListener('contextmenu', function (e) {
    const hit = hitCursorInfo(e, 10);
    if (!hit || !hit.track) return; // 不在光标附近 → 浏览器默认菜单
    e.preventDefault();
    ctxTarget = { track: hit.track, t: clamp(cursorT, 0, hit.track.buffer.duration) };
    ctxSub = null;
    renderCtxMenu();
    ctxMenu.style.left = e.clientX + 'px';
    ctxMenu.style.top = e.clientY + 'px';
    ctxMenu.hidden = false;
  });
  document.addEventListener('click', function (e) {
    if (!ctxMenu.contains(e.target)) ctxMenu.hidden = true;
  });
  window.addEventListener('blur', function () { ctxMenu.hidden = true; });
  ctxMenu.addEventListener('click', function (e) { e.stopPropagation(); });

  // 分割：前半段留在原轨道，后半段裁切为新轨道（插在原轨道后面一位）
  function splitTrack(track, t) {
    if (t <= 0.05 || t >= track.buffer.duration - 0.05) { showToast('分割点太靠近开头或结尾'); return; }
    stopAllPlayback();
    const idx = tracks.indexOf(track);
    if (idx === -1) return;
    const back = sliceBuffer(track.buffer, t, track.buffer.duration);
    track.buffer = sliceBuffer(track.buffer, 0, t);
    tracks.splice(idx + 1, 0, { id: nextId++, name: stripExt(track.name) + '_后半', buffer: back, selected: false, pps: null, scrollPx: 0 });
    clearSelectionEl();
    cursorT = 0;
    renderTracks();
    pushHistory();
    showToast('已分割：后半段在原音频后面一位');
  }

  /* ---------------- 右键音频信息栏 → 重命名 ---------------- */
  const renameBox = document.createElement('div');
  renameBox.className = 'ctx-menu rename-box';
  renameBox.innerHTML =
    '<p class="rename-title">重命名音频</p>' +
    '<input type="text" class="rename-input" maxlength="80">' +
    '<div class="rename-actions">' +
    '<button type="button" class="btn btn-small" data-act="cancel">取消</button>' +
    '<button type="button" class="btn btn-small btn-primary" data-act="ok">确定</button>' +
    '</div>';
  renameBox.hidden = true;
  document.body.appendChild(renameBox);
  let renameTarget = null;

  tracksContainer.addEventListener('contextmenu', function (e) {
    const label = e.target.closest('.track-label');
    if (!label) return;
    const row = label.closest('.track-row');
    if (!row) return;
    const t = tracks.filter(function (x) { return String(x.id) === row.dataset.id; })[0];
    if (!t) return;
    e.preventDefault();
    e.stopPropagation(); // 不触发光标分割菜单
    renameTarget = t;
    const input = renameBox.querySelector('.rename-input');
    input.value = t.name;
    renameBox.style.left = e.clientX + 'px';
    renameBox.style.top = e.clientY + 'px';
    renameBox.hidden = false;
    input.focus();
    input.select();
  });

  function commitRename() {
    if (!renameTarget) return;
    const v = renameBox.querySelector('.rename-input').value.trim();
    if (v && v !== renameTarget.name) {
      renameTarget.name = v;
      pushHistory();
      renderTracks();
      showToast('已重命名');
    }
    renameBox.hidden = true;
    renameTarget = null;
  }
  renameBox.querySelector('[data-act="ok"]').addEventListener('click', commitRename);
  renameBox.querySelector('[data-act="cancel"]').addEventListener('click', function () {
    renameBox.hidden = true;
    renameTarget = null;
  });
  renameBox.querySelector('.rename-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') commitRename();
    if (e.key === 'Escape') { renameBox.hidden = true; renameTarget = null; }
  });
  document.addEventListener('click', function (e) {
    if (!renameBox.hidden && !renameBox.contains(e.target)) {
      renameBox.hidden = true;
      renameTarget = null;
    }
  });

  // 全窗口拖拽导入：主界面生效，子界面提示
  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    dragDepth = 0;
    tracksWrap.classList.remove('drag-over');
    if (!e.dataTransfer.files || !e.dataTransfer.files.length) return;
    if (studio.hidden) { showToast('请先返回主界面再导入音频'); return; }
    handleFiles(e.dataTransfer.files);
  });

  // 拖拽悬停高亮：文件拖入窗口时给轨道区加琥珀虚线描边
  let dragDepth = 0;
  function dragHasFiles(e) {
    const types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1;
  }
  window.addEventListener('dragenter', function (e) {
    if (!dragHasFiles(e)) return;
    dragDepth++;
    if (studio && !studio.hidden) tracksWrap.classList.add('drag-over');
  });
  window.addEventListener('dragleave', function () {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) tracksWrap.classList.remove('drag-over');
  });

  // 窗口尺寸变化：保留各轨缩放与滚动位置，仅重新布局与重绘
  window.addEventListener('resize', function () {
    if (!tracks.length) return;
    layoutTracks();
    drawAllWaves();
    renderPlayheads();
    if (selPlay && selection) buildSelCursor();
    if (selection) updateSelectionEl();
  });
})();
