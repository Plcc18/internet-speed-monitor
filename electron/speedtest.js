'use strict';
/**
 * Internet Speed Monitor - motor de medicao real.
 *
 * Download/upload usam a infraestrutura publica de medicao da Cloudflare
 * (speed.cloudflare.com), a mesma que alimenta o speed test oficial deles:
 *   GET  /__down?bytes=N   -> entrega N bytes incompressiveis (max. 25 MB)
 *   POST /__up             -> descarta o corpo enviado
 *   GET  /cdn-cgi/trace    -> IP, datacenter (colo) e pais do cliente
 *
 * A Cloudflare aplica rate limit por janela curta. Quando isso acontece
 * (HTTP 429) o motor aplica backoff e, se nao receber nenhum byte, troca
 * automaticamente para a CDN CacheFly.
 *
 * Nenhum valor e simulado: todas as taxas vem de bytes realmente transferidos
 * pelo socket, agrupados em bins temporais de 100 ms.
 */

const https = require('https');
const crypto = require('crypto');

const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CFG = {
  // Latencia
  latencySamples: 16,
  latencyGapMs: 45,
  // Download
  downStreams: 6,
  downDurationMs: 12000,
  // Upload
  upStreams: 4,
  upDurationMs: 10000,
  upWriteChunk: 64 * 1024, // granularidade da escrita no socket
  upPayloadBytes: 2 * 1024 * 1024, // buffer aleatorio reaproveitado
  upStartBytes: 2 * 1024 * 1024, // tamanho inicial de cada POST
  upTargetMs: 2000, // duracao alvo por POST (ajuste adaptativo)
  upMinBytes: 256 * 1024,
  upMaxBytes: 24 * 1024 * 1024,
  // Troca de provedor: se nada chegou nesse tempo, tenta o proximo.
  providerProbeMs: 3000,
  // Analise
  binMs: 100,
  warmupRatio: 0.25,
  minWarmupMs: 1500,
  instantWindowMs: 800,
  peakWindowMs: 2000,
  requestTimeoutMs: 20000,
  maxBackoffMs: 2000,
};

const LATENCY_HOST = 'speed.cloudflare.com';

/** Provedores de download, em ordem de preferencia. */
const DOWN_PROVIDERS = [
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    host: 'speed.cloudflare.com',
    chunk: 25 * 1024 * 1024,
    path: (chunk, nonce) => '/__down?bytes=' + chunk + '&r=' + nonce,
    useRange: false,
  },
  {
    id: 'cachefly',
    name: 'CacheFly',
    host: 'cachefly.cachefly.net',
    chunk: 50 * 1024 * 1024,
    path: (chunk, nonce) => '/100mb.test?r=' + nonce,
    useRange: true,
  },
];

/** Provedores de upload, em ordem de preferencia. */
const UP_PROVIDERS = [
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    host: 'speed.cloudflare.com',
    path: '/__up',
  },
];

/* ------------------------------------------------------------------ */
/* Utilitarios                                                         */
/* ------------------------------------------------------------------ */

