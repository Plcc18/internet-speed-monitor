// Graficos em canvas: velocidade em tempo real e evolucao do historico.

const COLORS = {
  download: { line: '#22d3ee', line2: '#4f7dff', fill: 'rgba(34,211,238,0.22)' },
  upload: { line: '#a855f7', line2: '#e879f9', fill: 'rgba(168,85,247,0.2)' },
};

/** Arredonda o topo do eixo Y para um valor "redondo" agradavel. */
function niceMax(v) {
  if (!isFinite(v) || v <= 0) return 10;
  const steps = [5, 10, 25, 50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2500, 5000];
  const target = v * 1.18;
  for (const s of steps) if (target <= s) return s;
  return Math.ceil(target / 1000) * 1000;
}

/** Rotulo do eixo Y no padrao pt-BR, sem decimais desnecessarios. */
function axisLabel(v, scaleMax) {
  if (v <= 0) return '0';
  const decimals = scaleMax >= 20 ? 0 : 1;
  return v.toFixed(decimals).replace('.', ',');
}

/** Media movel para suavizar o ruido dos bins de 100 ms. */
function smooth(arr, win = 3) {
  if (arr.length < win) return arr.slice();
  const out = new Array(arr.length);
  const half = Math.floor(win / 2);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0;
    let n = 0;
    for (let k = i - half; k <= i + half; k++) {
      if (k >= 0 && k < arr.length) {
        sum += arr[k];
        n++;
      }
    }
    out[i] = sum / n;
  }
  return out;
}

class CanvasBase {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    // So desenha depois que a subclasse terminar de montar seu estado.
    this._mounted = false;
    this.resize();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(80, rect.width);
    const h = Math.max(60, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.w = w;
    this.h = h;
    if (this._mounted) this.draw();
  }

  /** Chamado pela subclasse ao fim do construtor. */
  mount() {
    this._mounted = true;
    this.draw();
  }

  begin() {
    const { ctx, dpr, w, h } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
  }
}

/* ===================================================================
   Grafico de velocidade em tempo real
   =================================================================== */

export class LiveChart extends CanvasBase {
  constructor(canvas) {
    super(canvas);
    this.data = { download: [], upload: [] };
    this.yMax = 10;
    this.yMaxShown = 10;
    this.anim = null;
    this.mount();
  }

  reset() {
    this.data = { download: [], upload: [] };
    this.yMax = 10;
    this.yMaxShown = 10;
    this.draw();
  }

  setSeries(phase, series) {
    if (!this.data[phase]) return;
    this.data[phase] = series || [];
    // O topo do eixo sai da serie suavizada: picos isolados de um unico bin
    // de 100 ms esticavam a escala e achatavam a curva real.
    const all = smooth(this.data.download, 5).concat(smooth(this.data.upload, 5));
    this.yMax = niceMax(all.length ? Math.max.apply(null, all) : 0);
  }

  /** Loop de animacao proprio: so roda enquanto o teste acontece. */
  start() {
    if (this.anim) return;
    const loop = () => {
      this.yMaxShown += (this.yMax - this.yMaxShown) * 0.1;
      this.draw();
      this.anim = requestAnimationFrame(loop);
    };
    this.anim = requestAnimationFrame(loop);
  }

  stop() {
    if (this.anim) cancelAnimationFrame(this.anim);
    this.anim = null;
    this.yMaxShown = this.yMax;
    this.draw();
  }

