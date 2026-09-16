/* ============================================================
 * Remix Studio — 音频引擎
 * 预设蒙版 + 微调偏移 + 效果强度 + BPM 检测
 * 纯 Web Audio API 实现
 * ============================================================ */
(function (global) {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* ---------------- 噪声 / 脉冲响应生成 ---------------- */

  function createImpulseResponse(ctx, seconds) {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * seconds));
    const impulse = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.5);
      }
    }
    return impulse;
  }

  // 电台底噪：白噪声
  function createNoiseBuffer(ctx, duration) {
    duration = duration || 2.0;
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * duration);
    const buffer = ctx.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  // 参数平滑过渡
  function ramp(ctx, param, target, timeConstant, immediate) {
    if (immediate) param.value = target;
    else param.setTargetAtTime(target, ctx.currentTime, timeConstant);
  }

  /* ---------------- 预设蒙版 ---------------- */
  // lowpassStages：串联低通级数（1 级≈-12dB/oct，4 级≈-48dB/oct）
  // noiseLevel：线性电平，-18dB≈0.126，-50dB≈0.0032
  const PRESETS = [
    { id: 'fog', name: '朦胧雾气', icon: '🫧',
      lowpassCutoff: 1200, lowpassStages: 1, highpass: 20,
      lowGain: 0, midGain: 0, highGain: 0,
      reverbWet: 0.3, reverbDecay: 0.5, noiseType: null, noiseLevel: 0,
      saturation: 0, chorus: 0, echoWet: 0, echoFeedback: 0, echoTime: 0.35,
      volumeDb: -3 },
    { id: 'radio', name: '深夜电台', icon: '📻',
      lowpassCutoff: 3000, lowpassStages: 1, highpass: 300,
      lowGain: 0, midGain: 0, highGain: 0,
      reverbWet: 0.15, reverbDecay: 1.5, noiseType: 'radio', noiseLevel: 0.0032,
      saturation: 0, chorus: 0, echoWet: 0, echoFeedback: 0, echoTime: 0.35,
      volumeDb: -3 },
    { id: 'rain', name: '雨夜车窗', icon: '🌧️',
      lowpassCutoff: 1200, lowpassStages: 1, highpass: 20,
      lowGain: 0, midGain: 0, highGain: 0,
      reverbWet: 0, reverbDecay: 1.5, noiseType: 'rainfile', noiseLevel: 0.3,
      saturation: 0, chorus: 0, echoWet: 0, echoFeedback: 0, echoTime: 0.35,
      volumeDb: -3 },
    { id: 'hall', name: '大厅回声', icon: '🏛️',
      lowpassCutoff: 20000, lowpassStages: 0, highpass: 20,
      lowGain: 0, midGain: 0, highGain: 0,
      reverbWet: 0.35, reverbDecay: 2.5, noiseType: null, noiseLevel: 0,
      saturation: 0, chorus: 0, echoWet: 0.35, echoFeedback: 0.3, echoTime: 0.35,
      volumeDb: -1 },
    { id: 'bathroom', name: '浴室回声', icon: '🚿',
      lowpassCutoff: 18000, lowpassStages: 1, highpass: 20,
      lowGain: 0, midGain: 4, midFreq: 1200, highGain: -2,
      reverbWet: 0.4, reverbDecay: 1.2, noiseType: null, noiseLevel: 0,
      saturation: 0, chorus: 0, echoWet: 0, echoFeedback: 0, echoTime: 0.35,
      volumeDb: 0 },
    { id: 'space', name: '太空飘浮', icon: '🌌',
      lowpassCutoff: 6500, lowpassStages: 2, highpass: 20,
      lowGain: 0, midGain: 0, highGain: 0,
      reverbWet: 0.6, reverbDecay: 4.0, noiseType: null, noiseLevel: 0,
      saturation: 0, chorus: 0.5, echoWet: 0, echoFeedback: 0, echoTime: 0.35,
      volumeDb: -6 }
  ];

  // 无蒙版（原声）的中性参数
  const NEUTRAL_PARAMS = {
    lowpassCutoff: 20000, lowpassStages: 0, highpass: 20,
    lowGain: 0, midGain: 0, midFreq: 1000, highGain: 0,
    reverbWet: 0, reverbDecay: 1.5, noiseType: null, noiseLevel: 0,
    saturation: 0, chorus: 0, echoWet: 0, echoFeedback: 0, echoTime: 0.35,
    volumeDb: 0
  };

  /* ---------------- 音频图构建 ---------------- */
  // 固定搭建一次图，applyParams 负责把所有节点调到目标参数
  // getRainBuffer：返回雨声 buffer（可能为 null）
  // noiseFollowsPlay：true = 在线图，噪声由引擎按播放状态同步（未播放不出声）
  function createGraph(ctx, getRainBuffer, noiseFollowsPlay) {
    const input = ctx.createGain();

    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass'; highpass.frequency.value = 20;

    const lowpass = [];
    for (let i = 0; i < 4; i++) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 20000; lp.Q.value = 0.7;
      lowpass.push(lp);
    }

    const lowShelf = ctx.createBiquadFilter();
    lowShelf.type = 'lowshelf'; lowShelf.frequency.value = 200; lowShelf.gain.value = 0;
    const midPeak = ctx.createBiquadFilter();
    midPeak.type = 'peaking'; midPeak.frequency.value = 1000; midPeak.Q.value = 0.8; midPeak.gain.value = 0;
    const highShelf = ctx.createBiquadFilter();
    highShelf.type = 'highshelf'; highShelf.frequency.value = 2000; highShelf.gain.value = 0;

    const shaper = ctx.createWaveShaper();
    shaper.oversample = '2x';
    shaper.curve = null; // null = 线性（无失真）

    // 合唱：短延迟 + LFO 调制
    const chorusDelay = ctx.createDelay(1.0); chorusDelay.delayTime.value = 0.02;
    const chorusLfo = ctx.createOscillator(); chorusLfo.frequency.value = 0.5;
    const chorusLfoGain = ctx.createGain(); chorusLfoGain.gain.value = 0;
    chorusLfo.connect(chorusLfoGain); chorusLfoGain.connect(chorusDelay.delayTime);
    chorusLfo.start();
    const chorusWet = ctx.createGain(); chorusWet.gain.value = 0;

    // 混响（并联）
    const convolver = ctx.createConvolver();
    convolver.buffer = createImpulseResponse(ctx, 1.5);
    const reverbDry = ctx.createGain(); reverbDry.gain.value = 1;
    const reverbWet = ctx.createGain(); reverbWet.gain.value = 0;

    // 回声（大厅回声的延迟 + 反馈）
    const echoDelay = ctx.createDelay(1.0); echoDelay.delayTime.value = 0.35;
    const echoFeedback = ctx.createGain(); echoFeedback.gain.value = 0;
    const echoWet = ctx.createGain(); echoWet.gain.value = 0;

    // 噪声源（雨声柔化低通，避免高频刺耳）
    const noiseGain = ctx.createGain(); noiseGain.gain.value = 0;
    const noiseLowpass = ctx.createBiquadFilter();
    noiseLowpass.type = 'lowpass'; noiseLowpass.frequency.value = 12000; noiseLowpass.Q.value = 0.7;

    const master = ctx.createGain(); master.gain.value = 1;
    const output = ctx.createGain(); output.gain.value = 1;

    // 节拍器支路：独立直连输出，不受蒙版效果影响
    const metroGain = ctx.createGain(); metroGain.gain.value = 0;
    metroGain.connect(output);

    // 声场宽度级（M/S）：mid=(L+R)/2，side=(L−R)/2；输出 L=mid+side·w，R=mid−side·w
    // w=1 原始声场，w=0 单声道，w>1 加宽；节拍器 metroGain 不经过此级
    const wideIn = ctx.createGain();
    const wideSplit = ctx.createChannelSplitter(2);
    const wideMerge = ctx.createChannelMerger(2);
    const midL = ctx.createGain(); midL.gain.value = 0.5;
    const midR = ctx.createGain(); midR.gain.value = 0.5;
    const midSum = ctx.createGain();
    const sideL = ctx.createGain(); sideL.gain.value = 0.5;
    const sideR = ctx.createGain(); sideR.gain.value = -0.5;
    const sideSum = ctx.createGain();
    const sideAmp = ctx.createGain(); sideAmp.gain.value = 1;
    const sideInv = ctx.createGain(); sideInv.gain.value = -1;

    // 3D 环绕级（HRTF）：声源绕听者头部匀速转圈。速度推子=转一圈秒数，范围推子=轨道半径；
    // 干/湿双路：速度或范围为 0 时走干路（完全直通，无任何 HRTF 染色）。节拍器 metroGain 不经过此级。
    const surroundDry = ctx.createGain(); surroundDry.gain.value = 1;
    const surroundWet = ctx.createGain(); surroundWet.gain.value = 0;
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.rolloffFactor = 0; // 距离不衰减：只有方向感，无音量起伏（审美上更耐听）
    panner.refDistance = 1;
    panner.positionX.value = 0; panner.positionY.value = 0; panner.positionZ.value = -1;
    const orbitX = ctx.createGain(); orbitX.gain.value = 0;
    const orbitZ = ctx.createGain(); orbitZ.gain.value = 0;
    const oscSin = ctx.createOscillator(); oscSin.type = 'sine'; oscSin.frequency.value = 0;
    const oscCos = ctx.createOscillator();
    // 余弦波：real[1]=1 的自定义周期波（与正弦相位差 90°，构成圆轨迹的 x/z 分量）
    oscCos.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0]), { disableNormalization: true }));
    oscCos.frequency.value = 0;
    oscSin.connect(orbitX); orbitX.connect(panner.positionX); // x = R·sin(2πft)
    oscCos.connect(orbitZ); orbitZ.connect(panner.positionZ); // z = R·cos(2πft)
    oscSin.start(); oscCos.start();

    // 连线
    input.connect(highpass);
    let prev = highpass;
    for (const lp of lowpass) { prev.connect(lp); prev = lp; }
    prev.connect(lowShelf);
    lowShelf.connect(midPeak);
    midPeak.connect(highShelf);

    highShelf.connect(shaper);
    shaper.connect(master);
    highShelf.connect(chorusDelay);
    chorusDelay.connect(chorusWet);
    chorusWet.connect(master);

    master.connect(reverbDry); reverbDry.connect(wideIn);
    master.connect(convolver); convolver.connect(reverbWet); reverbWet.connect(wideIn);

    // 回声通路：master → delay ⇄ feedback，wet 送宽度级
    master.connect(echoDelay);
    echoDelay.connect(echoFeedback);
    echoFeedback.connect(echoDelay);
    echoDelay.connect(echoWet);
    echoWet.connect(wideIn);

    // 宽度级连线：三路汇总 → M/S 分解 → 合成 → 输出
    wideIn.connect(wideSplit);
    wideSplit.connect(midL, 0); wideSplit.connect(midR, 1);
    midL.connect(midSum); midR.connect(midSum);
    wideSplit.connect(sideL, 0); wideSplit.connect(sideR, 1);
    sideL.connect(sideSum); sideR.connect(sideSum);
    sideSum.connect(sideAmp);
    sideAmp.connect(wideMerge, 0, 0);
    sideAmp.connect(sideInv); sideInv.connect(wideMerge, 0, 1);
    midSum.connect(wideMerge, 0, 0);
    midSum.connect(wideMerge, 0, 1);
    wideMerge.connect(surroundDry); surroundDry.connect(output);
    wideMerge.connect(panner); panner.connect(surroundWet); surroundWet.connect(output);

    noiseGain.connect(noiseLowpass);
    noiseLowpass.connect(master);

    // ---- 内部状态 ----
    let noiseSource = null;
    let currentNoiseType = null;
    let lastDecay = 1.5;
    let lastSaturation = 0;

    function setSaturation(amount) {
      if (amount === lastSaturation) return;
      lastSaturation = amount;
      if (amount <= 0) { shaper.curve = null; return; }
      const n = 1024;
      const curve = new Float32Array(n);
      const k = 1 + amount * 3;
      const norm = Math.tanh(k);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * k) / norm;
      }
      shaper.curve = curve;
    }

    // gainValue：相对主信号的电平（噪声与主信号共享 master，故不含主音量）
    function setNoise(type, gainValue) {
      noiseGain.gain.value = gainValue;
      if (type === currentNoiseType) return;
      if (noiseSource) { try { noiseSource.stop(); noiseSource.disconnect(); } catch (e) {} noiseSource = null; }
      currentNoiseType = type;
      if (!type) return;
      let buffer = null;
      if (type === 'radio') buffer = createNoiseBuffer(ctx);
      else if (type === 'rainfile') buffer = getRainBuffer ? getRainBuffer() : null;
      if (!buffer) return; // 文件未就绪时静默跳过
      noiseSource = ctx.createBufferSource();
      noiseSource.buffer = buffer;
      noiseSource.loop = true;
      noiseSource.connect(noiseGain);
      noiseSource.start();
    }

    function applyParams(p, immediate) {
      // 高通
      ramp(ctx, highpass.frequency, p.highpass || 20, 0.03, immediate);
      // 低通（级联）
      const cutoff = p.lowpassCutoff || 20000;
      const stages = p.lowpassStages || 0;
      for (let i = 0; i < lowpass.length; i++) {
        ramp(ctx, lowpass[i].frequency, i < stages ? cutoff : 20000, 0.03, immediate);
      }
      // EQ
      ramp(ctx, lowShelf.gain, p.lowGain || 0, 0.03, immediate);
      ramp(ctx, midPeak.gain, p.midGain || 0, 0.03, immediate);
      ramp(ctx, midPeak.frequency, p.midFreq || 1000, 0.03, immediate);
      ramp(ctx, highShelf.gain, p.highGain || 0, 0.03, immediate);
      // 饱和
      setSaturation(p.saturation || 0);
      // 合唱
      ramp(ctx, chorusWet.gain, (p.chorus || 0) * 0.35, 0.03, immediate);
      ramp(ctx, chorusLfoGain.gain, (p.chorus || 0) * 0.005, 0.03, immediate);
      // 混响
      if (p.reverbDecay && p.reverbDecay !== lastDecay) {
        convolver.buffer = createImpulseResponse(ctx, p.reverbDecay);
        lastDecay = p.reverbDecay;
      }
      ramp(ctx, reverbWet.gain, p.reverbWet || 0, 0.04, immediate);
      // 回声
      ramp(ctx, echoDelay.delayTime, p.echoTime || 0.35, 0.03, immediate);
      ramp(ctx, echoFeedback.gain, p.echoFeedback || 0, 0.03, immediate);
      ramp(ctx, echoWet.gain, p.echoWet || 0, 0.03, immediate);
      // 声场宽度
      ramp(ctx, sideAmp.gain, (p.stereoWidth != null) ? p.stereoWidth : 1, 0.03, immediate);
      // 3D 环绕（HRTF）：速度与范围都 >0 才启用（湿声路），否则干路直通 = 普通立体声
      const sOn = (p.surroundSpeed || 0) > 0.001 && (p.surroundRange || 0) > 0.001;
      ramp(ctx, surroundDry.gain, sOn ? 0 : 1, 0.03, immediate);
      ramp(ctx, surroundWet.gain, sOn ? 1 : 0, 0.03, immediate);
      if (sOn) {
        const period = 16 - 12 * clamp(p.surroundSpeed || 0, 0, 1); // 一圈秒数：0.1→15.8s，1→4s
        const sFreq = 1 / period;
        ramp(ctx, oscSin.frequency, sFreq, 0.05, immediate);
        ramp(ctx, oscCos.frequency, sFreq, 0.05, immediate);
        const radius = 3 * clamp(p.surroundRange || 0, 0, 1); // 轨道半径（米）
        ramp(ctx, orbitX.gain, radius, 0.05, immediate);
        ramp(ctx, orbitZ.gain, radius, 0.05, immediate);
      }
      // 音量：预设补偿 × 音量调节倍率
      const presetGain = Math.pow(10, (p.volumeDb || 0) / 20);
      const volGain = (p.volumeGain != null) ? p.volumeGain : 1;
      const masterGain = presetGain * volGain;
      ramp(ctx, master.gain, masterGain, 0.03, immediate);
      // 噪声：离线图直接混入结果；在线图由引擎按播放状态同步（未播放不出声）
      const noiseLevel = p.noiseLevel || 0;
      if (!noiseFollowsPlay) {
        setNoise(noiseLevel > 0.0005 ? (p.noiseType || null) : null, noiseLevel);
      }
    }

    function dispose() {
      if (noiseSource) { try { noiseSource.stop(); noiseSource.disconnect(); } catch (e) {} noiseSource = null; }
      try { chorusLfo.stop(); chorusLfo.disconnect(); } catch (e) {}
      try { oscSin.stop(); oscSin.disconnect(); } catch (e) {}
      try { oscCos.stop(); oscCos.disconnect(); } catch (e) {}
    }

    return {
      input, output, metroGain, applyParams, dispose, setNoise, noiseFollowsPlay: !!noiseFollowsPlay,
      // 3D 环绕级调试句柄（测试与可视化用）
      surround: { dry: surroundDry, wet: surroundWet, oscSin: oscSin, oscCos: oscCos, orbitX: orbitX, orbitZ: orbitZ }
    };
  }

  /* ---------------- BPM 检测 v2（双频段 onset + 自相关 + 节拍先验八度校正） ---------------- */
  function detectBPM(buffer) {
    try {
      const sr = buffer.sampleRate;
      const ch0 = buffer.getChannelData(0);
      const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
      const length = buffer.length;
      if (length < sr * 2) return null; // 太短

      // 包络采样率约 200Hz
      const hop = Math.max(1, Math.floor(sr / 200));
      const n = Math.floor(length / hop);
      if (n < 512) return null;

      // 双频段能量包络：低频（底鼓）用 one-pole 低通提取，高频（军鼓/踩镲）= 全频段 − 低频
      const envLow = new Float32Array(n);
      const envFull = new Float32Array(n);
      const lpA = Math.exp(-2 * Math.PI * 150 / sr); // 低通截止 ≈150Hz
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const start = i * hop;
        let sumL = 0, sumF = 0, cnt = 0;
        const end = Math.min(hop, length - start);
        for (let j = 0; j < end; j++) {
          const s = (ch0[start + j] + ch1[start + j]) * 0.5;
          lp = lpA * lp + (1 - lpA) * s;
          const high = s - lp;
          sumL += lp * lp + high * high * 0.5;
          sumF += s * s;
          cnt++;
        }
        envLow[i] = cnt ? Math.sqrt(sumL / cnt) : 0;
        envFull[i] = cnt ? Math.sqrt(sumF / cnt) : 0;
      }

      // 起始强度（各频段能量正差分之和）：底鼓/军鼓/踩镲的拍点都能呈现
      const onset = new Float32Array(n);
      let anyOnset = 0;
      for (let i = 1; i < n; i++) {
        const dL = envLow[i] - envLow[i - 1];
        const dF = envFull[i] - envFull[i - 1];
        onset[i] = (dL > 0 ? dL : 0) + (dF > 0 ? dF : 0);
        anyOnset += onset[i];
      }
      if (anyOnset < 1e-6) return null; // 静音

      const envRate = sr / hop;
      const minBpm = 55, maxBpm = 215;
      const minLag = Math.floor(envRate * 60 / maxBpm);
      const maxLag = Math.ceil(envRate * 60 / minBpm);

      // 自相关（按重叠长度归一，避免长滞后被天然衰减）
      const acf = new Float32Array(maxLag + 2);
      for (let lag = minLag; lag <= maxLag; lag++) {
        let corr = 0;
        for (let i = 0; i + lag < n; i++) corr += onset[i] * onset[i + lag];
        acf[lag] = corr / (n - lag);
      }

      // 抛物线插值细化峰位（亚样本精度，让 BPM 不被 200Hz 采样格点量化）
      function refine(lag) {
        const y0 = lag - 1 >= 0 ? acf[lag - 1] : 0;
        const y1 = acf[lag];
        const y2 = lag + 1 < acf.length ? acf[lag + 1] : 0;
        const denom = y0 - 2 * y1 + y2;
        if (Math.abs(denom) < 1e-12) return lag;
        const delta = 0.5 * (y0 - y2) / denom;
        if (Math.abs(delta) > 1) return lag;
        return lag + delta;
      }

      // ACF 全局最高峰
      let peakLag = minLag, peakV = -Infinity;
      for (let lag = minLag; lag <= maxLag; lag++) {
        if (acf[lag] > peakV) { peakV = acf[lag]; peakLag = lag; }
      }

      // 节拍先验：log 空间高斯，中心 120 BPM，宽 0.5 个八度 —— 八度校正的核心
      const prior = (bpm) => Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.5, 2));

      // 候选：主峰与其 2×/½/3×/⅓ 周期（覆盖常见八度/三连音误判），按 ACF 强度 × 先验评分
      const cands = [peakLag, peakLag * 2, peakLag / 2, peakLag * 3, peakLag / 3];
      let bestBpm = null, bestScore = -Infinity;
      for (const cand of cands) {
        const li = Math.round(cand);
        if (li < minLag || li > maxLag) continue;
        let v = -Infinity, bl = li;
        for (let l = Math.max(minLag, li - 2); l <= Math.min(maxLag, li + 2); l++) {
          if (acf[l] > v) { v = acf[l]; bl = l; }
        }
        const refined = refine(bl);
        const rBpm = 60 * envRate / refined;
        if (rBpm < 55 || rBpm > 215) continue;
        const score = (acf[bl] / (peakV || 1)) * prior(rBpm);
        if (score > bestScore) { bestScore = score; bestBpm = rBpm; }
      }
      if (!bestBpm) return null;

      // 兜底折叠到 60–200
      let bpm = bestBpm;
      while (bpm < 60) bpm *= 2;
      while (bpm > 200) bpm /= 2;
      return Math.round(bpm * 10) / 10; // 一位小数：显示与节拍器使用完全相同的数值
    } catch (e) {
      return null;
    }
  }

  /* ---------------- 主引擎 ---------------- */
  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.buffer = null;
      this.duration = 0;
      this.originalName = '';
      this.bpm = null;             // 检测到的 BPM（或 null）
      this.currentPreset = null;
      this.effectStrength = 0.5;   // 效果强度 0~1（默认 50%）
      this._surroundSpeed = 0;     // 3D 环绕速度 0~1（0=关；独立于预设/效果强度）
      this._surroundRange = 0;     // 3D 环绕范围 0~1（0=关）
      this._tweaks = { muffle: 0.5, reverb: 0.5, warmth: 0.5, bass: 0.5, mid: 0.5, treble: 0.5, volume: 0.5, echo: 0.5, drift: 0.5, width: 0.5, rumble: 0.5 };
      this.metronome = { on: false, factor: 1 }; // 节拍器开关与倍率（0.5/1/2）
      this._metroBufs = {};
      this._metroGridCache = null;  // 节拍网格缓存 { key, val }（随新音频清空）
      this._metroTimer = null;      // lookahead 调度器定时器
      this._metroNextTick = 0;      // 下一拍 ctx 时间
      this._metroCurInterval = 0.5; // 当前拍间隔（输出时间）
      this._graph = null;
      this._rainBuffer = null;     // 雨声解码结果（由内嵌 base64 解码）
      this._rainTried = false;

      this._rate = 1;
      this._sources = [];
      this._srcGain = null;            // 淡入淡出包络增益（播放源 → 图输入之间）
      this._fades = { in: 0, out: 0 }; // 淡入/淡出时长（秒，蒙版长条设定，试听与导出共用）
      this._offset = 0;
      this._startTime = 0;
      this._startOffset = 0;
      this.isPlaying = false;
    }

    _ensureCtx() {
      if (!this.ctx) {
        const AC = global.AudioContext || global.webkitAudioContext;
        this.ctx = new AC();
        this._loadRain(); // 解码内嵌 base64 雨声，失败则静默跳过
      }
      return this.ctx;
    }

    unlock() {
      const ctx = this._ensureCtx();
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }

    // 解码内嵌 base64 雨声为 buffer；失败则静默跳过
    async _loadRain() {
      if (this._rainTried) return;
      this._rainTried = true;
      try {
        const b64 = global.RAIN_BASE64;
        if (!b64) return;
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const raw = await this.ctx.decodeAudioData(bytes.buffer);
        this._rainBuffer = this._makeRainLoop(raw);
        // 若当前正是雨声预设，重新应用以接上噪声源
        if (this._graph && this.currentPreset && this.currentPreset.noiseType === 'rainfile') {
          this._applyCurrent(false);
        }
      } catch (e) {
        this._rainBuffer = null;
      }
    }

    // 对雨声片段做首尾淡入淡出，形成可无缝循环、不突兀的背景层
    _makeRainLoop(buffer) {
      const rate = buffer.sampleRate;
      const ch = Math.min(buffer.numberOfChannels, 2);
      const len = buffer.length;
      const out = this.ctx.createBuffer(ch, len, rate);
      const fade = Math.min(Math.floor(rate * 0.5), Math.floor(len / 4));
      for (let c = 0; c < ch; c++) {
        const src = buffer.getChannelData(c);
        const dst = out.getChannelData(c);
        for (let i = 0; i < len; i++) {
          let s = src[i];
          if (i < fade) s *= i / fade;
          else if (i >= len - fade) s *= (len - 1 - i) / fade;
          dst[i] = s;
        }
      }
      return out;
    }

    async loadFile(arrayBuffer, name) {
      const ctx = this._ensureCtx();
      const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      this.buffer = buffer;
      this.duration = buffer.duration;
      this.originalName = name || 'song';
      this.bpm = detectBPM(buffer);
      this.metronome.on = false; // 换新歌：节拍器重置
      this.metronome.factor = 1;
      this._rate = 1;            // 防跨会话倍速残留
      this._metroGridCache = null; // 清跨曲目节拍网格缓存

      this.stop();
      this._buildGraph();
      return buffer;
    }

    // 直接注入已解码的音频（供页面间携带），行为与 loadFile 一致
    loadBuffer(buffer, name) {
      this._ensureCtx();
      this.buffer = buffer;
      this.duration = buffer.duration;
      this.originalName = name || 'song';
      this.bpm = detectBPM(buffer);
      this.metronome.on = false;
      this.metronome.factor = 1;
      this._rate = 1;
      this._metroGridCache = null;

      this.stop();
      this._buildGraph();
      return buffer;
    }

    // 卸载当前音频（跨界面删除时用）
    unload() {
      this.stop();
      this.buffer = null;
      this.duration = 0;
      this.originalName = '';
      this.bpm = null;
      this.currentPreset = null;
      this._rate = 1;
      this._metroGridCache = null;
      this._tweaks = { muffle: 0.5, reverb: 0.5, warmth: 0.5, bass: 0.5, mid: 0.5, treble: 0.5, volume: 0.5, echo: 0.5, drift: 0.5, width: 0.5, rumble: 0.5 };
    }

    _buildGraph() {
      const ctx = this.ctx;
      if (this._graph) {
        try { this._graph.output.disconnect(); } catch (e) {}
        this._graph.dispose();
      }
      const graph = createGraph(ctx, () => this._rainBuffer, true);
      graph.output.connect(ctx.destination);
      this._graph = graph;
      this._applyCurrent(true);
    }

    // 预设/原声 + 微调 → 全量参数，再按 effectStrength 插值（50%=正常，100%=偏激）
    _computeParams() {
      const v = this._tweaks;                 // 各微调 0~1，默认 0.5
      const s = clamp(this.effectStrength, 0, 1);
      const strength = s * 2;                 // 0~2；0.5→1（正常），1→2（偏激）
      const N = NEUTRAL_PARAMS;
      const off = (key) => (v[key] - 0.5) * 2; // 0~1 → -1~+1

      // 基础参数：预设或中性（原声时微调同样生效）
      const base = this.currentPreset || N;

      // 全量目标（微调已应用，对应 strength=1）
      const target = {
        lowpassCutoff: clamp(base.lowpassCutoff * Math.pow(2, -off('muffle') * 1.5), 100, 20000),
        lowpassStages: base.lowpassStages || (off('muffle') > 0 ? 1 : 0),
        highpass: clamp((base.highpass || 20) * Math.pow(2, Math.max(0, off('rumble')) * 2), 20, 8000),
        lowGain: (base.lowGain || 0) + off('bass') * 12,
        midGain: (base.midGain || 0) + off('mid') * 8,
        midFreq: base.midFreq || 1000,
        highGain: (base.highGain || 0) + off('treble') * 12,
        reverbWet: clamp((base.reverbWet || 0) + off('reverb') * 0.5, 0, 1),
        reverbDecay: base.reverbDecay || 1.5,
        noiseType: base.noiseType || null,
        noiseLevel: base.noiseLevel || 0,
        saturation: clamp((base.saturation || 0) + off('warmth') * 0.5, 0, 1),
        chorus: clamp((base.chorus || 0) + Math.max(0, off('drift')) * 1.0, 0, 1.5),
        echoWet: clamp((base.echoWet || 0) + Math.max(0, off('echo')) * 0.6, 0, 1),
        echoFeedback: clamp((base.echoFeedback || 0) + Math.max(0, off('echo')) * 0.55, 0, 0.85),
        echoTime: base.echoTime || 0.35,
        volumeDb: base.volumeDb || 0
      };

      // 效果强度：strength=0 旁通、1 全量、2 偏激（越过 target 继续加码）
      const interpFreq = (neutral, val) =>
        Math.pow(2, Math.log2(neutral) + (Math.log2(val) - Math.log2(neutral)) * strength);
      const gainOf = (val, max) => {
        const g = val * strength;
        return max != null ? clamp(g, 0, max) : g;
      };

      return {
        lowpassCutoff: clamp(interpFreq(N.lowpassCutoff, target.lowpassCutoff), 100, 20000),
        lowpassStages: target.lowpassStages,
        highpass: clamp(interpFreq(N.highpass, target.highpass), 20, 8000),
        // EQ 增益限幅随灵敏度 ×2 同步放宽，保证效果强度仍按原比例作用
        lowGain: clamp(gainOf(target.lowGain), -24, 24),
        midGain: clamp(gainOf(target.midGain), -16, 16),
        midFreq: target.midFreq,
        highGain: clamp(gainOf(target.highGain), -24, 24),
        reverbWet: gainOf(target.reverbWet, 1),
        reverbDecay: N.reverbDecay + (target.reverbDecay - N.reverbDecay) * Math.min(1, strength),
        noiseType: target.noiseType,
        noiseLevel: gainOf(target.noiseLevel, 1),
        saturation: gainOf(target.saturation, 1),
        chorus: gainOf(target.chorus, 1),
        echoWet: gainOf(target.echoWet, 1),
        echoFeedback: gainOf(target.echoFeedback, 0.9),
        echoTime: target.echoTime,
        stereoWidth: clamp(1 + off('width') * strength, 0, 2.5), // 声场宽度：1=原始，0=单声道，>1 加宽
        surroundSpeed: clamp(this._surroundSpeed || 0, 0, 1),    // 3D 环绕：0=关（独立于效果强度）
        surroundRange: clamp(this._surroundRange || 0, 0, 1),
        volumeDb: clamp(target.volumeDb * strength, -12, 6),
        volumeGain: Math.min(1.5, v.volume * 2)  // 音量调节 0~1.5（0=无声）
      };
    }

    _applyCurrent(immediate) {
      if (!this._graph) return;
      const p = this._computeParams();
      this._graph.applyParams(p, immediate);
      // 雨声/底噪跟随播放：未播放时不出声（音乐停则雨声停）
      if (this._graph.noiseFollowsPlay) {
        this._graph.setNoise(this.isPlaying ? (p.noiseType || null) : null,
                             this.isPlaying ? (p.noiseLevel || 0) : 0);
      }
    }

    applyPreset(preset) {
      this.currentPreset = preset;
      this.effectStrength = 0.5;
      this._tweaks = { muffle: 0.5, reverb: 0.5, warmth: 0.5, bass: 0.5, mid: 0.5, treble: 0.5, volume: 0.5, echo: 0.5, drift: 0.5, width: 0.5, rumble: 0.5 };
      this._applyCurrent(false);
    }

    clearPreset() {
      this.currentPreset = null;
      this.effectStrength = 0.5;
      this._tweaks = { muffle: 0.5, reverb: 0.5, warmth: 0.5, bass: 0.5, mid: 0.5, treble: 0.5, volume: 0.5, echo: 0.5, drift: 0.5, width: 0.5, rumble: 0.5 };
      this._applyCurrent(false);
    }

    setTweak(key, v) {
      if (!(key in this._tweaks)) return;
      this._tweaks[key] = v;
      this._applyCurrent(false);
    }

    setMix(v) {
      this.effectStrength = clamp(v, 0, 1);
      this._applyCurrent(false);
    }

    // 节拍器（与模板不冲突：独立支路直连输出，不经过蒙版效果器）
    _metroInterval() {
      return 60 / (this.bpm * this._rate * this.metronome.factor);
    }

    // 文件时间轴上的节拍间隔（不含播放变速）
    _metroIntervalFile() {
      return 60 / (this.bpm * this.metronome.factor);
    }

    // 节拍网格检测：onset（正差分）包络折叠直方图 + 半拍/倍拍择优
    _metroGrid() {
      const key = 'g' + (this.metronome.factor || 1) + '|' + (this.bpm || 0);
      if (this._metroGridCache && this._metroGridCache.key === key) return this._metroGridCache.val;
      const val = this._computeMetroGrid();
      this._metroGridCache = { key: key, val: val };
      return val;
    }

    // onset 强度包络（能量正差分），envRate 精确
    _onsetEnvelope() {
      const sr = this.buffer.sampleRate;
      const hop = Math.max(1, Math.round(0.01 * sr));
      const n = Math.floor(this.buffer.length / hop);
      const envRate = sr / hop;
      if (n < 16) return { onset: null, envRate: envRate };
      const d0 = this.buffer.getChannelData(0);
      const d1 = this.buffer.numberOfChannels > 1 ? this.buffer.getChannelData(1) : d0;
      const env = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        const base = i * hop;
        for (let j = 0; j < hop; j += 8) {
          const s = (d0[base + j] + d1[base + j]) * 0.5;
          sum += s * s;
        }
        env[i] = Math.sqrt(sum / (hop / 8));
      }
      const onset = new Float32Array(n);
      for (let i = 1; i < n; i++) {
        const d = env[i] - env[i - 1];
        onset[i] = d > 0 ? d : 0;
      }
      return { onset: onset, envRate: envRate };
    }

    _computeMetroGrid() {
      const res = { intervalFile: this._metroIntervalFile(), phase: 0 };
      if (!this.buffer || !this.bpm) return res;
      const env0 = this._onsetEnvelope();
      if (!env0.onset) return res;
      // 用户倍率（减半/加倍）显式决定 tick 密度；相位由 onset 直方图对齐鼓点
      const r = this._phaseScore(env0.onset, env0.envRate, res.intervalFile);
      res.phase = r.phase;
      return res;
    }

    // 把 onset 折叠到一个节拍周期的直方图（线性插值消 bin 量化），返回最优相位与归一化得分
    _phaseScore(onset, envRate, interval) {
      const BINS = 64;
      const binW = interval / BINS;
      const hist = new Float32Array(BINS);
      let sum = 0;
      for (let i = 1; i < onset.length; i++) {
        const v = onset[i];
        if (v <= 0) continue;
        sum += v;
        const pos = ((i / envRate) % interval) / binW;
        const b = Math.floor(pos);
        const frac = pos - b;
        hist[b % BINS] += v * (1 - frac);
        hist[(b + 1) % BINS] += v * frac;
      }
      if (sum < 1e-9) return { phase: 0, score: 0 };
      let bestB = 0, bestV = -1;
      for (let b = 0; b < BINS; b++) {
        const v = hist[(b + BINS - 1) % BINS] * 0.25 + hist[b] * 0.5 + hist[(b + 1) % BINS] * 0.25;
        if (v > bestV) { bestV = v; bestB = b; }
      }
      return { phase: (bestB + 0.5) * binW, score: bestV / (sum / BINS) };
    }

    // 生成单击声循环缓冲：1200Hz 正弦 + 指数衰减，柔和不刺耳但足够清晰
    _getMetroBuffer(interval) {
      const key = interval.toFixed(4);
      if (this._metroBufs[key]) return this._metroBufs[key];
      const sr = this.ctx.sampleRate;
      const len = Math.max(1, Math.round(interval * sr));
      const buf = this.ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      const tick = Math.min(len, Math.round(0.045 * sr));
      for (let i = 0; i < tick; i++) {
        d[i] = Math.sin(i / sr * 2 * Math.PI * 1200) * 0.55 * Math.exp(-i / (0.012 * sr));
      }
      this._metroBufs[key] = buf;
      return buf;
    }

    // 启动节拍网格：lookahead 调度（25ms 定时 + 0.12s 提前量逐拍排 tick，无累积漂移）
    _startMetroSource(offset) {
      this._stopMetroSource();
      if (!this.metronome.on || !this.bpm || !this._graph) return;
      const g = this._metroGrid();
      const iOut = g.intervalFile / this._rate;
      this._metroCurInterval = iOut;
      const phaseOut = (g.phase / this._rate) % iOut;
      const now = this.ctx.currentTime;
      // 网格锚定在鼓点相位（而非歌曲 0 秒）：取相位网格上不早于 now+0.05 的第一拍
      const k = Math.ceil((now + 0.05 - phaseOut) / iOut);
      this._metroNextTick = phaseOut + k * iOut;
      const self = this;
      this._metroTimer = setInterval(function () { self._metroSchedule(); }, 25);
      this._metroSchedule();
      this._graph.metroGain.gain.value = 1;
    }

    _metroSchedule() {
      if (!this._graph || !this.metronome.on) return;
      const ahead = this.ctx.currentTime + 0.12;
      let guard = 0;
      while (this._metroNextTick < ahead && guard++ < 64) {
        const src = this.ctx.createBufferSource();
        src.buffer = this._getMetroBuffer(0.045);
        src.connect(this._graph.metroGain);
        src.start(Math.max(this._metroNextTick, this.ctx.currentTime));
        this._metroNextTick += this._metroCurInterval;
      }
    }

    _stopMetroSource() {
      if (this._metroTimer) {
        clearInterval(this._metroTimer);
        this._metroTimer = null;
      }
      if (this._graph) this._graph.metroGain.gain.value = 0;
    }

    // 开关 / 加倍减半（factor：0.5 减半 | 1 原速 | 2 加倍）
    setMetronome(on, factor) {
      this.metronome.on = !!on;
      if (factor != null) this.metronome.factor = factor;
      if (!this._graph) return;
      if (this.metronome.on && this.bpm && this.isPlaying) {
        this._startMetroSource(this.getCurrentTime());
      } else {
        this._stopMetroSource();
      }
    }

    /* ---------------- 播放控制 ---------------- */
    _createSourceAt(offset) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffer;
      src.playbackRate.value = this._rate;
      src.preservesPitch = true;
      const gain = this.ctx.createGain();
      src.connect(gain);
      gain.connect(this._graph.input);
      this._srcGain = gain;
      src.start(0, offset);
      this._sources = [src];
      this._startOffset = offset;
      this._startTime = this.ctx.currentTime;
      this._applyFadeEnv(gain.gain, offset); // 试听实时淡入淡出（须在 _startTime 之后调度）
      if (this.metronome.on && this.bpm) this._startMetroSource(offset);
    }

    _stopSources() {
      for (const s of this._sources) {
        try { s.stop(); } catch (e) {}
        try { s.disconnect(); } catch (e) {}
      }
      this._sources = [];
      if (this._srcGain) {
        try { this._srcGain.disconnect(); } catch (e) {}
        this._srcGain = null;
      }
      this._stopMetroSource();
    }

    async play() {
      if (!this.buffer) return;
      if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (e) {} }
      if (this._sources.length === 0) this._createSourceAt(this._offset);
      this.isPlaying = true;
      this._applyCurrent(false); // 播放开始：噪声（雨声等）随之响起
    }

    pause() {
      if (!this.isPlaying) return;
      this._offset = this.getCurrentTime();
      try { this.ctx.suspend(); } catch (e) {}
      this.isPlaying = false;
    }

    stop() {
      this._stopSources();
      this._offset = 0;
      this.isPlaying = false;
      // 停掉噪声源（雨声/电台底噪），避免退出后仍在响
      if (this._graph && this._graph.setNoise) this._graph.setNoise(null, 0);
    }

    replay() {
      this.stop();
      return this.play();
    }

    seek(t) {
      t = clamp(t, 0, this.duration);
      this._offset = t;
      const wasPlaying = this.isPlaying;
      if (this._sources.length > 0) this._stopSources();
      if (wasPlaying) { this._createSourceAt(t); this.isPlaying = true; }
    }

    getCurrentTime() {
      if (this._sources.length > 0) {
        return this._startOffset + (this.ctx.currentTime - this._startTime) * this._rate;
      }
      return this._offset;
    }

    setSpeed(v) {
      this._rate = v;
      if (!this.ctx || this._sources.length === 0) { this._offset = this.getCurrentTime(); return; }
      const now = this.ctx.currentTime;
      const pos = this.getCurrentTime();
      this._startOffset = pos;
      this._startTime = now;
      for (const s of this._sources) s.playbackRate.value = v;
      this._offset = pos;
      if (this._srcGain) this._applyFadeEnv(this._srcGain.gain, pos); // 淡入淡出包络随变速重排
      if (this.metronome.on && this.bpm) this._startMetroSource(this.getCurrentTime()); // 节拍器随变速重启
    }

    /* ---------------- 3D 环绕（试听与导出共用同一 HRTF 自动化） ---------------- */
    setSurround(speed, range) {
      this._surroundSpeed = clamp(speed || 0, 0, 1);
      this._surroundRange = clamp(range || 0, 0, 1);
      this._applyCurrent(false);
    }

    /* ---------------- 淡入淡出（试听与导出共用同一线性包络） ---------------- */
    setFades(inSec, outSec) {
      this._fades.in = Math.max(0, inSec || 0);
      this._fades.out = Math.max(0, outSec || 0);
      if (this.ctx && this._srcGain) this._applyFadeEnv(this._srcGain.gain, this.getCurrentTime());
    }

    // 两侧时长各自不超过音频一半（与导出端一致）
    _fadeTimes() {
      const dur = this.duration;
      return {
        inSec: Math.min(this._fades.in || 0, dur / 2),
        outSec: Math.min(this._fades.out || 0, dur / 2)
      };
    }

    // 文件时间轴 f 秒处的包络值（线性斜坡）
    _fadeValueAt(f, inSec, outSec, dur) {
      let v = 1;
      if (inSec > 0 && f < inSec) v *= f / inSec;
      if (outSec > 0 && f > dur - outSec) v *= (dur - f) / outSec;
      return v;
    }

    // 给增益参数排布淡入淡出包络（offset = 本次播放起始的文件位置）
    _applyFadeEnv(param, offset) {
      const dur = this.duration;
      const { inSec, outSec } = this._fadeTimes();
      param.cancelScheduledValues(0);
      if (inSec <= 0 && outSec <= 0) { param.value = 1; return; }
      const t0 = this._startTime;
      const toCtx = (f) => t0 + (f - offset) / (this._rate || 1);
      const anchor = Math.max(t0, this.ctx.currentTime);
      param.setValueAtTime(this._fadeValueAt(offset, inSec, outSec, dur), anchor);
      if (inSec > 0 && offset < inSec) param.linearRampToValueAtTime(1, toCtx(inSec));
      if (outSec > 0 && offset < dur) {
        if (offset < dur - outSec) param.setValueAtTime(1, toCtx(dur - outSec));
        param.linearRampToValueAtTime(0, toCtx(dur));
      }
    }

    /* ---------------- 离线渲染 ---------------- */
    async renderToBuffer() {
      if (!this.buffer) throw new Error('尚未加载音频');
      const rate = this._rate || 1;
      const sampleRate = this.ctx.sampleRate;
      const outDur = this.duration / rate; // 倍速计入导出：输出时长 = 原时长 / 倍速
      const offline = new OfflineAudioContext(2, Math.max(1, Math.ceil(outDur * sampleRate)), sampleRate);
      const graph = createGraph(offline, () => this._rainBuffer, false);
      graph.applyParams(this._computeParams(), true);
      graph.output.connect(offline.destination);
      const src = offline.createBufferSource();
      src.buffer = this.buffer;
      src.playbackRate.value = rate;
      // 淡入淡出包络（与试听同一套线性斜坡）
      const fadeGain = offline.createGain();
      const dur = this.duration;
      const { inSec, outSec } = this._fadeTimes();
      if (inSec > 0 || outSec > 0) {
        fadeGain.gain.setValueAtTime(inSec > 0 ? 0 : 1, 0);
        if (inSec > 0) fadeGain.gain.linearRampToValueAtTime(1, inSec / rate);
        if (outSec > 0) {
          fadeGain.gain.setValueAtTime(1, Math.max(inSec / rate, (dur - outSec) / rate));
          fadeGain.gain.linearRampToValueAtTime(0, outDur);
        }
      } else {
        fadeGain.gain.value = 1;
      }
      src.connect(fadeGain);
      fadeGain.connect(graph.input);
      src.start(0);
      // 节拍器：开启时按网格逐拍混入导出结果（相位与音乐鼓点对齐）
      if (this.metronome.on && this.bpm) {
        const g = this._metroGrid();
        const iOut = g.intervalFile / this._rate;
        const phaseOut = (g.phase / this._rate) % iOut;
        const tick = this._getMetroBuffer(0.045);
        const total = this.duration / this._rate;
        for (let t = phaseOut; t < total; t += iOut) {
          if (t < 0) continue;
          const metroSrc = offline.createBufferSource();
          metroSrc.buffer = tick;
          metroSrc.connect(graph.metroGain);
          metroSrc.start(Math.max(0, t));
        }
        graph.metroGain.gain.value = 1;
      }
      const rendered = await offline.startRendering();
      graph.dispose();
      return rendered;
    }
  }

  global.AudioEngine = AudioEngine;
  global.REMIX_PRESETS = PRESETS;
  global.detectBPM = detectBPM; // 供拼接页检测各段 BPM
})(window);