function once(fn) {
  let called = false;
  return (...args) => {
    if (called) return undefined;
    called = true;
    return fn(...args);
  };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function round(v, d) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function backoffFor(failures) {
  return Math.min(CFG.maxBackoffMs, 250 * 2 ** (failures - 1));
}

/**
 * Agrupa bytes transferidos em bins de tempo fixos, o que permite separar
 * velocidade instantanea (animacao) de velocidade final (resultado).
 */
class Sampler {
  constructor(binMs = CFG.binMs) {
    this.binMs = binMs;
    this.bins = [];
    this.totalBytes = 0;
    this.t0 = 0;
    this.tLast = 0;
  }

  begin() {
    this.t0 = now();
    this.tLast = this.t0;
  }

  add(bytes) {
    if (!this.t0) this.begin();
    this.totalBytes += bytes;
    this.tLast = now();
    const idx = Math.floor((this.tLast - this.t0) / this.binMs);
    while (this.bins.length <= idx) this.bins.push(0);
    this.bins[idx] += bytes;
  }

  /**
   * Distribui `bytes` uniformemente entre dois instantes. Usado no upload,
   * onde so sabemos que N bytes atravessaram a rede entre o inicio da
   * requisicao e a resposta do servidor.
   */
  addSpan(bytes, startMs, endMs) {
    if (!this.t0) this.begin();
    if (bytes <= 0) return;
    const dur = Math.max(1, endMs - startMs);
    this.totalBytes += bytes;
    this.tLast = Math.max(this.tLast, endMs);

    const first = Math.max(0, Math.floor((startMs - this.t0) / this.binMs));
    const last = Math.max(first, Math.floor((endMs - this.t0) / this.binMs));
    while (this.bins.length <= last) this.bins.push(0);

    // Reparte proporcionalmente a fatia de tempo que cada bin cobre.
    for (let i = first; i <= last; i++) {
      const binStart = this.t0 + i * this.binMs;
      const binEnd = binStart + this.binMs;
      const overlap = Math.min(endMs, binEnd) - Math.max(startMs, binStart);
      if (overlap > 0) this.bins[i] += bytes * (overlap / dur);
    }
  }

  get elapsedMs() {
    return this.t0 ? this.tLast - this.t0 : 0;
  }

  static mbps(bytes, ms) {
    if (ms <= 0) return 0;
    return (bytes * 8) / (ms * 1000);
  }

  /** Taxa dos ultimos ~800 ms - usada apenas para animar o velocimetro. */
  instantMbps() {
    const n = Math.max(1, Math.round(CFG.instantWindowMs / this.binMs));
    const slice = this.bins.slice(-n);
    if (!slice.length) return 0;
    return Sampler.mbps(slice.reduce((a, b) => a + b, 0), slice.length * this.binMs);
  }

  /** Media global, incluindo a rampa inicial. */
  averageMbps() {
    return Sampler.mbps(this.totalBytes, this.elapsedMs);
  }

  /**
   * Resultado oficial: descarta a rampa de aceleracao TCP (slow start) e o
   * ultimo bin (parcial), e calcula a vazao agregada da janela estavel.
   */
  finalMbps() {
    const n = this.bins.length;
    if (n < 4) return this.averageMbps();
    const warmBins = Math.max(
      Math.ceil(CFG.minWarmupMs / this.binMs),
      Math.floor(n * CFG.warmupRatio)
    );
    const from = Math.min(warmBins, n - 3);
    const slice = this.bins.slice(from, n - 1);
    if (!slice.length) return this.averageMbps();
    return Sampler.mbps(slice.reduce((a, b) => a + b, 0), slice.length * this.binMs);
  }

  /** Melhor media sustentada de 2 s - exibida como "pico". */
  peakMbps() {
    const w = Math.max(1, Math.round(CFG.peakWindowMs / this.binMs));
    if (this.bins.length < w) return this.instantMbps();
    let best = 0;
    let sum = 0;
    for (let i = 0; i < this.bins.length; i++) {
      sum += this.bins[i];
      if (i >= w) sum -= this.bins[i - w];
      if (i >= w - 1) best = Math.max(best, sum);
    }
    return Sampler.mbps(best, w * this.binMs);
  }

  /** Serie temporal (Mbps por bin) para o grafico em tempo real. */
  series() {
    return this.bins.map((b) => Sampler.mbps(b, this.binMs));
  }
}

/* ------------------------------------------------------------------ */
/* Controle de execucao                                                */
/* ------------------------------------------------------------------ */

class TestController {
  constructor() {
    this.aborted = false;
    this.agent = new https.Agent({
      keepAlive: true,
      maxSockets: 64,
      timeout: CFG.requestTimeoutMs,
    });
    this.sockets = new Set();
  }

  track(req) {
    req.on('socket', (s) => {
      // Varias requisicoes reutilizam o mesmo socket keep-alive; sem isso o
      // Node emite MaxListenersExceededWarning.
      s.setMaxListeners(0);
      this.sockets.add(s);
      s.once('close', () => this.sockets.delete(s));
    });
  }

  abort() {
    this.aborted = true;
    for (const s of this.sockets) {
      try {
        s.destroy();
      } catch (_) { /* ignore */ }
    }
    this.sockets.clear();
    this.dispose();
  }

  dispose() {
    try {
      this.agent.destroy();
    } catch (_) { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/* Informacoes do servidor                                             */
/* ------------------------------------------------------------------ */

const COLOS = {
  GRU: 'Sao Paulo, BR', GIG: 'Rio de Janeiro, BR', FOR: 'Fortaleza, BR',
  POA: 'Porto Alegre, BR', CWB: 'Curitiba, BR', BNU: 'Blumenau, BR',
  CNF: 'Belo Horizonte, BR', BSB: 'Brasilia, BR', REC: 'Recife, BR',
  SSA: 'Salvador, BR', FLN: 'Florianopolis, BR', MAO: 'Manaus, BR',
  BEL: 'Belem, BR', VCP: 'Campinas, BR', JOI: 'Joinville, BR',
  ITJ: 'Itajai, BR', NAT: 'Natal, BR', SOD: 'Sorocaba, BR',
  EZE: 'Buenos Aires, AR', SCL: 'Santiago, CL', LIM: 'Lima, PE',
  BOG: 'Bogota, CO', MEX: 'Cidade do Mexico, MX', MIA: 'Miami, US',
  IAD: 'Ashburn, US', ATL: 'Atlanta, US', LAX: 'Los Angeles, US',
  DFW: 'Dallas, US', EWR: 'Newark, US', LIS: 'Lisboa, PT',
  MAD: 'Madrid, ES', LHR: 'Londres, UK', CDG: 'Paris, FR',
  FRA: 'Frankfurt, DE', AMS: 'Amsterda, NL',
};

function fetchServerInfo(ctl) {
  return new Promise((resolve) => {
    const req = https.get(
      { host: LATENCY_HOST, path: '/cdn-cgi/trace', agent: ctl.agent },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          const kv = {};
          for (const line of body.split('\n')) {
            const i = line.indexOf('=');
            if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
          }
          const colo = (kv.colo || '').toUpperCase();
          resolve({
            ip: kv.ip || '-',
            colo: colo || '-',
            location: COLOS[colo] || (kv.loc ? colo + ' (' + kv.loc + ')' : colo || '-'),
            country: kv.loc || '',
            provider: 'Cloudflare',
            tls: kv.tls || '',
          });
        });
        res.on('error', () => resolve(null));
      }
    );
    ctl.track(req);
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
  });
}

/* ------------------------------------------------------------------ */
/* Fase 1 - Latencia / Ping / Jitter                                   */
/* ------------------------------------------------------------------ */

function probeLatency(ctl) {
  return new Promise((resolve, reject) => {
    const t0 = now();
    const req = https.get(
      {
        host: LATENCY_HOST,
        path: '/__down?bytes=0',
        agent: ctl.agent,
        headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
      },
      (res) => {
        const ttfb = now() - t0;
        // Desconta o tempo de processamento no servidor para isolar a rede.
        let serverMs = 0;
        const st = res.headers['server-timing'];
        if (st) {
          const m = /cfRequestDuration;dur=([\d.]+)/i.exec(st);
          if (m) serverMs = parseFloat(m[1]) || 0;
        }
        res.resume();
        res.on('end', () => resolve(Math.max(0.1, ttfb - serverMs)));
        res.on('error', reject);
      }
    );
    ctl.track(req);
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('latency timeout')));
  });
}

