'use strict';
/*
 * QR-Code-Erzeugung ohne Bibliothek (ISO/IEC 18004):
 * Byte-Modus (UTF-8), Fehlerkorrektur M (~15 %), Version 1–10, beste von 8 Masken.
 * Ausgabe als Modul-Matrix oder SVG. Reicht für URLs bis ca. 200 Zeichen.
 */
(function (root) {
  // Version → [Gesamt-Codewörter, EC-Codewörter je Block, Anzahl Blöcke] für Stufe M
  const TABLE = [null, [26, 10, 1], [44, 16, 1], [70, 26, 1], [100, 18, 2], [134, 24, 2], [172, 16, 4], [196, 18, 4], [242, 22, 4], [292, 22, 5], [346, 26, 5]];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const REMAINDER = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
    return z & 0xff;
  }
  function rsDivisor(degree) {
    const r = new Array(degree).fill(0); r[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
      root = gfMul(root, 0x02);
    }
    return r;
  }
  function rsRemainder(data, div) {
    const r = div.map(() => 0);
    for (const b of data) {
      const f = b ^ r.shift(); r.push(0);
      div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
    }
    return r;
  }
  const utf8 = (s) => (typeof TextEncoder !== 'undefined' ? [...new TextEncoder().encode(s)] : [...Buffer.from(s, 'utf8')]);

  function encode(text) {
    const bytes = utf8(text);
    // kleinste passende Version
    let ver = 0;
    for (let v = 1; v <= 10; v++) {
      const [total, ecLen, blocks] = TABLE[v];
      const dataCw = total - ecLen * blocks;
      const need = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
      if (need <= dataCw * 8) { ver = v; break; }
    }
    if (!ver) throw new Error('Text zu lang für einen QR-Code');
    const [total, ecLen, numBlocks] = TABLE[ver];
    const dataCw = total - ecLen * numBlocks;
    // Bitstrom
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(0b0100, 4); put(bytes.length, ver < 10 ? 8 : 16); bytes.forEach((b) => put(b, 8));
    put(0, Math.min(4, dataCw * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let p = 0xec; data.length < dataCw; p ^= 0xec ^ 0x11) data.push(p);
    // Blöcke + Fehlerkorrektur, verschränkt
    const shortLen = Math.floor(dataCw / numBlocks), numLong = dataCw % numBlocks, numShort = numBlocks - numLong;
    const div = rsDivisor(ecLen);
    const blocks = []; let k = 0;
    for (let b = 0; b < numBlocks; b++) {
      const len = shortLen + (b < numShort ? 0 : 1);
      const d = data.slice(k, k + len); k += len;
      blocks.push({ d, e: rsRemainder(d, div) });
    }
    const out = [];
    for (let i = 0; i <= shortLen; i++) blocks.forEach((b) => { if (i < b.d.length) out.push(b.d[i]); });
    for (let i = 0; i < ecLen; i++) blocks.forEach((b) => out.push(b.e[i]));
    return { ver, codewords: out };
  }

  function build(text) {
    const { ver, codewords } = encode(text);
    const size = ver * 4 + 17;
    const m = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
    // Taktlinien
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    // Suchmuster
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    // Ausrichtungsmuster
    const al = ALIGN[ver], n = al.length;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    // Formatinformation reservieren, Versionsinformation (ab Version 7)
    const drawFormat = (mask) => {
      const dataBits = (0 << 3) | mask; // Stufe M = 00
      let rem = dataBits;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const b = ((dataBits << 10) | rem) ^ 0x5412;
      const bit = (i) => ((b >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const b = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = ((b >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3);
        set(a, c, dark); set(c, a, dark);
      }
    }
    // Daten im Zickzack
    let bi = 0; const totalBits = codewords.length * 8 + REMAINDER[ver];
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (fn[y][x] || bi >= totalBits) continue;
        m[y][x] = bi < codewords.length * 8 ? ((codewords[bi >>> 3] >>> (7 - (bi & 7))) & 1) === 1 : false;
        bi++;
      }
    }
    // Maske wählen
    const MASKS = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ];
    const applyMask = (k) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[k](x, y)) m[y][x] = !m[y][x]; };
    let best = 0, bestScore = Infinity;
    for (let k = 0; k < 8; k++) {
      applyMask(k); drawFormat(k);
      const sc = penalty(m, size);
      if (sc < bestScore) { bestScore = sc; best = k; }
      applyMask(k); // zurück
    }
    applyMask(best); drawFormat(best);
    return m;
  }

  function penalty(m, size) {
    let s = 0;
    const line = (get) => {
      let run = 1;
      for (let i = 1; i < size; i++) {
        if (get(i) === get(i - 1)) { run++; if (run === 5) s += 3; else if (run > 5) s += 1; } else run = 1;
      }
      for (let i = 0; i + 10 < size + 1; i++) { // 1:1:3:1:1 mit vier hellen Modulen davor oder danach
        const p = [];
        for (let k = 0; k < 11 && i + k < size; k++) p.push(get(i + k) ? 1 : 0);
        const t = p.join('');
        if (t === '10111010000' || t === '00001011101') s += 40;
      }
    };
    for (let y = 0; y < size; y++) line((x) => m[y][x]);
    for (let x = 0; x < size; x++) line((y) => m[y][x]);
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (m[y][x]) dark++;
      if (x < size - 1 && y < size - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) s += 3;
    }
    s += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return s;
  }

  /** SVG-Text; opts.margin in Modulen (Standard 4), opts.color */
  function svg(text, opts = {}) {
    const m = build(text), n = m.length, q = opts.margin ?? 4, dim = n + 2 * q;
    let d = '';
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!m[y][x]) continue;
        let w = 1; while (x + w < n && m[y][x + w]) w++;
        d += `M${x + q} ${y + q}h${w}v1h-${w}z`; x += w - 1;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"${opts.size ? ` width="${opts.size}" height="${opts.size}"` : ''}>`
      + `<rect width="${dim}" height="${dim}" fill="#fff"/><path d="${d}" fill="${opts.color || '#000'}"/></svg>`;
  }

  const api = { matrix: build, svg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KSQR = api;
})(typeof window !== 'undefined' ? window : globalThis);
