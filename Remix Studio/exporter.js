/* ============================================================
 * Remix Studio — 导出模块
 * 离线渲染 + MP3(lamejs)/WAV 编码 + 下载
 * ============================================================ */
(function (global) {
  'use strict';

  function floatTo16(f32) {
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return i16;
  }

  function encodeMp3(left, right, sampleRate) {
    const Mp3Encoder = global.lamejs.Mp3Encoder;
    const mp3 = new Mp3Encoder(2, sampleRate, 128); // 立体声 128kbps
    const blockSize = 1152;
    const left16 = floatTo16(left);
    const right16 = floatTo16(right);
    const chunks = [];

    for (let i = 0; i < left16.length; i += blockSize) {
      const l = left16.subarray(i, i + blockSize);
      const r = right16.subarray(i, i + blockSize);
      const mp3buf = mp3.encodeBuffer(l, r);
      if (mp3buf.length) chunks.push(new Uint8Array(mp3buf));
    }
    const end = mp3.flush();
    if (end.length) chunks.push(new Uint8Array(end));
    return new Blob(chunks, { type: 'audio/mpeg' });
  }

  // 与 encodeMp3 编码路径完全一致，只是每 64 块让出主线程并上报进度（大文件不再冻结界面）
  async function encodeMp3Async(left, right, sampleRate, onProgress) {
    const Mp3Encoder = global.lamejs.Mp3Encoder;
    const mp3 = new Mp3Encoder(2, sampleRate, 128); // 立体声 128kbps
    const blockSize = 1152;
    const left16 = floatTo16(left);
    const right16 = floatTo16(right);
    const chunks = [];

    for (let i = 0; i < left16.length; i += blockSize) {
      const l = left16.subarray(i, i + blockSize);
      const r = right16.subarray(i, i + blockSize);
      const mp3buf = mp3.encodeBuffer(l, r);
      if (mp3buf.length) chunks.push(new Uint8Array(mp3buf));
      if ((i / blockSize) % 64 === 0) {
        if (onProgress) onProgress(Math.min(1, i / left16.length));
        await new Promise(function (resolve) { setTimeout(resolve, 0); });
      }
    }
    const end = mp3.flush();
    if (end.length) chunks.push(new Uint8Array(end));
    if (onProgress) onProgress(1);
    return new Blob(chunks, { type: 'audio/mpeg' });
  }

  function encodeWav(left, right, sampleRate) {
    const length = left.length;
    const buffer = new ArrayBuffer(44 + length * 4);
    const view = new DataView(buffer);

    function writeString(offset, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + length * 4, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, length * 4, true);

    let offset = 44;
    for (let i = 0; i < length; i++) {
      const sL = Math.max(-1, Math.min(1, left[i]));
      const sR = Math.max(-1, Math.min(1, right[i]));
      view.setInt16(offset, sL < 0 ? sL * 0x8000 : sL * 0x7FFF, true); offset += 2;
      view.setInt16(offset, sR < 0 ? sR * 0x8000 : sR * 0x7FFF, true); offset += 2;
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  // 渲染 + 编码
  async function exportAudio(engine, onProgress) {
    onProgress && onProgress(0.05, '正在准备渲染…');
    const rendered = await engine.renderToBuffer();
    onProgress && onProgress(0.7, '正在编码…');

    const sampleRate = rendered.sampleRate;
    const left = rendered.getChannelData(0);
    const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left;

    const wantMp3 = typeof global.lamejs !== 'undefined';
    let blob;
    let ext = 'wav';
    if (wantMp3) {
      try {
        blob = await encodeMp3Async(left, right, sampleRate, function (p) {
          onProgress && onProgress(0.7 + p * 0.3, '正在编码…');
        });
        ext = 'mp3';
      } catch (e) {
        console.error('MP3 编码失败，回退 WAV：', e);
        blob = encodeWav(left, right, sampleRate);
      }
    } else {
      blob = encodeWav(left, right, sampleRate);
    }
    onProgress && onProgress(1.0, '完成');
    return { blob, ext };
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  global.Exporter = { exportAudio, download, encodeMp3, encodeMp3Async, encodeWav };
})(window);