/** Jitter = media das variacoes absolutas entre amostras consecutivas. */
function jitterOf(samples) {
  if (samples.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < samples.length; i++) sum += Math.abs(samples[i] - samples[i - 1]);
  return sum / (samples.length - 1);
}

async function measureLatency(ctl, onProgress) {
  const samples = [];
  // A primeira chamada aquece a conexao (TCP + TLS) e e descartada.
  try {
    await probeLatency(ctl);
  } catch (_) { /* ignore */ }

  for (let i = 0; i < CFG.latencySamples; i++) {
    if (ctl.aborted) break;
    try {
      samples.push(await probeLatency(ctl));
    } catch (_) { /* amostra perdida */ }
    onProgress({
      progress: (i + 1) / CFG.latencySamples,
      ping: median(samples),
      jitter: jitterOf(samples),
      samples: samples.length,
    });
    if (i < CFG.latencySamples - 1) await sleep(CFG.latencyGapMs);
  }

  if (ctl.aborted) throw new Error('aborted');
  if (!samples.length) {
    throw new Error('Nao foi possivel medir a latencia. Verifique sua conexao.');
  }

  return {
    ping: median(samples),
    jitter: jitterOf(samples),
    minPing: Math.min.apply(null, samples),
    maxPing: Math.max.apply(null, samples),
    samples,
  };
}

