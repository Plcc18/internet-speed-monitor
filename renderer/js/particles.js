// Particulas discretas de fundo.
// Durante o download as particulas convergem para o centro; no upload elas
// se afastam. Pequeno detalhe que reforca o que esta acontecendo na tela.

const PALETTE = {
  idle: ['rgba(79,125,255,', 'rgba(34,211,238,'],
  latency: ['rgba(96,165,250,', 'rgba(129,140,248,'],
  download: ['rgba(34,211,238,', 'rgba(79,125,255,'],
  upload: ['rgba(168,85,247,', 'rgba(232,121,249,'],
  done: ['rgba(52,211,153,', 'rgba(34,211,238,'],
};

export class Particles {
  constructor(canvas, count = 58) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.count = count;
    this.mode = 'idle';
    this.intensity = 0;
    this.shownIntensity = 0;
    this.enabled = true;
    this.items = [];
    this.dpr = 1;
    this._raf = null;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.w = w;
    this.h = h;
    if (!this.items.length) this._seed();
  }

  _seed() {
    this.items = Array.from({ length: this.count }, () => this._make(true));
  }

  _make(initial) {
    const w = this.w || 1200;
    const h = this.h || 800;
    return {
      x: Math.random() * w,
      y: initial ? Math.random() * h : h + 10,
      r: 0.7 + Math.random() * 1.7,
      vx: (Math.random() - 0.5) * 0.14,
      vy: -(0.1 + Math.random() * 0.26),
      a: 0.16 + Math.random() * 0.4,
      hue: Math.random() < 0.5 ? 0 : 1,
      tw: Math.random() * Math.PI * 2, // fase do cintilar
      tws: 0.012 + Math.random() * 0.025,
    };
  }

  setMode(mode) {
    this.mode = mode in PALETTE ? mode : 'idle';
    this.intensity = mode === 'download' || mode === 'upload' ? 1 : mode === 'latency' ? 0.45 : 0;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      this.stop();
      const { ctx } = this;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    } else {
      this.start();
    }
  }

  start() {
    if (this._raf || !this.enabled) return;
    const loop = () => {
      this._step();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _step() {
    const { ctx, w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    this.shownIntensity += (this.intensity - this.shownIntensity) * 0.04;
    const boost = 1 + this.shownIntensity * 2.6;
    const colors = PALETTE[this.mode];
    const cx = w / 2;
    const cy = h / 2;

    // Atracao (download) ou repulsao (upload) em relacao ao centro.
    const pull =
      this.mode === 'download' ? 0.055 : this.mode === 'upload' ? -0.055 : 0;
    const pullNow = pull * this.shownIntensity;

    for (let i = 0; i < this.items.length; i++) {
      const p = this.items[i];

      if (pullNow !== 0) {
        const dx = cx - p.x;
        const dy = cy - p.y;
        const d = Math.max(60, Math.hypot(dx, dy));
        p.vx += (dx / d) * pullNow;
        p.vy += (dy / d) * pullNow;
      }

      // Atrito, para as velocidades nao crescerem sem limite.
      p.vx *= 0.985;
      p.vy = p.vy * 0.985 - 0.0012;

      p.x += p.vx * boost;
      p.y += p.vy * boost;
      p.tw += p.tws;

      // Reciclagem nas bordas
      if (p.y < -12 || p.y > h + 12 || p.x < -12 || p.x > w + 12) {
        this.items[i] = this._make(false);
        continue;
      }

      const twinkle = 0.65 + 0.35 * Math.sin(p.tw);
      const alpha = p.a * twinkle * (0.7 + this.shownIntensity * 0.5);
      const color = colors[p.hue] + alpha.toFixed(3) + ')';

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // Rastro leve nas particulas rapidas durante o teste
      const speed = Math.hypot(p.vx, p.vy) * boost;
      if (speed > 0.9) {
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * boost * 5, p.y - p.vy * boost * 5);
        ctx.strokeStyle = colors[p.hue] + (alpha * 0.5).toFixed(3) + ')';
        ctx.lineWidth = p.r * 0.7;
        ctx.lineCap = 'round';
        ctx.stroke();
      }
    }
  }
}