  draw() {
    const { ctx, w, h } = this;
    if (!ctx) return;
    this.begin();

    const padL = 36;
    const padR = 8;
    const padT = 10;
    const padB = 16;
    const gw = w - padL - padR;
    const gh = h - padT - padB;
    if (gw <= 0 || gh <= 0) return;

    const yMax = Math.max(1, this.yMaxShown);

    /* ----------------------- grade e eixo Y ----------------------- */
    ctx.font = "9.5px 'Segoe UI Variable Text', 'Segoe UI', sans-serif";
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const y = padT + (gh * i) / 4;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.strokeStyle = i === 4 ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.045)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = 'rgba(140,155,190,0.65)';
      ctx.fillText(axisLabel(yMax * (1 - i / 4), yMax), padL - 7, y);
    }

    const total = this.data.download.length + this.data.upload.length;
    if (!total) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(120,134,168,0.6)';
      ctx.font = "11px 'Segoe UI Variable Text', 'Segoe UI', sans-serif";
      ctx.fillText('Aguardando o inicio do teste', padL + gw / 2, padT + gh / 2);
      return;
    }

    // Mostra sempre a linha do tempo completa das duas fases em sequencia.
    const span = Math.max(total, 40);
    const dx = gw / span;
    let offset = 0;

    for (const phase of ['download', 'upload']) {
      const raw = this.data[phase];
      if (raw.length) {
        this._drawSeries(smooth(raw), phase, padL, padT, gh, dx, offset, yMax);
      }
      offset += raw.length;
    }

    /* ------------- divisoria entre as fases ------------- */
    if (this.data.download.length && this.data.upload.length) {
      const x = padL + this.data.download.length * dx;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + gh);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  _drawSeries(data, phase, padL, padT, gh, dx, offset, yMax) {
    const { ctx } = this;
    const c = COLORS[phase];
    const xAt = (i) => padL + (offset + i) * dx;
    const yAt = (v) => padT + gh - Math.min(1, v / yMax) * gh;

    // Area preenchida
    ctx.beginPath();
    ctx.moveTo(xAt(0), padT + gh);
    for (let i = 0; i < data.length; i++) ctx.lineTo(xAt(i), yAt(data[i]));
    ctx.lineTo(xAt(data.length - 1), padT + gh);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, padT, 0, padT + gh);
    fill.addColorStop(0, c.fill);
    fill.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fill;
    ctx.fill();

    // Linha com brilho
    ctx.save();
    ctx.shadowColor = c.line;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = xAt(i);
      const y = yAt(data[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    const stroke = ctx.createLinearGradient(xAt(0), 0, xAt(data.length - 1), 0);
    stroke.addColorStop(0, c.line);
    stroke.addColorStop(1, c.line2);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();

    // Ponto na extremidade atual
    const lx = xAt(data.length - 1);
    const ly = yAt(data[data.length - 1]);
    ctx.save();
    ctx.shadowColor = c.line;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(lx, ly, 2.8, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.restore();
  }
}

/* ===================================================================
   Grafico de evolucao do historico
   =================================================================== */

export class HistoryChart extends CanvasBase {
  constructor(canvas) {
    super(canvas);
    this.history = [];
    this.hover = -1;
    this.reveal = 1;

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.hover = this._indexAt(e.clientX - rect.left);
      this.draw();
    });
    canvas.addEventListener('mouseleave', () => {
      this.hover = -1;
      this.draw();
    });

    this.mount();
  }

  setHistory(history) {
    // Mais antigo a esquerda, mais recente a direita.
    this.history = (history || []).slice(0, 20).reverse();
    this.reveal = 0;
    this._animateReveal();
  }

  _animateReveal() {
    if (this._raf) cancelAnimationFrame(this._raf);
    const step = () => {
      this.reveal = Math.min(1, this.reveal + 0.055);
      this.draw();
      if (this.reveal < 1) this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  _geom() {
    const padL = 30;
    const padR = 8;
    const padT = 10;
    const padB = 14;
    return {
      padL,
      padR,
      padT,
      padB,
      gw: this.w - padL - padR,
      gh: this.h - padT - padB,
    };
  }

  _indexAt(x) {
    const { padL, gw } = this._geom();
    const n = this.history.length;
    if (n === 0 || gw <= 0) return -1;
    const step = n > 1 ? gw / (n - 1) : gw;
    const i = Math.round((x - padL) / step);
    return i >= 0 && i < n ? i : -1;
  }

  draw() {
    const { ctx, w, h } = this;
    if (!ctx) return;
    this.begin();

    const { padL, padR, padT, gh, gw } = this._geom();
    if (gw <= 0 || gh <= 0) return;

    const n = this.history.length;
    if (n === 0) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(120,134,168,0.55)';
      ctx.font = "10.5px 'Segoe UI Variable Text', 'Segoe UI', sans-serif";
      ctx.fillText('A evolucao aparece apos o primeiro teste', w / 2, h / 2);
      return;
    }

    const downs = this.history.map((r) => (r.download && r.download.mbps) || 0);
    const ups = this.history.map((r) => (r.upload && r.upload.mbps) || 0);
    const yMax = niceMax(Math.max.apply(null, downs.concat(ups)));

    const step = n > 1 ? gw / (n - 1) : 0;
    const xAt = (i) => padL + i * step + (n === 1 ? gw / 2 : 0);
    const yAt = (v) => padT + gh - Math.min(1, v / yMax) * gh;

    /* grade */
    ctx.font = "9px 'Segoe UI Variable Text', 'Segoe UI', sans-serif";
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 2; i++) {
      const y = padT + (gh * i) / 2;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(140,155,190,0.6)';
      ctx.fillText(axisLabel(yMax * (1 - i / 2), yMax), padL - 6, y);
    }

    const shown = Math.max(1, Math.ceil(n * this.reveal));

    const series = [
      { vals: downs, c: COLORS.download },
      { vals: ups, c: COLORS.upload },
    ];

    for (const s of series) {
      // area
      ctx.beginPath();
      ctx.moveTo(xAt(0), padT + gh);
      for (let i = 0; i < shown; i++) ctx.lineTo(xAt(i), yAt(s.vals[i]));
      ctx.lineTo(xAt(shown - 1), padT + gh);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, padT, 0, padT + gh);
      g.addColorStop(0, s.c.fill);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fill();

      // linha
      ctx.save();
      ctx.shadowColor = s.c.line;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      for (let i = 0; i < shown; i++) {
        const x = xAt(i);
        const y = yAt(s.vals[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = s.c.line;
      ctx.lineWidth = 1.8;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();

      // pontos
      for (let i = 0; i < shown; i++) {
        const isHover = i === this.hover;
        ctx.beginPath();
        ctx.arc(xAt(i), yAt(s.vals[i]), isHover ? 3.6 : 2, 0, Math.PI * 2);
        ctx.fillStyle = isHover ? '#fff' : s.c.line;
        ctx.fill();
      }
    }

    /* tooltip */
    if (this.hover >= 0 && this.hover < shown) {
      const i = this.hover;
      const x = xAt(i);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + gh);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.setLineDash([2, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      const label = downs[i].toFixed(1) + ' / ' + ups[i].toFixed(1);
      ctx.font = "10px 'Segoe UI Variable Text', 'Segoe UI', sans-serif";
      const tw = ctx.measureText(label).width + 14;
      const tx = Math.min(Math.max(x - tw / 2, padL), w - padR - tw);
      const ty = padT + 1;
      ctx.fillStyle = 'rgba(10,14,26,0.94)';
      ctx.beginPath();
      ctx.roundRect(tx, ty, tw, 17, 5);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#e6ecfb';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, tx + tw / 2, ty + 9);
    }
  }
}