/* ------------------------------------------------------------------ */
/* Fase 2 - Download                                                   */
/* ------------------------------------------------------------------ */

function downloadStream(ctl, state, provider, sampler, deadline) {
  return new Promise((resolve) => {
    const finish = once(resolve);
    let failures = 0;

    const loop = () => {
      if (ctl.aborted || state.giveUp || now() >= deadline) return finish();

      const nonce = Math.random().toString(36).slice(2);
      const headers = { 'cache-control': 'no-cache', pragma: 'no-cache' };
      if (provider.useRange) headers.range = 'bytes=0-' + (provider.chunk - 1);

      const req = https.get(
        {
          host: provider.host,
          path: provider.path(provider.chunk, nonce),
          agent: ctl.agent,
          headers,
        },
        (res) => {
          const retry = once(() => {
            const wait = failures ? backoffFor(failures) : 0;
            setTimeout(loop, wait);
          });

          if (res.statusCode !== 200 && res.statusCode !== 206) {
            failures++;
            state.lastStatus = res.statusCode;
            if (res.statusCode === 429) state.rateLimited = true;
            res.resume();
            res.on('end', retry);
            res.on('close', retry);
            res.on('error', retry);
            return;
          }

          failures = 0;
          res.on('data', (chunk) => {
            sampler.add(chunk.length);
            if (ctl.aborted || state.giveUp || now() >= deadline) res.destroy();
          });
          res.on('end', retry);
          res.on('close', retry);
          res.on('error', retry);
        }
      );

      ctl.track(req);
      req.on('error', () => {
        failures++;
        state.lastError = 'rede';
        if (failures >= 5) return finish();
        setTimeout(loop, backoffFor(failures));
      });
      req.setTimeout(CFG.requestTimeoutMs, () => req.destroy(new Error('download timeout')));
    };

    loop();
  });
}

/** Uma tentativa completa com um provedor. Retorna null se nada foi recebido. */
async function attemptDownload(ctl, provider, onProgress) {
  const sampler = new Sampler();
  const state = { giveUp: false, rateLimited: false, lastStatus: 0, lastError: '' };

  sampler.begin();
  const t0 = now();
  const deadline = t0 + CFG.downDurationMs;

  // Se o provedor nao entregar nada nos primeiros segundos, desiste dele.
  const probe = setTimeout(() => {
    if (!sampler.totalBytes) state.giveUp = true;
  }, CFG.providerProbeMs);

  const ticker = setInterval(() => {
    onProgress({
      progress: Math.min(1, (now() - t0) / CFG.downDurationMs),
      instantMbps: sampler.instantMbps(),
      runningMbps: sampler.finalMbps(),
      bytes: sampler.totalBytes,
      series: sampler.series(),
      provider: provider.name,
    });
  }, 100);

  try {
    await Promise.all(
      Array.from({ length: CFG.downStreams }, () =>
        downloadStream(ctl, state, provider, sampler, deadline)
      )
    );
  } finally {
    clearTimeout(probe);
    clearInterval(ticker);
  }

  if (!sampler.totalBytes) return { ok: false, state };

  return {
    ok: true,
    state,
    result: {
      mbps: sampler.finalMbps(),
      peakMbps: sampler.peakMbps(),
      averageMbps: sampler.averageMbps(),
      bytes: sampler.totalBytes,
      durationMs: sampler.elapsedMs,
      series: sampler.series(),
      provider: provider.name,
      rateLimited: state.rateLimited,
    },
  };
}

