// Velocimetro circular animado (canvas 2D).
//
// A escala e nao-linear (segmentos iguais entre marcas), do mesmo jeito que
// medidores comerciais usam, para que 0-25 Mbps e 250-1000 Mbps ocupem
// espacos visuais comparaveis.

const START = Math.PI * 0.75; // 135 graus
const SWEEP = Math.PI * 1.5; //  270 graus de varredura

// Marcas da escala por unidade. Os segmentos tem larguras visuais iguais,
// entao faixas baixas e altas recebem espaco comparavel.
const STOPS_BY_UNIT = {
  mbps: [0, 1, 5, 10, 25, 50, 100, 250, 500, 1000],
  mbs: [0, 0.5, 1, 2, 5, 10, 25, 50, 100, 250],
};

const PALETTES = {
  idle: { a: '#3b82f6', b: '#6366f1', glow: 'rgba(99,102,241,0.55)' },
  latency: { a: '#60a5fa', b: '#6366f1', glow: 'rgba(96,165,250,0.6)' },
  download: { a: '#22d3ee', b: '#4f7dff', glow: 'rgba(34,211,238,0.65)' },
  upload: { a: '#a855f7', b: '#e879f9', glow: 'rgba(168,85,247,0.65)' },
  done: { a: '#34d399', b: '#22d3ee', glow: 'rgba(52,211,153,0.6)' },
};

/** Converte um valor na fracao 0..1 da varredura, dada a escala de marcas. */
export function valueToFraction(v, stops = STOPS_BY_UNIT.mbps) {
  if (!isFinite(v) || v <= 0) return 0;
  const last = stops.length - 1;
  if (v >= stops[last]) return 1;
  const segW = 1 / last;
  for (let i = 1; i <= last; i++) {
    if (v <= stops[i]) {
      const lo = stops[i - 1];
      const hi = stops[i];
      return (i - 1) * segW + ((v - lo) / (hi - lo)) * segW;
    }
  }
  return 1;
}

/** Formata o rotulo de uma marca sem decimais desnecessarios. */
function tickLabel(v) {
  if (v >= 10 || v === 0) return String(v);
  return String(v).replace('.', ',');
}

export class Gauge {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.phase = 'idle';
    this.unit = 'mbps';
    this.stops = STOPS_BY_UNIT.mbps;
    this.target = 0; // valor alvo na unidade de exibicao
    this.shown = 0; // Mbps suavizado (agulha)
    this.progress = 0; // 0..1 progresso da etapa
    this.shownProgress = 0;
    this.spin = 0;
    this.active = false;
    this.dpr = 1;
    this.w = 0;
    this.h = 0;

    this._raf = null;
    this._onFrame = this._frame.bind(this);

