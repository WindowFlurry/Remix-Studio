/* ============================================================
 * Remix Studio — 蒙版子界面
 * 从主界面接收一段音频，套用预设蒙版 + 微调，保存并继续回写
 * ============================================================ */
(function () {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  const pageMask = document.getElementById('page-mask');

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

  /* ---------------- 蒙版引擎与 DOM ---------------- */
  const engine = new AudioEngine();
  let maskTrackId = null;
  let maskDirty = false; // 是否做过任何调整（决定退出时是否询问）

  const playbackSection = document.getElementById('playback-section');
  const btnPlay = document.getElementById('btn-play');
  const btnPause = document.getElementById('btn-pause');
  const btnReplay = document.getElementById('btn-replay');
  const seek = document.getElementById('seek');
  const timeCurrent = document.getElementById('time-current');
  const timeTotal = document.getElementById('time-total');

  const metroSwitch = document.getElementById('metro-switch');
  const metroFactorGroup = document.getElementById('metro-factor-group');
  const metroBpmLabel = document.getElementById('metro-bpm-label');
  const metroFactorBtns = Array.prototype.slice.call(document.querySelectorAll('.metro-factor-btn'));
  let metroFactor = 1;

  const maskSpeed = document.getElementById('mask-speed');
  const maskSpeedVal = document.getElementById('mask-speed-val');
  const maskSpeedReset = document.getElementById('mask-speed-reset');
  const maskBpmLabel = document.getElementById('mask-bpm-label');
  const fadeStrip = document.getElementById('mask-fade-strip');
  let curSpeed = 1;    // 蒙版内倍速（滑块，整段生效）
  let fadeInSec = 0;   // 淡入时长（长条左圆点，0–10s，默认 0 = 不淡入）
  let fadeOutSec = 0;  // 淡出时长（长条右圆点，0–10s，默认 0 = 不淡出）
  let fadeEls = null;

  const surroundSection = document.getElementById('surround-section');
  const surroundState = document.getElementById('surround-state');
  const surroundSpeed = document.getElementById('surround-speed');
  const surroundSpeedVal = document.getElementById('surround-speed-val');
  const surroundSpeedReset = document.getElementById('surround-speed-reset');
  const surroundRange = document.getElementById('surround-range');
  const surroundRangeVal = document.getElementById('surround-range-val');
  const surroundRangeReset = document.getElementById('surround-range-reset');

  const tweakSection = document.getElementById('tweak-section');
  const tweakPresetName = document.getElementById('tweak-preset-name');
  const tweakGroup = document.getElementById('tweak-group');
  const presetGrid = document.getElementById('preset-grid');

  const mixStrength = document.getElementById('mix-strength');
  const mixVal = document.getElementById('mix-val');
  const mixReset = document.getElementById('mix-reset');

  const maskFilesCard = document.getElementById('mask-files-card');
  const maskFileName = document.getElementById('mask-file-name');
  const maskFileDur = document.getElementById('mask-file-dur');
  const exportSection = document.getElementById('export-section');
  const btnMaskSave = document.getElementById('btn-mask-save');
  const mixRow = document.getElementById('mix-row');
  const btnReverse = document.getElementById('btn-reverse');
  const exportOverlay = document.getElementById('export-overlay');
  const exportStatus = document.getElementById('export-status');
  const exportFill = document.getElementById('export-fill');
  const exportBar = document.querySelector('#export-overlay .overlay-bar');
  const toast = document.getElementById('toast');

  const presetButtons = {};

  /* 滑块数值点击输入（全站共用组件）：进度条额外派发 change 触发真正跳转 */
  if (window.attachValueEditor) {
    attachValueEditor(maskSpeedVal, maskSpeed);
    attachValueEditor(mixVal, mixStrength);
    attachValueEditor(surroundSpeedVal, surroundSpeed);
    attachValueEditor(surroundRangeVal, surroundRange);
    attachValueEditor(timeCurrent, seek, { dispatch: ['input', 'change'] });
  }

  let toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 1800);
  }

  /* ---------------- 蒙版界面加载（从主界面接收音频） ---------------- */
  window.MaskStudio = {
    open: function (name, buffer, trackId) {
      maskTrackId = trackId;
      maskDirty = false; // 新会话：无操作
      engine.setSpeed(1); // 防跨会话倍速残留
      engine.loadBuffer(buffer, name);
      afterLoadUI(name);
    }
  };

  function afterLoadUI(name) {
    engine.clearPreset();
    resetTweakSliders();
    tweakSection.hidden = false;
    tweakPresetName.textContent = '原声';
    setActivePreset(null);
    if (mixRow) mixRow.hidden = true; // 原声无效果强度

    playbackSection.hidden = false;
    exportSection.hidden = false;

    seek.disabled = false;
    seek.max = engine.duration;
    seek.value = 0;
    timeCurrent.textContent = formatTime(0);
    timeTotal.textContent = formatTime(engine.duration);

    updateUI();
    metroSwitch.checked = false;
    metroFactor = 1;
    metroFactorBtns.forEach(function (x) { x.classList.toggle('active', x.dataset.factor === '1'); });
    curSpeed = 1;
    maskSpeed.value = '1';
    maskSpeedVal.textContent = '1.00x';
    maskSpeedReset.hidden = true;
    fadeInSec = 0;
    fadeOutSec = 0;
    engine.setFades(fadeInSec, fadeOutSec);
    if (fadeEls) fadeEls.refresh();
    surroundSpeed.value = 0;
    surroundRange.value = 0;
    updateSurround();
    surroundSection.hidden = false;
    updateMaskFilesUI();
    syncTransport();
    updateBpmLabels();
    maskDirty = false; // 新会话初始状态干净（上面 updateSurround 会置脏）
  }

  function syncTransport() {
    const loaded = engine.duration > 0;
    btnPlay.disabled = !loaded || engine.isPlaying;
    btnPause.disabled = !loaded || !engine.isPlaying;
    btnReplay.disabled = !loaded;
  }

  function updateUI() {
    const loaded = engine.duration > 0;
    Object.keys(presetButtons).forEach(function (k) {
      presetButtons[k].disabled = !loaded;
    });
  }

  function updateMaskFilesUI() {
    const has = engine.duration > 0;
    maskFilesCard.hidden = !has;
    if (has) {
      maskFileName.textContent = engine.originalName;
      maskFileDur.textContent = formatTime(engine.duration);
    }
  }

  /* ---------------- 预设按钮 ---------------- */
  function renderPresets() {
    const clearBtn = document.createElement('button');
    clearBtn.className = 'preset-card preset-card--clear';
    clearBtn.innerHTML = '<span class="preset-name">原声</span>';
    clearBtn.addEventListener('click', onClearPreset);
    presetGrid.appendChild(clearBtn);
    presetButtons._clear = clearBtn;

    REMIX_PRESETS.forEach(function (p) {
      const btn = document.createElement('button');
      btn.className = 'preset-card';
      btn.innerHTML = '<span class="preset-name">' + p.name + '</span>';
      btn.addEventListener('click', function () { onPreset(p); });
      presetGrid.appendChild(btn);
      presetButtons[p.id] = btn;
    });
  }

  function setActivePreset(id) {
    Object.keys(presetButtons).forEach(function (k) {
      const active = k === id || (id === null && k === '_clear');
      presetButtons[k].classList.toggle('active', !!active);
    });
  }

  function onPreset(preset) {
    engine.applyPreset(preset);
    resetTweakSliders();
    tweakPresetName.textContent = preset.name;
    setActivePreset(preset.id);
    mixRow.hidden = false; // 原声以外的模板才有效果强度
    maskDirty = true;
  }

  function onClearPreset() {
    engine.clearPreset();
    resetTweakSliders();
    tweakPresetName.textContent = '原声';
    setActivePreset(null);
    mixRow.hidden = true; // 原声无效果强度
    maskDirty = true;
  }

  /* ---------------- 微调滑块 ---------------- */
  const TWEAK_GROUPS = [
    {
      title: '基础调节',
      items: [
        { key: 'muffle', label: '朦胧度', title: '低通滤波器截止频率偏移（0% 更亮 / 100% 更闷）' },
        { key: 'reverb', label: '混响大小', title: '混响湿信号比例（0% 更干 / 100% 混响加倍）' },
        { key: 'warmth', label: '温暖度', title: '谐波饱和程度（0% 干净 / 100% 温暖饱和）' },
        { key: 'echo', label: '回声', title: '延迟回声（50% 无回声 / 100% 明显回声）' },
        { key: 'drift', label: '飘忽感', title: '合唱效果深度（50% 无 / 100% 声音飘忽加宽）' },
        { key: 'width', label: '声场宽度', title: '立体声声场（0% 单声道 / 50% 原始 / 100% 加宽）' }
      ]
    },
    {
      title: 'EQ 均衡器',
      items: [
        { key: 'bass', label: '低频增强', title: '100Hz 以下低频增益（0% 削减 / 100% 增强）' },
        { key: 'mid', label: '中频饱满', title: '500-2000Hz 中频增益（0% 削减 / 100% 增强）' },
        { key: 'treble', label: '高频清晰', title: '4kHz 以上高频增益（0% 削减 / 100% 增强）' },
        { key: 'rumble', label: '低切深度', title: '低频切除（50% 不切除 / 100% 切除更多低频轰鸣）' }
      ]
    }
  ];
  const VOLUME_TWEAK = { key: 'volume', label: '整体音量', title: '整体音量（0% 无声 / 50% 正常 / 100% 稍响）' };
  const tweakInputs = {};

  function buildTweakRow(item) {
    const row = document.createElement('div');
    row.className = 'tweak-row';

    const label = document.createElement('span');
    label.className = 'tweak-label';
    label.textContent = item.label;

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'slider';
    input.min = 0;
    input.max = 1;
    input.step = 0.01;
    input.value = 0.5;
    input.title = item.title;

    const value = document.createElement('span');
    value.className = 'tweak-value';
    value.textContent = '50%';

    // 竖直推子壳：input 原样放进去，由 CSS 旋转 90° 布局；拖动/键盘/事件行为完全不变
    const fader = document.createElement('div');
    fader.className = 'fader';
    fader.appendChild(input);

    row.appendChild(label);
    row.appendChild(fader);
    row.appendChild(value);
    if (window.attachValueEditor) attachValueEditor(value, input); // 数值点击输入
    tweakGroup.appendChild(row);

    input.addEventListener('input', function () {
      const v = parseFloat(input.value);
      value.textContent = Math.round(v * 100) + '%';
      engine.setTweak(item.key, v);
      maskDirty = true;
    });

    // 单滑块重置：偏离初始值(50%)才出现，只重置自己
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'slider-reset';
    resetBtn.textContent = '↺︎';
    resetBtn.title = '重置' + item.label;
    resetBtn.hidden = true;
    resetBtn.addEventListener('click', function () {
      input.value = 0.5;
      input.dispatchEvent(new Event('input'));
    });
    row.appendChild(resetBtn);

    input.addEventListener('input', function () {
      resetBtn.hidden = Math.abs(parseFloat(input.value) - 0.5) < 1e-9;
    });

    return { input: input, value: value, row: row, resetBtn: resetBtn };
  }

  function buildTweaks() {
    const groups = [
      { title: '基础调节', cls: 'grp-basic', items: TWEAK_GROUPS[0].items },
      { title: 'EQ 均衡器', cls: 'grp-eq', items: TWEAK_GROUPS[1].items },
      { title: '音量调节', cls: 'grp-vol', items: [VOLUME_TWEAK] }
    ];
    groups.forEach(function (group, gi) {
      if (gi > 0) {
        const d = document.createElement('div');
        d.className = 'tweak-divider';
        tweakGroup.appendChild(d);
      }
      const title = document.createElement('div');
      title.className = 'tweak-group-title';
      title.textContent = group.title;
      tweakGroup.appendChild(title);
      group.items.forEach(function (item) {
        tweakInputs[item.key] = buildTweakRow(item);
        tweakInputs[item.key].row.classList.add(group.cls);
      });
    });
  }

  function resetTweakSliders() {
    Object.keys(tweakInputs).forEach(function (key) {
      const entry = tweakInputs[key];
      entry.input.value = 0.5;
      entry.value.textContent = '50%';
      if (entry.resetBtn) entry.resetBtn.hidden = true; // 回到初始 → 重置按钮隐藏
    });
    if (mixStrength) {
      mixStrength.value = 0.5;
      mixVal.textContent = '50%';
      if (mixReset) mixReset.hidden = true;
    }
  }

  // 效果强度：0% 旁通 / 50% 预设全量 / 100% 偏激
  mixStrength.addEventListener('input', function () {
    const v = parseFloat(mixStrength.value);
    mixVal.textContent = Math.round(v * 100) + '%';
    engine.setMix(v);
    maskDirty = true;
    mixReset.hidden = v === 0.5; // 回到 50% → 重置按钮隐藏
  });
  mixReset.addEventListener('click', function () {
    mixStrength.value = 0.5;
    mixStrength.dispatchEvent(new Event('input'));
  });

  /* ---------------- 播放控制 ---------------- */
  btnPlay.addEventListener('click', function () { engine.play().then(syncTransport); });
  btnPause.addEventListener('click', function () { engine.pause(); syncTransport(); });
  btnReplay.addEventListener('click', function () { engine.replay().then(syncTransport); });

  let seeking = false;
  seek.addEventListener('input', function () {
    seeking = true;
    timeCurrent.textContent = formatTime(parseFloat(seek.value));
  });
  seek.addEventListener('change', function () {
    const t = parseFloat(seek.value);
    engine.seek(t);
    seeking = false;
    timeCurrent.textContent = formatTime(t);
    syncTransport();
  });

  /* ---------------- BPM 显示（全程可见，随倍速实时更新）与节拍器 ---------------- */
  function effBpm() { return engine.bpm ? engine.bpm * curSpeed : null; }

  function updateBpmLabels() {
    const hasBpm = !!engine.bpm;
    // 一位小数显示：与节拍器实际频率（60/(bpm×倍率×速度)）完全一致，所见即所得
    maskBpmLabel.textContent = hasBpm ? effBpm().toFixed(1) + ' BPM' : '未检测到 BPM';
    metroSwitch.disabled = !hasBpm;
    metroFactorGroup.hidden = !hasBpm || !metroSwitch.checked;
    metroBpmLabel.textContent = (hasBpm && metroSwitch.checked)
      ? '节拍器：' + (effBpm() * metroFactor).toFixed(1) + ' BPM'
      : '';
  }

  metroSwitch.addEventListener('change', function () {
    engine.setMetronome(metroSwitch.checked, metroFactor);
    updateBpmLabels();
  });

  metroFactorBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      metroFactor = parseFloat(b.dataset.factor);
      metroFactorBtns.forEach(function (x) { x.classList.toggle('active', x === b); });
      engine.setMetronome(metroSwitch.checked, metroFactor);
      updateBpmLabels();
    });
  });

  /* ---------------- 倍速（整段生效，实时更新 BPM） ---------------- */
  maskSpeed.addEventListener('input', function () {
    curSpeed = clamp(parseFloat(maskSpeed.value) || 1, 0.5, 1.5);
    maskSpeedVal.textContent = curSpeed.toFixed(2) + 'x';
    engine.setSpeed(curSpeed);
    updateBpmLabels();
    maskDirty = true;
    maskSpeedReset.hidden = curSpeed === 1; // 回到 1.00x → 重置按钮隐藏
  });
  maskSpeedReset.addEventListener('click', function () {
    maskSpeed.value = '1';
    maskSpeed.dispatchEvent(new Event('input'));
  });

  /* ---------------- 3D 环绕（速度=转一圈秒数 / 范围=轨道半径；0=关闭） ---------------- */
  function updateSurround() {
    const sp = clamp(parseFloat(surroundSpeed.value) || 0, 0, 1);
    const rg = clamp(parseFloat(surroundRange.value) || 0, 0, 1);
    surroundSpeedVal.textContent = sp > 0 ? (16 - 12 * sp).toFixed(1) + 's/圈' : '关闭';
    surroundRangeVal.textContent = Math.round(rg * 100) + '%';
    surroundState.textContent = (sp > 0 && rg > 0) ? '环绕中' : '关闭';
    surroundSpeedReset.hidden = !(sp > 0);
    surroundRangeReset.hidden = !(rg > 0);
    engine.setSurround(sp, rg);
    maskDirty = true;
  }
  surroundSpeed.addEventListener('input', updateSurround);
  surroundRange.addEventListener('input', updateSurround);
  surroundSpeedReset.addEventListener('click', function () {
    surroundSpeed.value = 0;
    surroundSpeed.dispatchEvent(new Event('input'));
  });
  surroundRangeReset.addEventListener('click', function () {
    surroundRange.value = 0;
    surroundRange.dispatchEvent(new Event('input'));
  });

  /* ---------------- 空格键 播放/暂停 ---------------- */
  document.addEventListener('keydown', function (e) {
    if (e.key !== ' ' && e.code !== 'Space') return;
    if (e.repeat || e.defaultPrevented) return;
    if (engine.duration <= 0) return;
    if (pageMask.hidden) return;
    const t = e.target;
    const tag = t && t.tagName;
    const inText = (tag === 'INPUT' && t.type !== 'range') || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable);
    if (inText) return;
    e.preventDefault();
    if (engine.isPlaying) { engine.pause(); syncTransport(); }
    else { engine.play().then(syncTransport); }
  });

  /* ---------------- 淡入淡出时长长条（20s 轴，左圆点淡入 / 右圆点淡出，各 0–10s，中点相遇） ---------------- */
  function buildFadeStrip() {
    fadeStrip.innerHTML = '';
    const bar = document.createElement('div');
    bar.className = 'fade-bar';
    bar.innerHTML =
      '<div class="fade-bar-track"></div>' +
      '<div class="fade-bar-fill fade-fill-in"></div>' +
      '<div class="fade-bar-fill fade-fill-out"></div>' +
      '<div class="fade-bar-mid"></div>' +
      '<div class="fade-knob fade-knob-in" title="淡入时长：左右拖动（0–10 秒）"></div>' +
      '<div class="fade-knob fade-knob-out" title="淡出时长：左右拖动（0–10 秒）"></div>';
    const labels = document.createElement('div');
    labels.className = 'fade-bar-labels';
    labels.innerHTML =
      '<span class="fade-label-in"></span>' +
      '<span class="fade-label-out"></span>';
    const note = document.createElement('p');
    note.className = 'fade-bar-note';
    note.textContent = '时长范围 0–10 秒';
    fadeStrip.appendChild(bar);
    fadeStrip.appendChild(labels);
    fadeStrip.appendChild(note);
    const knobIn = bar.querySelector('.fade-knob-in');
    const knobOut = bar.querySelector('.fade-knob-out');
    const fillIn = bar.querySelector('.fade-fill-in');
    const fillOut = bar.querySelector('.fade-fill-out');
    const labelIn = labels.querySelector('.fade-label-in');
    const labelOut = labels.querySelector('.fade-label-out');

    function refresh() {
      fillIn.style.width = (fadeInSec / 20 * 100) + '%';
      knobIn.style.left = (fadeInSec / 20 * 100) + '%';
      const outLeft = (20 - fadeOutSec) / 20 * 100;
      fillOut.style.left = outLeft + '%';
      fillOut.style.width = (100 - outLeft) + '%';
      knobOut.style.left = outLeft + '%';
      labelIn.textContent = '淡入 ' + fadeInSec.toFixed(1) + 's';
      labelOut.textContent = '淡出 ' + fadeOutSec.toFixed(1) + 's';
    }
    function drag(knob, isOut) {
      knob.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        try { knob.setPointerCapture(e.pointerId); } catch (err) {}
        const rect = bar.getBoundingClientRect();
        function move(ev) {
          const x = clamp(ev.clientX - rect.left, 0, rect.width);
          const sec = x / rect.width * 20;
          if (!isOut) fadeInSec = clamp(sec, 0, 10);          // 左圆点限左半轴
          else fadeOutSec = clamp(20 - sec, 0, 10);           // 右圆点限右半轴
          refresh();
          engine.setFades(fadeInSec, fadeOutSec);             // 试听实时淡入淡出
          maskDirty = true;
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
    drag(knobIn, false);
    drag(knobOut, true);
    refresh();
    fadeEls = { refresh: refresh };
  }

  /* ---------------- 保存（保存并继续 / 保存并退出 共用） ---------------- */
  async function saveMask(saveBtn) {
    if (engine.duration <= 0) return;
    engine.stop();
    syncTransport();
    if (saveBtn) saveBtn.disabled = true;
    exportOverlay.hidden = false;
    exportFill.style.width = '0%';
    exportStatus.textContent = '正在渲染…';
    if (exportBar) exportBar.classList.add('indeterminate'); // 渲染阶段无进度事件 → 流光
    try {
      await new Promise(function (r) { setTimeout(r, 30); });
      // 淡入淡出包络由引擎在渲染中排布（与试听完全一致），不再二次叠加
      const buffer = await engine.renderToBuffer();
      const name = stripExt(engine.originalName) + '_蒙版';
      const replaced = maskTrackId ? [maskTrackId] : [];
      exportOverlay.hidden = true;
      window.openSaveChoice(buffer, name, replaced); // 询问替换/保留原音频
    } catch (e) {
      console.error(e);
      exportStatus.textContent = '保存失败：' + (e && e.message ? e.message : e);
      showToast('保存失败');
    } finally {
      if (exportBar) exportBar.classList.remove('indeterminate');
      exportOverlay.hidden = true;
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  btnMaskSave.addEventListener('click', function () { saveMask(btnMaskSave); });

  /* ---------------- 倒放（可逆：再点一次恢复原序） ---------------- */
  let maskReversed = false;
  btnReverse.addEventListener('click', function () {
    if (engine.duration <= 0 || !engine.buffer) return;
    const buf = engine.buffer;
    const out = engine.ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const src = buf.getChannelData(c);
      const dst = out.getChannelData(c);
      for (let i = 0, n = buf.length; i < n; i++) dst[i] = src[n - 1 - i];
    }
    maskReversed = !maskReversed;
    btnReverse.classList.toggle('active', maskReversed);
    const base = stripExt(engine.originalName).replace(/_倒放$/, '');
    engine.loadBuffer(out, base + (maskReversed ? '_倒放' : ''));
    afterLoadUI(engine.originalName);
    maskDirty = true;
    showToast(maskReversed ? '已倒放（再次点击恢复原序）' : '已恢复原序');
  });

  /* ---------------- 返回主界面（有未保存的调整时先确认，含保存并退出） ---------------- */
  document.getElementById('btn-exit-mask').addEventListener('click', function () {
    if (engine.duration > 0 && maskDirty) {
      window.confirmExit(function () {
        engine.stop();
        syncTransport();
        window.Studio.backToStudio();
      }, function () {
        saveMask(null); // 保存并退出：渲染 → 替换/保留弹窗 → 回主界面
      });
      return;
    }
    engine.stop();
    syncTransport();
    window.Studio.backToStudio();
  });

  /* ---------------- 进度显示 ---------------- */
  function updateProgress() {
    if (engine.duration <= 0) return;
    const cur = Math.min(engine.getCurrentTime(), engine.duration);
    if (!seeking) {
      timeCurrent.textContent = formatTime(cur);
      seek.value = cur;
    }
    if (engine.isPlaying && cur >= engine.duration - 0.05) {
      engine.stop();
      seek.value = 0;
      timeCurrent.textContent = formatTime(0);
      syncTransport();
    }
  }

  /* ---------------- 动画循环 ---------------- */
  function animate() {
    requestAnimationFrame(animate);
    if (!pageMask.hidden && !playbackSection.hidden) updateProgress();
  }

  /* ---------------- 初始化 ---------------- */
  renderPresets();
  buildTweaks();
  buildFadeStrip();
  syncTransport();
  animate();
})();