async function measureDownload(ctl, onProgress, onNotice) {
  let last = null;
  for (const provider of DOWN_PROVIDERS) {
    if (ctl.aborted) throw new Error('aborted');
    const attempt = await attemptDownload(ctl, provider, onProgress);
    if (attempt.ok) return attempt.result;
    if (ctl.aborted) throw new Error('aborted');
    last = attempt.state;
    if (onNotice) {
      onNotice(
        'Sem resposta de ' + provider.name +
          (last.lastStatus ? ' (HTTP ' + last.lastStatus + ')' : '') +
          '. Tentando outro servidor...'
      );
    }
  }
  if (ctl.aborted) throw new Error('aborted');
  const detail = last && last.lastStatus === 429
    ? 'Os servidores de teste aplicaram limite temporario de requisicoes. Aguarde um instante e tente novamente.'
    : 'Nenhum dado recebido no teste de download. Verifique sua conexao.';
  throw new Error(detail);
}

/* ------------------------------------------------------------------ */
/* Fase 3 - Upload                                                     */
/* ------------------------------------------------------------------ */

/**
 * Envia um POST de tamanho conhecido e cronometra ate a resposta do servidor.
 *
 * Contar bytes no callback de req.write() nao funciona: ele dispara quando o
 * chunk entra no buffer do socket, nao quando sai da maquina, o que infla a
 * medicao em varias vezes. Ja a resposta HTTP so chega depois que o corpo
 * inteiro atravessou a rede, entao o par (bytes, tempo ate a resposta)
 * reflete a vazao real de subida.
 */
function uploadRequest(ctl, provider, sizeBytes, payload) {
  return new Promise((resolve) => {
    const started = now();
    const done = once((res) => resolve(res));

    const req = https.request(
      {
        host: provider.host,
        path: provider.path,
        method: 'POST',
        agent: ctl.agent,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(sizeBytes),
          'cache-control': 'no-cache',
        },
      },
      (res) => {
        const status = res.statusCode;
        res.resume();
        res.on('end', () =>
          done({ ok: status < 400, status, bytes: sizeBytes, start: started, end: now() })
        );
        res.on('error', () => done({ ok: false, status, bytes: 0, start: started, end: now() }));
      }
    );

    ctl.track(req);
    req.on('error', () => done({ ok: false, status: 0, bytes: 0, start: started, end: now() }));
    req.setTimeout(CFG.requestTimeoutMs, () => {
      req.destroy(new Error('upload timeout'));
      done({ ok: false, status: 0, bytes: 0, start: started, end: now() });
    });

    // Escreve o corpo em blocos, respeitando a contrapressao do socket.
    let sent = 0;
    const pump = () => {
      if (ctl.aborted || req.destroyed) {
        try {
          req.destroy();
        } catch (_) { /* ignore */ }
        return done({ ok: false, status: 0, bytes: 0, start: started, end: now() });
      }
      while (sent < sizeBytes) {
        const n = Math.min(CFG.upWriteChunk, sizeBytes - sent);
        const chunk = n === payload.length ? payload : payload.subarray(0, n);
        sent += n;
        if (!req.write(chunk)) {
          req.once('drain', pump);
          return undefined;
        }
      }
      req.end();
      return undefined;
    };
    pump();
  });
}

