/* ============================================================
 * Remix Studio — 滑块数值点击输入（全站共用组件）
 * 点击滑块旁的数值文本弹出输入框：
 *   · Enter / 点击页面空白处 = 确定（范围钳制 + 按步进量化，支持小数）
 *   · 输入为空或非法 → 确定时保持原值（非法时输入框红边提示）
 *   · Esc = 取消，保持原值
 * ============================================================ */
(function (global) {
  'use strict';

  function decimalsOf(stepStr) {
    const s = String(stepStr == null ? '' : stepStr);
    const i = s.indexOf('.');
    return i === -1 ? 0 : (s.length - i - 1);
  }

  function attach(valueEl, input, opts) {
    opts = opts || {};
    valueEl.classList.add('editable');
    valueEl.title = '点击输入数值';
    valueEl.addEventListener('click', function (e) {
      e.stopPropagation();
      if (global.__valueEditorOpen) return;
      const min = parseFloat(input.min);
      const max = parseFloat(input.max);
      if (isNaN(min) || isNaN(max)) return;
      const step = parseFloat(input.step) > 0 ? parseFloat(input.step) : 0.01;
      const dec = (opts.decimals != null) ? opts.decimals : decimalsOf(input.step);
      const dispatchTypes = opts.dispatch || ['input'];

      const box = document.createElement('div');
      box.className = 'value-editor';
      const field = document.createElement('input');
      field.type = 'text';
      field.className = 'value-editor-input';
      field.value = String(input.value);
      const hint = document.createElement('p');
      hint.className = 'value-editor-hint';
      hint.textContent = '范围 ' + min + ' – ' + max + ' · Enter / 点空白确定 · Esc 取消';
      box.appendChild(field);
      box.appendChild(hint);
      document.body.appendChild(box);

      const rect = valueEl.getBoundingClientRect();
      const vw = window.innerWidth || 1280;
      box.style.left = Math.max(8, Math.min(rect.left, vw - 250)) + 'px';
      box.style.top = (rect.bottom + 6) + 'px';
      field.focus();
      if (field.select) field.select();
      global.__valueEditorOpen = true;

      let done = false;
      function close() {
        if (done) return;
        done = true;
        if (box.parentNode) box.parentNode.removeChild(box);
        document.removeEventListener('pointerdown', onDoc, true);
        global.removeEventListener('keydown', onKey, true);
        global.__valueEditorOpen = false;
      }
      function commit() {
        const raw = String(field.value).trim().replace(',', '.');
        const prev = parseFloat(input.value) || min;
        let v = prev; // 空 / 非法 → 保持原值
        if (raw !== '' && isFinite(Number(raw))) {
          let n = Math.min(max, Math.max(min, Number(raw)));       // 范围钳制
          n = min + Math.round((n - min) / step) * step;           // 步进量化
          v = parseFloat(Math.min(max, Math.max(min, n)).toFixed(dec));
        }
        input.value = v;
        dispatchTypes.forEach(function (t) {
          input.dispatchEvent(new Event(t, { bubbles: true }));
        });
        close();
      }
      function onDoc(e) {
        if (!box.contains(e.target) && e.target !== valueEl) commit();
      }
      function onKey(e) {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') close();
      }
      document.addEventListener('pointerdown', onDoc, true);
      global.addEventListener('keydown', onKey, true);
      field.addEventListener('keydown', function (e) {
        e.stopPropagation(); // 输入时不触发页面快捷键（空格/方向键）
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') close();
      });
      field.addEventListener('input', function () {
        const raw = String(field.value).trim();
        const okNum = raw === '' || isFinite(Number(raw.replace(',', '.')));
        field.classList.toggle('invalid', !okNum); // 非法输入红边提示
      });
    });
  }

  global.attachValueEditor = attach;
})(window);