    this.resize();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement || canvas);
  }

  resize() {
    const host = this.canvas.parentElement || this.canvas;
    const rect = host.getBoundingClientRect();
    const w = Math.max(200, rect.width);
    const h = Math.max(200, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.w = w;
    this.h = h;
    this.draw();
  }

  /** Troca a escala e o rotulo conforme a unidade escolhida. */
  setUnit(unit) {
    this.unit = unit === 'mbs' ? 'mbs' : 'mbps';
    this.stops = STOPS_BY_UNIT[this.unit];
    this.draw();
  }

  setPhase(phase) {
    this.phase = phase;
    if (phase === 'idle' || phase === 'done') this.setProgress(phase === 'done' ? 1 : 0);
  }

  setValue(mbps) {
    this.target = Math.max(0, mbps || 0);
  }

  setProgress(p) {
    this.progress = Math.max(0, Math.min(1, p || 0));
  }

  /** Volta ao zero suavemente (troca de etapa). */
  reset() {
    this.target = 0;
    this.progress = 0;
  }

  start() {
    if (this._raf) return;
    this.active = true;
    const loop = () => {
      this._onFrame();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  /**
   * @param {boolean} snap  encerra exatamente no valor alvo. Necessario ao
   *   final do teste: se o loop parar durante a interpolacao, o mostrador
   *   congela num numero que nao e o resultado.
   */
  stop(snap = false) {
    this.active = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    if (snap) {
      this.shown = this.target;
      this.shownProgress = this.progress;
    }
    this.draw();
  }

  _frame() {
    // Suavizacao exponencial: a agulha persegue o alvo sem saltos.
    const diff = this.target - this.shown;
    const fast = this.unit === 'mbs' ? 7.5 : 60;
    this.shown += diff * (Math.abs(diff) > fast ? 0.16 : 0.1);
    if (Math.abs(diff) < 0.004) this.shown = this.target;

    this.shownProgress += (this.progress - this.shownProgress) * 0.12;
    this.spin += 0.0055;
    this.draw();
  }

  get currentValue() {
    return this.shown;
  }

  draw() {
    const { ctx, w, h, dpr } = this;
    const pal = PALETTES[this.phase] || PALETTES.idle;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2 - 10;
    const ringW = Math.max(10, R * 0.085);
    const rArc = R - ringW / 2 - R * 0.06;

    /* ---------- anel externo rotativo (so durante o teste) ---------- */
    if (this.active && this.phase !== 'idle' && this.phase !== 'done') {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(this.spin);
      ctx.beginPath();
      ctx.arc(0, 0, R - 1, 0, Math.PI * 2);
      ctx.strokeStyle = pal.glow;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([2, 13]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    /* ---------------------- marcas da escala ---------------------- */
    const rTickOut = rArc - ringW / 2 - R * 0.035;
    const rTickIn = rTickOut - R * 0.055;

    const stops = this.stops;
    for (let i = 0; i < stops.length; i++) {
      const frac = i / (stops.length - 1);
      const ang = START + SWEEP * frac;
      const lit = frac <= valueToFraction(this.shown, stops) + 0.001;

      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * rTickIn, cy + Math.sin(ang) * rTickIn);
      ctx.lineTo(cx + Math.cos(ang) * rTickOut, cy + Math.sin(ang) * rTickOut);
      ctx.strokeStyle = lit ? pal.a : 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.stroke();

      // Rotulo numerico
      const rLabel = rTickIn - R * 0.07;
      ctx.save();
      ctx.font = `${Math.max(8.5, R * 0.057)}px 'Segoe UI Variable Text', 'Segoe UI', sans-serif`;
      ctx.fillStyle = lit ? 'rgba(236,243,255,0.92)' : 'rgba(170,183,214,0.5)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        tickLabel(stops[i]),
        cx + Math.cos(ang) * rLabel,
        cy + Math.sin(ang) * rLabel
      );
      ctx.restore();

      // Marcas menores entre as principais
      if (i < stops.length - 1) {
        for (let k = 1; k < 5; k++) {
          const f2 = (i + k / 5) / (stops.length - 1);
          const a2 = START + SWEEP * f2;
          const o = rTickOut;
          const inn = rTickOut - R * 0.028;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a2) * inn, cy + Math.sin(a2) * inn);
          ctx.lineTo(cx + Math.cos(a2) * o, cy + Math.sin(a2) * o);
          ctx.strokeStyle =
            f2 <= valueToFraction(this.shown, stops) ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.12)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }

    /* ------------------------- trilho do arco ------------------------- */
    ctx.beginPath();
    ctx.arc(cx, cy, rArc, START, START + SWEEP);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = ringW;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Sombra interna do trilho, para dar profundidade
    ctx.beginPath();
    ctx.arc(cx, cy, rArc, START, START + SWEEP);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = ringW * 0.5;
    ctx.stroke();

    /* ----------------------- arco de velocidade ----------------------- */
    const frac = valueToFraction(this.shown, stops);
    if (frac > 0.002) {
      const end = START + SWEEP * frac;
      const grad = ctx.createLinearGradient(cx - rArc, cy - rArc, cx + rArc, cy + rArc);
      grad.addColorStop(0, pal.a);
      grad.addColorStop(1, pal.b);

      ctx.save();
      ctx.shadowColor = pal.glow;
      ctx.shadowBlur = ringW * 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, rArc, START, end);
      ctx.strokeStyle = grad;
      ctx.lineWidth = ringW;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.restore();

      // Ponto luminoso na ponta do arco
      const px = cx + Math.cos(end) * rArc;
      const py = cy + Math.sin(end) * rArc;
      ctx.save();
      ctx.shadowColor = '#fff';
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(px, py, ringW * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.restore();
    }

    /* ------------------- arco fino de progresso da etapa ------------------- */
    if (this.shownProgress > 0.001) {
      const rp = rArc + ringW / 2 + R * 0.028;
      ctx.beginPath();
      ctx.arc(cx, cy, rp, START, START + SWEEP * this.shownProgress);
      ctx.strokeStyle = pal.a;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    /* ------------------------- ponteiro ------------------------- */
    // Lamina flutuante: comeca fora da area do numero central, para nao
    // cruzar a leitura grande.
    const needleAng = START + SWEEP * frac;
    const bladeIn = R * 0.5;
    const bladeOut = rTickIn - R * 0.02;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(needleAng);
    ctx.shadowColor = pal.glow;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(bladeIn, -R * 0.021);
    ctx.lineTo(bladeOut, -R * 0.005);
    ctx.lineTo(bladeOut, R * 0.005);
    ctx.lineTo(bladeIn, R * 0.021);
    ctx.closePath();
    const ng = ctx.createLinearGradient(bladeIn, 0, bladeOut, 0);
    ng.addColorStop(0, pal.a);
    ng.addColorStop(1, '#ffffff');
    ctx.fillStyle = ng;
    ctx.fill();

    // Ponto de origem da lamina
    ctx.beginPath();
    ctx.arc(bladeIn - R * 0.016, 0, R * 0.017, 0, Math.PI * 2);
    ctx.fillStyle = pal.a;
    ctx.fill();
    ctx.restore();

    /* --------------------- anel interno decorativo --------------------- */
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.44, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.restore();
  }

  destroy() {
    this.stop();
    if (this._ro) this._ro.disconnect();
  }
}