/** Um fluxo de upload: requisicoes sequenciais de tamanho adaptativo. */
function uploadStream(ctl, state, provider, sampler, deadline, payload) {
  let size = CFG.upStartBytes;
  let failures = 0;

  return (async () => {
    while (!ctl.aborted && !state.giveUp && now() < deadline) {
      const r = await uploadRequest(ctl, provider, size, payload);

      if (!r.ok) {
        failures++;
        if (r.status === 429) state.rateLimited = true;
        if (r.status) state.lastStatus = r.status;
        if (failures >= 4) break;
        await sleep(backoffFor(failures));
        continue;
      }

      failures = 0;
      sampler.addSpan(r.bytes, r.start, r.end);

      // Ajusta o tamanho para cada POST durar ~upTargetMs: requisicoes curtas
      // demais sao dominadas pelo RTT, longas demais engessam o grafico.
      const dur = Math.max(1, r.end - r.start);
      const scaled = size * (CFG.upTargetMs / dur);
      size = Math.round(
        Math.max(CFG.upMinBytes, Math.min(CFG.upMaxBytes, size * 0.4 + scaled * 0.6))
      );
    }
  })();
}

async function attemptUpload(ctl, provider, onProgress, payload) {
  const sampler = new Sampler();
  const state = { giveUp: false, rateLimited: false, lastStatus: 0 };

  sampler.begin();
  const t0 = now();
  const deadline = t0 + CFG.upDurationMs;

  // Os primeiros POSTs levam alguns segundos; da mais folga antes de declarar
  // o provedor indisponivel.
  const probe = setTimeout(() => {
    if (!sampler.totalBytes) state.giveUp = true;
  }, CFG.providerProbeMs + CFG.upTargetMs * 2);

  const ticker = setInterval(() => {
    onProgress({
      progress: Math.min(1, (now() - t0) / CFG.upDurationMs),
      instantMbps: sampler.instantMbps(),
      runningMbps: sampler.finalMbps(),
      bytes: sampler.totalBytes,
      series: sampler.series(),
      provider: provider.name,
    });
  }, 100);

  try {
    await Promise.all(
      Array.from({ length: CFG.upStreams }, () =>
        uploadStream(ctl, state, provider, sampler, deadline, payload)
      )
    );
  } finally {
    clearTimeout(probe);
    clearInterval(ticker);
  }

  if (!sampler.totalBytes) return { ok: false, state };

  return {
    ok: true,
    state,
    result: {
      mbps: sampler.finalMbps(),
      peakMbps: sampler.peakMbps(),
      averageMbps: sampler.averageMbps(),
      bytes: sampler.totalBytes,
      durationMs: sampler.elapsedMs,
      series: sampler.series(),
      provider: provider.name,
      rateLimited: state.rateLimited,
    },
  };
}

async function measureUpload(ctl, onProgress, onNotice) {
  // Dados aleatorios: incompressiveis, impedem otimizacao no caminho.
  const payload = crypto.randomBytes(CFG.upPayloadBytes);

  let last = null;
  for (const provider of UP_PROVIDERS) {
    if (ctl.aborted) throw new Error('aborted');
    const attempt = await attemptUpload(ctl, provider, onProgress, payload);
    if (attempt.ok) return attempt.result;
    last = attempt.state;
    if (onNotice) {
      onNotice(
        'Sem resposta de ' + provider.name + ' no upload' +
          (last.lastStatus ? ' (HTTP ' + last.lastStatus + ')' : '') + '.'
      );
    }
  }
  // Falha de upload nao invalida o teste: o resultado e salvo sem essa metrica.
  return null;
}

/* ------------------------------------------------------------------ */
/* Nota da conexao                                                     */
/* ------------------------------------------------------------------ */

