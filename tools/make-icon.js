// Gera build/icon.ico desenhando o logotipo pixel a pixel.
// Sem dependencias: codifica PNG via zlib e monta o container ICO na mao.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ------------------------------------------------------------------ */
/* PNG                                                                 */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** rgba: Buffer de size*size*4 */
function encodePNG(rgba, size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // profundidade por canal
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Scanlines com byte de filtro 0 (nenhum).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* Desenho                                                             */
/* ------------------------------------------------------------------ */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;
const mixC = (c1, c2, t) => [mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t)];

const CYAN = [34, 211, 238];
const INDIGO = [99, 102, 241];
const VIOLET = [168, 85, 247];
const BG_TOP = [16, 23, 53];
const BG_BOT = [7, 10, 22];

const TAU = Math.PI * 2;
const ARC_START = Math.PI * 0.75;
const ARC_SWEEP = Math.PI * 1.5;

/** Cor + alfa de um ponto normalizado (-0.5..0.5). Retorna [r,g,b,a]. */
function sample(nx, ny) {
  // --------- moldura arredondada ---------
  const rr = 0.215; // raio dos cantos
  const half = 0.5;
  const qx = Math.abs(nx) - (half - rr);
  const qy = Math.abs(ny) - (half - rr);
  const dRect =
    Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - rr;
  const inside = 1 - smoothstep(-0.004, 0.004, dRect);
  if (inside <= 0) return [0, 0, 0, 0];

  // --------- fundo com gradiente + brilho ---------
  const g = clamp01((ny + 0.5) * 0.9 + (nx + 0.5) * 0.1);
  let col = mixC(BG_TOP, BG_BOT, g);

  const glow = Math.exp(-(Math.hypot(nx - 0.12, ny + 0.3) ** 2) / 0.085);
  col = mixC(col, [40, 60, 130], glow * 0.55);

  // --------- arco do velocimetro ---------
  const r = Math.hypot(nx, ny);
  let ang = Math.atan2(ny, nx);
  if (ang < 0) ang += TAU;
  // Normaliza para a varredura que comeca em 135 graus.
  let rel = ang - ARC_START;
  if (rel < 0) rel += TAU;

  const rIn = 0.3;
  const rOut = 0.385;
  const inBand = smoothstep(rIn - 0.012, rIn + 0.012, r) * (1 - smoothstep(rOut - 0.012, rOut + 0.012, r));

  if (inBand > 0) {
    if (rel <= ARC_SWEEP) {
      const t = rel / ARC_SWEEP;
      // O arco esta "aceso" ate 72% e apagado depois.
      const lit = 1 - smoothstep(0.7, 0.74, t);
      const arcCol = t < 0.5 ? mixC(CYAN, INDIGO, t / 0.5) : mixC(INDIGO, VIOLET, (t - 0.5) / 0.5);
      col = mixC(col, arcCol, inBand * mix(0.1, 1, lit));
      // Halo externo suave
      col = mixC(col, arcCol, inBand * lit * 0.25);
    }
  }

  // Brilho difuso do arco ao redor
  const haloBand = Math.exp(-((r - 0.342) ** 2) / 0.0024);
  if (rel <= ARC_SWEEP) {
    const t = rel / ARC_SWEEP;
    const lit = 1 - smoothstep(0.7, 0.74, t);
    const arcCol = t < 0.5 ? mixC(CYAN, INDIGO, t / 0.5) : mixC(INDIGO, VIOLET, (t - 0.5) / 0.5);
    col = mixC(col, arcCol, haloBand * lit * 0.16);
  }

  // --------- agulha ---------
  // Aponta para ~72% da varredura (coerente com a parte acesa do arco).
  const nAng = ARC_START + ARC_SWEEP * 0.72;
  const ca = Math.cos(nAng);
  const sa = Math.sin(nAng);
  const along = nx * ca + ny * sa; // projecao no eixo da agulha
  const across = -nx * sa + ny * ca; // distancia perpendicular
  const nLen = 0.255;
  if (along > -0.035 && along < nLen) {
    const tt = clamp01(along / nLen);
    const halfW = mix(0.03, 0.008, tt); // afunila na ponta
    const d = Math.abs(across) - halfW;
    const a = 1 - smoothstep(-0.004, 0.004, d);
    if (a > 0) {
      const needleCol = mixC([235, 245, 255], CYAN, tt * 0.75);
      col = mixC(col, needleCol, a);
    }
  }

  // --------- cubo central ---------
  const rHub = 0.062;
  const hub = 1 - smoothstep(rHub - 0.006, rHub + 0.006, r);
  if (hub > 0) {
    const shade = mixC([42, 54, 86], [12, 17, 36], clamp01((ny / rHub + 1) / 2));
    col = mixC(col, shade, hub);
    // aro luminoso
    const ring = Math.exp(-((r - rHub) ** 2) / 0.000045);
    col = mixC(col, CYAN, ring * 0.85);
  }

  // --------- vinheta e borda ---------
  const vig = 1 - smoothstep(0.26, 0.56, r) * 0.22;
  col = [col[0] * vig, col[1] * vig, col[2] * vig];

  const edge = smoothstep(-0.03, -0.002, dRect);
  col = mixC(col, [150, 175, 230], edge * 0.3);

  return [col[0], col[1], col[2], 255 * inside];
}

