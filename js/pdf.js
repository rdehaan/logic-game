// A small PDF writer, for the feedback of the grader: text (with the standard
// fonts Helvetica, Helvetica-Bold and Courier, which every PDF viewer has, so no
// font is embedded), lines that are wrapped to the width of the page, pages that
// are added when one is full, and JPEG images (e.g. pictures of the board).
//
// Text is written in the WinAnsi encoding (Latin-1 and a few more characters,
// such as dashes and quotes); other characters become '?'.
//
// This module does not use the DOM (the tests run it in Node).

const PAGE_W = 595.28;     // A4, in points
const PAGE_H = 841.89;
const MARGIN = 56;

// Widths of the characters 32-126 in 1/1000 of the font size (from the AFM files
// of the standard fonts); other characters are taken as 556 wide.
const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722,
  722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944,
  667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELVETICA_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722,
  722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944,
  667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

const FONTS = {
  regular: { name: 'F1', base: 'Helvetica', widths: HELVETICA },
  bold: { name: 'F2', base: 'Helvetica-Bold', widths: HELVETICA_BOLD },
  mono: { name: 'F3', base: 'Courier', widths: null },
};

// Characters of WinAnsi outside Latin-1.
const WIN_ANSI = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87,
  'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91,
  '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98,
  '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};

// The byte of a character in WinAnsi (63, '?', if it has none).
function win_ansi(ch) {
  const c = ch.codePointAt(0);
  if (c >= 32 && c <= 126) return c;
  if (c >= 160 && c <= 255) return c;
  if (WIN_ANSI[ch] != null) return WIN_ANSI[ch];
  return 63;
}

// The text as it can be written (the characters that WinAnsi does not have are '?').
export function pdf_text(text) {
  return [...String(text).replace(/\t/g, '    ')].map((ch) => String.fromCharCode(win_ansi(ch))).join('');
}

export function text_width(text, font = 'regular', size = 11) {
  const f = FONTS[font];
  let w = 0;
  for (const ch of pdf_text(text)) {
    const c = ch.charCodeAt(0);
    w += f.widths ? (c >= 32 && c <= 126 ? f.widths[c - 32] : 556) : 600;
  }
  return (w * size) / 1000;
}