function gradeOf(down, up, ping, jitter) {
  const sDown = Math.min(1, Math.log10(1 + down) / Math.log10(501));
  const sUp = Math.min(1, Math.log10(1 + up) / Math.log10(251));
  const sPing = Math.max(0, 1 - Math.min(1, (ping - 5) / 145));
  const sJit = Math.max(0, 1 - Math.min(1, (jitter - 1) / 39));
  const score = Math.round((sDown * 0.45 + sUp * 0.2 + sPing * 0.25 + sJit * 0.1) * 100);
  let label = 'Basica';
  if (score >= 85) label = 'Excepcional';
  else if (score >= 70) label = 'Excelente';
  else if (score >= 55) label = 'Muito boa';
  else if (score >= 40) label = 'Boa';
  else if (score >= 25) label = 'Razoavel';
  return { score, label };
}

/* ------------------------------------------------------------------ */
/* Orquestracao                                                        */
/* ------------------------------------------------------------------ */

/**
 * Executa o teste completo.
 * @param {(ev:object)=>void} emit recebe os eventos de progresso
 * @returns {{controller:TestController, promise:Promise<object>}}
 */
function runFullTest(emit) {
  const ctl = new TestController();
  const notices = [];
  const notice = (msg) => {
    notices.push(msg);
    emit({ type: 'notice', message: msg });
  };

  const promise = (async () => {
    const started = Date.now();
    const t0 = now();

    emit({ type: 'phase', phase: 'connecting' });
    const server = await fetchServerInfo(ctl);
    emit({ type: 'server', server });

    if (ctl.aborted) throw new Error('aborted');

    // --- Latencia ---
    emit({ type: 'phase', phase: 'latency' });
    const latency = await measureLatency(ctl, (p) =>
      emit({ type: 'progress', phase: 'latency', ...p })
    );
    emit({ type: 'phaseDone', phase: 'latency', ping: latency.ping, jitter: latency.jitter });

    if (ctl.aborted) throw new Error('aborted');

    // --- Download ---
    emit({ type: 'phase', phase: 'download' });
    const download = await measureDownload(
      ctl,
      (p) => emit({ type: 'progress', phase: 'download', ...p }),
      notice
    );
    emit({ type: 'phaseDone', phase: 'download', mbps: download.mbps });

    if (ctl.aborted) throw new Error('aborted');

    // Pausa curta para as filas de rede esvaziarem antes do upload.
    await sleep(700);

    // --- Upload ---
    emit({ type: 'phase', phase: 'upload' });
    const upload = await measureUpload(
      ctl,
      (p) => emit({ type: 'progress', phase: 'upload', ...p }),
      notice
    );
    emit({ type: 'phaseDone', phase: 'upload', mbps: upload ? upload.mbps : null });

    if (ctl.aborted) throw new Error('aborted');

    const totalMs = now() - t0;
    const upBytes = upload ? upload.bytes : 0;

    const result = {
      id: String(started),
      timestamp: new Date(started).toISOString(),
      server,
      ping: round(latency.ping, 1),
      jitter: round(latency.jitter, 1),
      minPing: round(latency.minPing, 1),
      maxPing: round(latency.maxPing, 1),
      download: {
        mbps: round(download.mbps, 2),
        peakMbps: round(download.peakMbps, 2),
        bytes: download.bytes,
        durationMs: Math.round(download.durationMs),
        provider: download.provider,
      },
      upload: upload
        ? {
            mbps: round(upload.mbps, 2),
            peakMbps: round(upload.peakMbps, 2),
            bytes: Math.round(upload.bytes),
            durationMs: Math.round(upload.durationMs),
            provider: upload.provider,
          }
        : null,
      totalBytes: Math.round(download.bytes + upBytes),
      totalDurationMs: Math.round(totalMs),
      grade: gradeOf(download.mbps, upload ? upload.mbps : 0, latency.ping, latency.jitter),
      notices,
    };

    emit({ type: 'done', result });
    return result;
  })();

  promise.catch(() => {}).finally(() => ctl.dispose());

  return { controller: ctl, promise };
}

module.exports = { runFullTest, fetchServerInfo, CFG, Sampler, TestController };
