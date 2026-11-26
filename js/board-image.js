// Pictures of the board, for the feedback of the grader: the board drawn on a
// canvas (as grid-visual.js draws it on the page: the same labels, colours, fog
// and faded hidden items), as a PNG (for the web page) or a JPEG (for the PDF).
import { compute_grid_ds, label_text, css_color } from './grid-visual.js';

// The size of a cell in the picture (in pixels): large enough to print well,
// small enough for a board of 40 by 40 cells.
function cell_px(width, height) {
  return Math.max(8, Math.min(48, Math.floor(960 / Math.max(width, height))));
}

// Draw the board of `facts` on a new canvas; null if the facts have no board.
export async function board_canvas(facts) {
  const grid = compute_grid_ds(facts);
  if (!grid) return null;
  try {
    await document.fonts.load('32px FontAwesome', '');
  } catch {
    // (drawn with another font)
  }
  const size = cell_px(grid.width, grid.height);
  const pad = 2;
  const canvas = document.createElement('canvas');
  canvas.width = grid.width * size + 2 * pad;
  canvas.height = grid.height * size + 2 * pad;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 1; i <= grid.width * grid.height; i++) {
    const r = Math.floor((i - 1) / grid.width);
    const c = (i - 1) % grid.width;
    const x = pad + c * size;
    const y = pad + r * size;
    let bg = grid.fog.has(i) ? '#ddd' : null;
    const custom = css_color(grid.bg.get(i));
    if (custom) bg = custom;
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(x, y, size, size);
    }
    ctx.strokeStyle = '#000';
    ctx.lineWidth = size < 16 ? 0.5 : 1;
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    const items = [
      ...(grid.cells.get(i) || []).toSorted().map((item) => [item, 1]),
      ...(grid.hidden.get(i) || []).toSorted().map((item) => [item, 0.35]),
    ];
    if (!items.length) continue;
    const per_row = Math.ceil(Math.sqrt(items.length));
    const rows = Math.ceil(items.length / per_row);
    const font = Math.max(4, Math.floor((size * 0.62) / per_row));
    ctx.font = `900 ${font}px FontAwesome, "Open Sans", sans-serif`;
    items.forEach(([item, alpha], k) => {
      const col = k % per_row;
      const row = Math.floor(k / per_row);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = css_color(grid.colors.get(item)) || '#000';
      const text = label_text(grid.labels.get(item));
      const cx = x + size / 2 + (col - (per_row - 1) / 2) * (size / per_row);
      const cy = y + size / 2 + (row - (rows - 1) / 2) * (size / per_row);
      ctx.fillText(text, cx, cy, size / per_row);
    });
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad - 0.5, pad - 0.5, grid.width * size + 1, grid.height * size + 1);
  return canvas;
}

// The picture of a board: { data_url (PNG), jpeg: { bytes, width, height } }, or null.
export async function board_image(facts) {
  const canvas = await board_canvas(facts);
  if (!canvas) return null;
  const jpeg_url = canvas.toDataURL('image/jpeg', 0.92);
  const binary = atob(jpeg_url.slice(jpeg_url.indexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { data_url: canvas.toDataURL('image/png'), jpeg: { bytes, width: canvas.width, height: canvas.height } };
}