// Split a text into lines that fit in `width` (words that are too long are cut).
export function wrap(text, width, font = 'regular', size = 11) {
  const out = [];
  for (const paragraph of String(text).split('\n')) {
    const words = paragraph.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      if (!w) continue;
      const attempt = line + w;
      if (text_width(attempt.trimEnd(), font, size) <= width || !line.trim()) {
        line = attempt;
        // (a single word that is too long: cut it)
        while (text_width(line.trimEnd(), font, size) > width && line.length > 1) {
          let k = line.length - 1;
          while (k > 1 && text_width(line.slice(0, k), font, size) > width) k--;
          out.push(line.slice(0, k));
          line = line.slice(k);
        }
      } else {
        out.push(line.trimEnd());
        line = /^\s+$/.test(w) ? '' : w;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

const escape = (s) => s.replace(/[\\()]/g, (c) => '\\' + c);
const num = (x) => (Math.round(x * 100) / 100).toString();

export class PdfDocument {
  constructor({ title = '' } = {}) {
    this.title = title;
    this.pages = [];          // [{ ops: [text], images: [index] }]
    this.images = [];         // [{ bytes, width, height }]
    this.width = PAGE_W - 2 * MARGIN;
    this.new_page();
  }

  new_page() {
    this.page = { ops: [], images: [] };
    this.pages.push(this.page);
    this.y = PAGE_H - MARGIN;
  }

  // Make room for `height` points (on a new page if it does not fit).
  room(height) {
    if (this.y - height < MARGIN && this.y < PAGE_H - MARGIN) this.new_page();
  }

  space(points = 6) {
    this.y -= points;
  }

  // Lines of text: { font, size, color [r,g,b], indent, gap (space after) }.
  text(text, { font = 'regular', size = 11, color = null, indent = 0, gap = 4, leading = 1.3 } = {}) {
    const lines = wrap(text, this.width - indent, font, size);
    const line_h = size * leading;
    for (const line of lines) {
      this.room(line_h);
      this.y -= line_h;
      const f = FONTS[font];
      const rgb = color ? `${color.map(num).join(' ')} rg ` : '0 0 0 rg ';
      this.page.ops.push(`BT ${rgb}/${f.name} ${num(size)} Tf ${num(MARGIN + indent)} ${num(this.y + size * 0.25)} Td (${escape(pdf_text(line))}) Tj ET`);
    }
    this.y -= gap;
  }

  // A heading (kept on one page with `keep` points of what follows it).
  heading(text, level = 1, keep = 0) {
    const size = level === 1 ? 18 : level === 2 ? 14 : 12;
    this.room(size * 3 + keep);
    this.space(level === 1 ? 0 : 8);
    this.text(text, { font: 'bold', size, gap: 6 });
  }

  // A horizontal line.
  rule(color = [0.8, 0.8, 0.8]) {
    this.room(8);
    this.y -= 4;
    this.page.ops.push(`${color.map(num).join(' ')} RG 0.5 w ${num(MARGIN)} ${num(this.y)} m ${num(PAGE_W - MARGIN)} ${num(this.y)} l S`);
    this.y -= 6;
  }

  // Code, in a grey box (lines are wrapped).
  code(text, { size = 9 } = {}) {
    const lines = wrap(text, this.width - 12, 'mono', size);
    const line_h = size * 1.25;
    for (const line of lines) {
      this.room(line_h + 2);
      this.page.ops.push(`0.95 0.95 0.95 rg ${num(MARGIN)} ${num(this.y - line_h - 2)} ${num(this.width)} ${num(line_h + 2)} re f`);
      this.y -= line_h;
      this.page.ops.push(`BT 0.15 0.15 0.15 rg /F3 ${num(size)} Tf ${num(MARGIN + 6)} ${num(this.y + size * 0.15)} Td (${escape(pdf_text(line))}) Tj ET`);
    }
    this.y -= 6;
  }

  // A table: rows of cells (text), with column widths as fractions of the width.
  table(rows, widths, { size = 10, header = true } = {}) {
    const total = widths.reduce((a, b) => a + b, 0);
    const cols = widths.map((w) => (w / total) * this.width);
    rows.forEach((row, r) => {
      const font = header && r === 0 ? 'bold' : 'regular';
      const cells = row.map((cell, c) => wrap(String(cell ?? ''), cols[c] - 8, font, size));
      const n = Math.max(1, ...cells.map((x) => x.length));
      const line_h = size * 1.3;
      const h = n * line_h + 6;
      this.room(h);
      if (header && r === 0) this.page.ops.push(`0.93 0.93 0.93 rg ${num(MARGIN)} ${num(this.y - h)} ${num(this.width)} ${num(h)} re f`);
      let x = MARGIN;
      cells.forEach((lines, c) => {
        lines.forEach((line, k) => {
          const y = this.y - 3 - (k + 1) * line_h + size * 0.25;
          this.page.ops.push(`BT 0 0 0 rg /${FONTS[font].name} ${num(size)} Tf ${num(x + 4)} ${num(y)} Td (${escape(pdf_text(line))}) Tj ET`);
        });
        x += cols[c];
      });
      this.y -= h;
      this.page.ops.push(`0.8 0.8 0.8 RG 0.5 w ${num(MARGIN)} ${num(this.y)} m ${num(PAGE_W - MARGIN)} ${num(this.y)} l S`);
    });
    this.y -= 8;
  }

  // A JPEG image ({ bytes: Uint8Array, width, height } in pixels), at most
  // `max_width` points wide (and not higher than half a page).
  image({ bytes, width, height }, { max_width = 260, caption = '' } = {}) {
    let w = Math.min(max_width, this.width, width);
    let h = (height / width) * w;
    const max_h = (PAGE_H - 2 * MARGIN) / 2;
    if (h > max_h) {
      w *= max_h / h;
      h = max_h;
    }
    this.room(h + 20);
    const index = this.images.length;
    this.images.push({ bytes, width, height });
    this.page.images.push(index);
    this.y -= h;
    this.page.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(MARGIN)} ${num(this.y)} cm /Im${index} Do Q`);
    this.y -= 4;
    if (caption) this.text(caption, { size: 9, color: [0.35, 0.35, 0.35] });
    else this.y -= 4;
  }

  // The PDF file (Uint8Array).
  output() {
    const chunks = [];
    let length = 0;
    const offsets = [];
    const push = (data) => {
      const bytes = typeof data === 'string' ? latin1(data) : data;
      chunks.push(bytes);
      length += bytes.length;
    };
    const objects = [];        // [text or [text, bytes, text]]
    const add = (obj) => {
      objects.push(obj);
      return objects.length;
    };
    const catalog = add(null);
    const pages_id = add(null);
    const font_ids = Object.values(FONTS).map((f) => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${f.base} /Encoding /WinAnsiEncoding >>`));
    const fonts = Object.values(FONTS).map((f, i) => `/${f.name} ${font_ids[i]} 0 R`).join(' ');
    const image_ids = this.images.map((img) => add([
      `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`,
      img.bytes, '\nendstream']));
    const page_ids = [];
    for (const page of this.pages) {
      const content = latin1(page.ops.join('\n'));
      const content_id = add([`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
      const xobjects = page.images.length ? ` /XObject << ${page.images.map((i) => `/Im${i} ${image_ids[i]} 0 R`).join(' ')} >>` : '';
      page_ids.push(add(`<< /Type /Page /Parent ${pages_id} 0 R /MediaBox [0 0 ${num(PAGE_W)} ${num(PAGE_H)}] ` +
        `/Resources << /Font << ${fonts} >>${xobjects} >> /Contents ${content_id} 0 R >>`));
    }
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages_id} 0 R >>`;
    objects[pages_id - 1] = `<< /Type /Pages /Kids [${page_ids.map((id) => `${id} 0 R`).join(' ')}] /Count ${page_ids.length} >>`;
    const info = add(`<< /Title (${escape(pdf_text(this.title))}) /Producer (A Logic Game) >>`);

    push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    objects.forEach((obj, i) => {
      offsets.push(length);
      push(`${i + 1} 0 obj\n`);
      if (Array.isArray(obj)) obj.forEach(push); else push(obj);
      push('\nendobj\n');
    });
    const xref = length;
    push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
    for (const off of offsets) push(String(off).padStart(10, '0') + ' 00000 n \n');
    push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(length);
    let k = 0;
    for (const c of chunks) {
      out.set(c, k);
      k += c.length;
    }
    return out;
  }
}

function latin1(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}
