# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在此仓库中工作时提供指导。

## 项目概览

“Remix Studio” 是一个单页浏览器应用，没有构建步骤、没有框架，也没有后端。用户上传音频文件（MP3/WAV），套用若干“场景”预设（雾气、电台、雨声、黑胶、浴室、太空）并辅以手动微调，然后导出处理后的音频。所有处理均通过 Web Audio API 在客户端本地完成——不会上传任何文件。界面文字和代码注释均为中文（zh-CN）。

## 常用命令

本项目没有构建系统、包管理器、代码检查工具或测试套件。Node.js 仅用于语法校验。

- 语法检查各脚本：
  - `node --check audio-engine.js`
  - `node --check main.js`
  - `node --check exporter.js`
- 运行应用：在浏览器中打开 `index.html`（Windows：`cmd.exe /c start "" "index.html"`）。

应用在运行时从 jsdelivr CDN 加载 `lamejs`（MP3 编码器），因此 MP3 导出需要联网。若无法加载，导出会静默回退为 16 位 WAV。

## 架构

各脚本为普通 `<script>` 文件，由 `index.html` 按顺序加载；每个脚本都是一个 IIFE，仅向 `window` 挂载一个全局对象。没有模块/import；文件之间通过这些全局对象通信，因此加载顺序很重要（`value-editor.js` → `audio-engine.js` → `exporter.js` → `main.js`）。`.claude/tests/` 内为 Node 仿真验收测试（`node .claude/tests/test-sliders.js`、`node .claude/tests/test-studio-keys.js`、`node .claude/tests/check-ids.js`），用桩模拟 DOM/WebAudio，不依赖浏览器。

- **`audio-engine.js`** — 音频核心。定义了 `AudioEngine` 类和 `REMIX_PRESETS` 数组。
  - `AudioEngine` 封装了一个 `AudioContext` 和一个固定拓扑的 Web Audio 图，每个加载的文件在 `createGraph()` 中构建一次。`applyParams()` 只调整节点参数，从不重新连线。
  - 图链路：`input → highpass → 4× 串联 lowpass → lowShelf → midPeak → highShelf → waveshaper（饱和）→ master → [reverb dry / convolver wet] → output`，另有并行的合唱通路和噪声源。四个 lowpass 级始终存在；预设的 `lowpassStages` 数值决定其中几级设为截止频率、其余在 20 kHz 处旁路。
  - 预设是纯参数对象；微调是在 `_computeParams()` 中叠加的数值偏移量。套用或清除预设会把所有微调重置为 0。
  - `detectBPM()` 在约 200 Hz 的能量包络上做峰值自相关，结果限定在 60–180 BPM。
  - 播放使用 `AudioBufferSourceNode` + `playbackRate` 实现变速；`renderToBuffer()` 通过 `OfflineAudioContext` 将整个图离线重渲染以用于导出。
- **`exporter.js`** — `Exporter` 全局对象（`exportAudio`、`download`、`encodeMp3`、`encodeWav`）。MP3 编码委托给 `global.lamejs`；否则写成立体声 WAV。
- **`main.js`** — 全部 DOM/UI 接线。实例化一次 `new AudioEngine()`，根据 `REMIX_PRESETS` 渲染预设按钮，依据 `TWEAKS` 配置数组构建微调滑块，并处理上传/拖放、走带控制、进度跳转、速度/BPM 以及导出进度。一个 `requestAnimationFrame` 循环（`animate()`）负责同步进度条。
- **`style.css`** — 由 `:root` 中的 CSS 自定义属性（`--bg`、`--card`、`--text` 等）驱动的暗色“工具”主题。

## 注意事项

- Git 仓库根目录是 `C:/Users/Lenovo`（用户主目录），而非本文件夹。本项目位于 `C:/Users/Lenovo/Desktop/xo-studio2`；使用仓库级 git 命令时需谨慎，因为它们会看到整个主目录。
- 每一次回答后面都加上一句“喵”，比如：关注塔菲喵，关注塔菲谢谢喵。