/** Renderiza um icone quadrado com supersampling 3x3. */
function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 3;
  const inv = 1 / (SS * SS);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const nx = (x + (sx + 0.5) / SS) / size - 0.5;
          const ny = (y + (sy + 0.5) / SS) / size - 0.5;
          const c = sample(nx, ny);
          // Pre-multiplica para a media nao escurecer as bordas.
          const af = c[3] / 255;
          r += c[0] * af;
          g += c[1] * af;
          b += c[2] * af;
          a += c[3];
        }
      }
      a *= inv;
      const af = a / 255;
      const i = (y * size + x) * 4;
      buf[i] = af > 0 ? Math.round(Math.min(255, (r * inv) / af)) : 0;
      buf[i + 1] = af > 0 ? Math.round(Math.min(255, (g * inv) / af)) : 0;
      buf[i + 2] = af > 0 ? Math.round(Math.min(255, (b * inv) / af)) : 0;
      buf[i + 3] = Math.round(a);
    }
  }
  return buf;
}

/* ------------------------------------------------------------------ */
/* ICO                                                                 */
/* ------------------------------------------------------------------ */

function buildICO(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reservado
  header.writeUInt16LE(1, 2); // tipo 1 = icone
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const bodies = [];

  pngs.forEach((p, i) => {
    const o = i * 16;
    dir[o] = p.size >= 256 ? 0 : p.size; // 0 significa 256
    dir[o + 1] = p.size >= 256 ? 0 : p.size;
    dir[o + 2] = 0; // paleta
    dir[o + 3] = 0; // reservado
    dir.writeUInt16LE(1, o + 4); // planos
    dir.writeUInt16LE(32, o + 6); // bits por pixel
    dir.writeUInt32LE(p.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += p.data.length;
    bodies.push(p.data);
  });

  return Buffer.concat([header, dir, ...bodies]);
}

/* ------------------------------------------------------------------ */

function main() {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = sizes.map((size) => {
    const rgba = render(size);
    return { size, data: encodePNG(rgba, size) };
  });

  const outDir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(outDir, { recursive: true });

  const ico = buildICO(pngs);
  fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);

  // PNG de 256 tambem fica salvo, util para divulgacao/atalhos.
  fs.writeFileSync(path.join(outDir, 'icon.png'), pngs[pngs.length - 1].data);

  console.log(
    'icon.ico gerado (' + sizes.join(', ') + ' px) - ' + (ico.length / 1024).toFixed(1) + ' KB'
  );
}

main();
