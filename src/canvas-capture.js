// Runs in the same isolated world as collector.js. Captures only an already-rendered, origin-clean canvas.
(id => {
  const state = globalThis.__eiwCollector;
  if (!state?.ids) return { error: 'ไม่พบสถานะ Canvas ของรอบสแกน' };
  const canvases = [], visited = new Set();
  function walk(root) {
    if (!root || visited.has(root)) return;
    visited.add(root);
    if (root instanceof HTMLCanvasElement) canvases.push(root);
    for (const el of root.querySelectorAll?.('*') || []) {
      if (el instanceof HTMLCanvasElement) canvases.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  }
  walk(document.documentElement);
  const canvas = canvases.find(el => state.ids.get(el) === id);
  if (!canvas) return { error: 'Canvas เปลี่ยนหรือถูกถอดออกจากหน้าแล้ว', retry: true };
  if (canvas.width <= 1 || canvas.height <= 1) return { error: 'Canvas ยังไม่มีภาพที่วาดเสร็จ', retry: true };
  try {
    const ctx = canvas.getContext('2d');
    if (ctx && canvas.width * canvas.height <= 30000000) {
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = false;
      for (let i = 3; i < pixels.length; i += 4) { if (pixels[i] !== 0) { painted = true; break; } }
      if (!painted) return { error: 'Canvas ยังว่างและยังไม่ถูกวาด', retry: true };
    }
    const data = canvas.toDataURL('image/png');
    if (!data.startsWith('data:image/png;base64,')) return { error: 'Canvas ส่งออกข้อมูลไม่ได้' };
    return { data, width: canvas.width, height: canvas.height };
  } catch (error) {
    return { error: error?.name === 'SecurityError' ? 'Canvas ถูก browser ป้องกันการอ่านพิกเซล' : (error?.message || 'อ่าน Canvas ไม่สำเร็จ') };
  }
})
