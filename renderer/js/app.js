// Orquestracao da interface: estado, eventos do teste e renderizacao.

import { Gauge, valueToFraction } from './gauge.js';
import { LiveChart, HistoryChart } from './chart.js';
import { Particles } from './particles.js';
import {
  formatSpeed,
  formatBytes,
  formatDuration,
  formatPing,
  formatDateTime,
  jitterLabel,
} from './format.js';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* Referencias de DOM                                                  */
/* ------------------------------------------------------------------ */

const el = {
  statusPill: $('statusPill'),
  statusText: $('statusText'),
  brandSub: $('brandSub'),

  gaugeWrap: $('gaugeWrap'),
  readoutPhase: $('readoutPhase'),
  readoutNumber: $('readoutNumber'),
  readoutDecimal: $('readoutDecimal'),
  readoutUnit: $('readoutUnit'),
  readoutHint: $('readoutHint'),

  startBtn: $('startBtn'),
  startLabel: document.querySelector('#startBtn .btn-label'),
  serverChip: $('serverChip'),
  serverText: $('serverText'),

  phaseTrack: $('phaseTrack'),

  mDown: $('mDown'),
  mDownPeak: $('mDownPeak'),
  mDownBar: $('mDownBar'),
  mUp: $('mUp'),
  mUpPeak: $('mUpPeak'),
  mUpBar: $('mUpBar'),
  mPing: $('mPing'),
  mPingRange: $('mPingRange'),
  mPingBar: $('mPingBar'),
  mJitter: $('mJitter'),
  mJitterLabel: $('mJitterLabel'),
  mJitterBar: $('mJitterBar'),

  sDown: $('sDown'),
  sUp: $('sUp'),
  sTotal: $('sTotal'),
  sTime: $('sTime'),
  gradeBadge: $('gradeBadge'),
  splitBar: $('splitBar'),
  splitDown: $('splitDown'),
  splitUp: $('splitUp'),
  splitLegend: $('splitLegend'),

  historyList: $('historyList'),
  stTests: $('stTests'),
  stBest: $('stBest'),
  stAvg: $('stAvg'),
  stData: $('stData'),

  settingsModal: $('settingsModal'),
  modeSeg: $('modeSeg'),
  unitSeg: $('unitSeg'),
  particlesSwitch: $('particlesSwitch'),
  autoStartSwitch: $('autoStartSwitch'),
  abVersion: $('abVersion'),
  abElectron: $('abElectron'),
  abPath: $('abPath'),

  toast: $('toast'),
};

const phaseSteps = {
  latency: document.querySelector('.phase-step[data-phase="latency"]'),
  download: document.querySelector('.phase-step[data-phase="download"]'),
  upload: document.querySelector('.phase-step[data-phase="upload"]'),
};
const stepBars = Array.from(document.querySelectorAll('.step-bar'));

/* ------------------------------------------------------------------ */
/* Estado                                                              */
/* ------------------------------------------------------------------ */

const gauge = new Gauge($('gauge'));
const liveChart = new LiveChart($('liveChart'));
const historyChart = new HistoryChart($('historyChart'));
const particles = new Particles($('particles'));

let settings = { mode: 'balanced', unit: 'mbps', showParticles: true, autoStart: false };
let history = [];
let running = false;
let selectedId = null;
let lastResult = null;
let toastTimer = null;
let currentServer = null;

/** O chip mostra quem esta servindo os dados agora, nao so a localizacao. */
function setServerChip(provider) {
  if (!currentServer) return;
  el.serverChip.hidden = false;
  el.serverText.textContent =
    (provider || currentServer.provider) +
    ' · ' + (currentServer.location || currentServer.colo) +
    ' · ' + currentServer.ip;
}

const PHASE_TEXT = {
  connecting: 'CONECTANDO',
  latency: 'LATENCIA',
  download: 'DOWNLOAD',
  upload: 'UPLOAD',
  done: 'CONCLUIDO',
  idle: 'PRONTO',
};

/* ------------------------------------------------------------------ */
/* Unidades                                                            */
/* ------------------------------------------------------------------ */

const isMBs = () => settings.unit === 'mbs';
const toDisplay = (mbps) => (isMBs() ? (mbps || 0) / 8 : mbps || 0);
const unitLabel = () => (isMBs() ? 'MB/s' : 'Mbps');

/** Valor formatado na unidade ativa (para cards e historico). */
function speedText(mbps) {
  if (mbps == null || !isFinite(mbps)) return '—';
  return formatSpeed(toDisplay(mbps));
}

/** Preenchimento da barra usando a mesma escala nao-linear do velocimetro. */
function barPercent(mbps) {
  return Math.max(3, valueToFraction(mbps) * 100);
}

/* ------------------------------------------------------------------ */
/* Leitura central animada                                             */
/* ------------------------------------------------------------------ */

let readoutRaf = null;

/** Escreve o numero central a partir do valor atual da agulha. */
function renderReadout() {
  const v = gauge.currentValue;
  const decimals = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  const text = v.toFixed(decimals);
  if (decimals === 0) {
    el.readoutNumber.textContent = text;
    el.readoutDecimal.textContent = '';
  } else {
    const [i, d] = text.split('.');
    el.readoutNumber.textContent = i;
    el.readoutDecimal.textContent = ',' + d;
  }
}

function startReadoutLoop() {
  if (readoutRaf) return;
  const loop = () => {
    renderReadout();
    readoutRaf = requestAnimationFrame(loop);
  };
  readoutRaf = requestAnimationFrame(loop);
}

/** Para o loop com o numero ja no valor final (o mostrador fica parado). */
function settleReadout() {
  if (readoutRaf) cancelAnimationFrame(readoutRaf);
  readoutRaf = null;
  renderReadout();
}

/* ------------------------------------------------------------------ */
/* Helpers de UI                                                       */
/* ------------------------------------------------------------------ */

function toast(message, kind = '') {
  el.toast.textContent = message;
  el.toast.className = 'toast ' + kind;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 4200);
}

function setStatus(text, kind = '') {
  el.statusText.textContent = text;
  el.statusPill.className = 'status-pill ' + kind;
}

function setPhaseUI(phase) {
  for (const key of Object.keys(phaseSteps)) {
    phaseSteps[key].classList.remove('active');
  }
  if (phaseSteps[phase]) phaseSteps[phase].classList.add('active');

  el.gaugeWrap.className = 'gauge-wrap ' + (phase || '');
  el.readoutPhase.textContent = PHASE_TEXT[phase] || PHASE_TEXT.idle;

  document.querySelectorAll('.metric').forEach((m) => m.classList.remove('live'));
  if (phase === 'download') document.querySelector('.metric[data-metric="download"]').classList.add('live');
  if (phase === 'upload') document.querySelector('.metric[data-metric="upload"]').classList.add('live');
  if (phase === 'latency') {
    document.querySelector('.metric[data-metric="ping"]').classList.add('live');
    document.querySelector('.metric[data-metric="jitter"]').classList.add('live');
  }

  gauge.setPhase(phase === 'connecting' ? 'latency' : phase);
  particles.setMode(phase === 'connecting' ? 'latency' : phase);
}

function markPhaseDone(phase) {
  if (phaseSteps[phase]) {
    phaseSteps[phase].classList.remove('active');
    phaseSteps[phase].classList.add('done');
  }
  if (phase === 'latency' && stepBars[0]) stepBars[0].classList.add('filled');
  if (phase === 'download' && stepBars[1]) stepBars[1].classList.add('filled');
}

function resetPhaseUI() {
  for (const key of Object.keys(phaseSteps)) {
    phaseSteps[key].classList.remove('active', 'done');
  }
  stepBars.forEach((b) => b.classList.remove('filled'));
}

function popMetric(name) {
  const node = document.querySelector('.metric[data-metric="' + name + '"]');
  if (!node) return;
  node.classList.remove('pop');
  void node.offsetWidth; // forca reinicio da animacao
  node.classList.add('pop');
}

/* ------------------------------------------------------------------ */
/* Renderizacao de resultado                                           */
/* ------------------------------------------------------------------ */

function clearMetrics() {
  el.mDown.textContent = '—';
  el.mDownPeak.textContent = 'pico —';
  el.mDownBar.style.width = '0%';
  el.mUp.textContent = '—';
  el.mUpPeak.textContent = 'pico —';
  el.mUpBar.style.width = '0%';
  el.mPing.textContent = '—';
  el.mPingRange.textContent = '—';
  el.mPingBar.style.width = '0%';
  el.mJitter.textContent = '—';
  el.mJitterLabel.textContent = '—';
  el.mJitterBar.style.width = '0%';

  el.sDown.textContent = '—';
  el.sUp.textContent = '—';
  el.sTotal.textContent = '—';
  el.sTime.textContent = '—';
  el.gradeBadge.hidden = true;
  el.splitBar.hidden = true;
  el.splitLegend.hidden = true;
}

function renderUnits() {
  el.readoutUnit.textContent = unitLabel();
  document.querySelectorAll('.metric[data-metric="download"] small, .metric[data-metric="upload"] small')
    .forEach((n) => {
      n.textContent = unitLabel();
    });
  gauge.setUnit(settings.unit);
}

/** Preenche cards + resumo com um resultado completo. */
function renderResult(r, animate = true) {
  if (!r) return;

  el.mDown.textContent = speedText(r.download && r.download.mbps);
  el.mDownPeak.textContent = r.download
    ? 'pico ' + speedText(r.download.peakMbps) + ' ' + unitLabel()
    : 'pico —';
  el.mDownBar.style.width = barPercent((r.download && r.download.mbps) || 0) + '%';

  if (r.upload) {
    el.mUp.textContent = speedText(r.upload.mbps);
    el.mUpPeak.textContent = 'pico ' + speedText(r.upload.peakMbps) + ' ' + unitLabel();
    el.mUpBar.style.width = barPercent(r.upload.mbps) + '%';
  } else {
    el.mUp.textContent = 'n/d';
    el.mUpPeak.textContent = 'servidor indisponivel';
    el.mUpBar.style.width = '0%';
  }

  el.mPing.textContent = formatPing(r.ping);
  el.mPingRange.textContent =
    r.minPing != null ? 'min ' + formatPing(r.minPing) + ' / max ' + formatPing(r.maxPing) : '—';
  el.mPingBar.style.width = Math.max(3, 100 - Math.min(100, (r.ping / 150) * 100)) + '%';

  el.mJitter.textContent = formatPing(r.jitter);
  el.mJitterLabel.textContent = jitterLabel(r.jitter);
  el.mJitterBar.style.width = Math.max(3, 100 - Math.min(100, (r.jitter / 40) * 100)) + '%';

  const dBytes = (r.download && r.download.bytes) || 0;
  const uBytes = (r.upload && r.upload.bytes) || 0;
  el.sDown.textContent = formatBytes(dBytes);
  el.sUp.textContent = formatBytes(uBytes);
  el.sTotal.textContent = formatBytes(r.totalBytes || dBytes + uBytes);
  el.sTime.textContent = formatDuration(r.totalDurationMs);

  if (r.grade) {
    el.gradeBadge.hidden = false;
    el.gradeBadge.textContent = r.grade.label + ' · ' + r.grade.score;
  }

  const total = dBytes + uBytes;
  if (total > 0) {
    el.splitBar.hidden = false;
    el.splitLegend.hidden = false;
    // Dupla requestAnimationFrame para a transicao de largura disparar.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        el.splitDown.style.width = (dBytes / total) * 100 + '%';
        el.splitUp.style.width = (uBytes / total) * 100 + '%';
      })
    );
  }

  if (r.server) {
    currentServer = r.server;
    setServerChip((r.download && r.download.provider) || r.server.provider);
  }

  if (animate) {
    popMetric('download');
    setTimeout(() => popMetric('upload'), 90);
    setTimeout(() => popMetric('ping'), 180);
    setTimeout(() => popMetric('jitter'), 260);
  }

}

/* ------------------------------------------------------------------ */
/* Historico                                                           */
/* ------------------------------------------------------------------ */

function renderHistory(list, stats) {
  history = list || [];
  historyChart.setHistory(history);

  if (stats) {
    el.stTests.textContent = stats.tests;
    el.stBest.textContent = stats.bestDown ? speedText(stats.bestDown) : '—';
    el.stAvg.textContent = stats.avgDown ? speedText(stats.avgDown) : '—';
    el.stData.textContent = stats.totalBytes ? formatBytes(stats.totalBytes) : '—';
  }

  if (!history.length) {
    el.historyList.innerHTML =
      '<div class="empty-state">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">' +
      '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' +
      '<p>Nenhum teste registrado ainda</p></div>';
    return;
  }

  el.historyList.innerHTML = '';
  history.forEach((r, idx) => {
    const item = document.createElement('div');
    item.className = 'hist-item' + (r.id === selectedId ? ' selected' : '');
    item.style.animationDelay = Math.min(idx * 0.03, 0.4) + 's';
    item.dataset.id = r.id;

    const up = r.upload ? speedText(r.upload.mbps) : 'n/d';
    item.innerHTML =
      '<div class="hist-when"><b>' + formatDateTime(r.timestamp) + '</b></div>' +
      '<div class="hist-ping">' + formatPing(r.ping) + ' ms</div>' +
      '<div class="hist-speeds">' +
      '<span class="d"><i class="ar">&#9660;</i><b class="v">' + speedText(r.download && r.download.mbps) + '</b></span>' +
      '<span class="u"><i class="ar">&#9650;</i><b class="v">' + up + '</b></span>' +
      '</div>' +
      '<button class="hist-del" title="Remover">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
      '<path d="M6 6l12 12M18 6L6 18"/></svg></button>';

    item.addEventListener('click', (e) => {
      if (e.target.closest('.hist-del')) return;
      if (running) {
        toast('Aguarde o teste terminar para revisar o historico.');
        return;
      }
      if (selectedId === r.id) {
        selectedId = null;
        if (lastResult) showResultState(lastResult);
      } else {
        selectedId = r.id;
        showResultState(r, 'Revisao de ' + formatDateTime(r.timestamp));
      }
      renderHistory(history, null);
    });

    item.querySelector('.hist-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (running) return;
      const res = await window.api.deleteResult(r.id);
      if (selectedId === r.id) selectedId = null;
      renderHistory(res.history, res.stats);
      toast('Teste removido do historico.');
    });

    el.historyList.appendChild(item);
  });
}

/** Coloca a tela no estado "mostrando um resultado". */
function showResultState(r, hint) {
  renderResult(r, true);
  // Testes do historico nao guardam a serie temporal.
  liveChart.reset();
  resetPhaseUI();
  markPhaseDone('latency');
  markPhaseDone('download');
  markPhaseDone('upload');
  setPhaseUI('done');
  gauge.setPhase('done');
  gauge.setValue(toDisplay(r.download && r.download.mbps));
  gauge.setProgress(1);
  gauge.start();
  // Deixa a agulha assentar e depois para o loop, economizando GPU.
  setTimeout(() => {
    if (!running) {
      gauge.stop(true);
      settleReadout();
    }
  }, 1600);
  el.readoutHint.textContent =
    hint || 'Download final · ' + speedText(r.download && r.download.mbps) + ' ' + unitLabel();
  setStatus('Conectado', '');
}

/* ------------------------------------------------------------------ */
/* Fluxo do teste                                                      */
/* ------------------------------------------------------------------ */

function onTestEvent(ev) {
  switch (ev.type) {
    case 'phase': {
      setPhaseUI(ev.phase);
      gauge.reset();
      if (ev.phase === 'connecting') {
        el.readoutHint.textContent = 'Localizando o servidor mais proximo...';
      } else if (ev.phase === 'latency') {
        el.readoutHint.textContent = 'Medindo tempo de resposta da rede';
      } else if (ev.phase === 'download') {
        el.readoutHint.textContent = 'Recebendo dados em multiplas conexoes';
      } else if (ev.phase === 'upload') {
        el.readoutHint.textContent = 'Enviando dados em multiplas conexoes';
      }
      break;
    }

    case 'server': {
      if (ev.server) {
        currentServer = ev.server;
        setServerChip(ev.server.provider);
        el.brandSub.textContent = 'Servidor ' + ev.server.colo + ' · ' + ev.server.tls;
      }
      break;
    }

    case 'progress': {
      gauge.setProgress(ev.progress);
      if (ev.phase === 'latency') {
        // Na latencia o velocimetro nao representa velocidade: mostra o ping.
        el.mPing.textContent = formatPing(ev.ping);
        el.mJitter.textContent = formatPing(ev.jitter);
        el.mJitterLabel.textContent = jitterLabel(ev.jitter);
        el.mPingBar.style.width = Math.max(3, 100 - Math.min(100, (ev.ping / 150) * 100)) + '%';
        el.mJitterBar.style.width = Math.max(3, 100 - Math.min(100, (ev.jitter / 40) * 100)) + '%';
        el.readoutHint.textContent =
          'Amostra ' + ev.samples + ' · ping ' + formatPing(ev.ping) + ' ms';
      } else {
        // Velocimetro = instantanea (animacao). Card = parcial consolidada.
        gauge.setValue(toDisplay(ev.instantMbps));
        liveChart.setSeries(ev.phase, ev.series || []);

        const target = ev.phase === 'download' ? el.mDown : el.mUp;
        const peak = ev.phase === 'download' ? el.mDownPeak : el.mUpPeak;
        const bar = ev.phase === 'download' ? el.mDownBar : el.mUpBar;
        target.textContent = speedText(ev.runningMbps);
        peak.textContent = 'parcial · ' + formatBytes(ev.bytes);
        bar.style.width = barPercent(ev.runningMbps) + '%';

        if (ev.provider) {
          setServerChip(ev.provider);
          el.readoutHint.textContent =
            (ev.phase === 'download' ? 'Recebendo' : 'Enviando') +
            ' de ' + ev.provider + ' · ' + formatBytes(ev.bytes);
        }
      }
      break;
    }

    case 'phaseDone': {
      markPhaseDone(ev.phase);
      if (ev.phase === 'download' && ev.mbps != null) {
        el.mDown.textContent = speedText(ev.mbps);
        el.mDownBar.style.width = barPercent(ev.mbps) + '%';
        popMetric('download');
      }
      if (ev.phase === 'upload' && ev.mbps != null) {
        el.mUp.textContent = speedText(ev.mbps);
        el.mUpBar.style.width = barPercent(ev.mbps) + '%';
        popMetric('upload');
      }
      if (ev.phase === 'latency') {
        popMetric('ping');
        popMetric('jitter');
      }
      break;
    }

    case 'notice': {
      toast(ev.message);
      break;
    }

    case 'done': {
      lastResult = ev.result;
      selectedId = null;
      break;
    }

    case 'saved': {
      renderHistory(ev.history, ev.stats);
      break;
    }

    default:
      break;
  }
}

async function startTest() {
  if (running) {
    await window.api.abortTest();
    return;
  }

  running = true;
  selectedId = null;
  el.startBtn.classList.remove('idle');
  el.startBtn.classList.add('running');
  el.startLabel.textContent = 'CANCELAR';
  setStatus('Teste em andamento', 'testing');
  clearMetrics();
  resetPhaseUI();
  liveChart.reset();
  liveChart.start();
  gauge.reset();
  gauge.start();
  startReadoutLoop();
  el.readoutHint.textContent = 'Preparando a medicao...';

  const res = await window.api.startTest();

  running = false;
  el.startBtn.classList.remove('running');
  el.startBtn.classList.add('idle');
  el.startLabel.textContent = 'TESTAR NOVAMENTE';
  liveChart.stop();

  if (res.ok) {
    setPhaseUI('done');
    particles.setMode('done');
    gauge.setPhase('done');
    gauge.setValue(toDisplay(res.result.download.mbps));
    gauge.setProgress(1);
    renderResult(res.result, true);
    el.readoutHint.textContent =
      'Resultado final de download · teste salvo no historico';
    setStatus('Conectado', '');
    toast('Teste concluido: ' + speedText(res.result.download.mbps) + ' ' + unitLabel() + ' de download', 'success');
    setTimeout(() => {
      if (!running) {
        gauge.stop(true);
        settleReadout();
      }
    }, 2200);
  } else if (res.aborted) {
    setPhaseUI('idle');
    particles.setMode('idle');
    gauge.setValue(0);
    el.readoutHint.textContent = 'Teste cancelado. Toque para iniciar novamente.';
    setStatus('Conectado', '');
    toast('Teste cancelado.');
    setTimeout(() => {
      if (!running) {
        gauge.stop(true);
        settleReadout();
      }
    }, 1200);
  } else {
    setPhaseUI('idle');
    particles.setMode('idle');
    gauge.setValue(0);
    el.readoutHint.textContent = res.error || 'Falha no teste.';
    setStatus('Falha na medicao', 'offline');
    toast(res.error || 'Falha no teste.', 'error');
    setTimeout(() => {
      if (!running) {
        gauge.stop(true);
        settleReadout();
      }
    }, 1200);
  }
}

/* ------------------------------------------------------------------ */
/* Configuracoes                                                       */
/* ------------------------------------------------------------------ */

function paintSettings() {
  el.modeSeg.querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === settings.mode)
  );
  el.unitSeg.querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', b.dataset.unit === settings.unit)
  );
  el.particlesSwitch.classList.toggle('on', !!settings.showParticles);
  el.particlesSwitch.setAttribute('aria-checked', String(!!settings.showParticles));
  el.autoStartSwitch.classList.toggle('on', !!settings.autoStart);
  el.autoStartSwitch.setAttribute('aria-checked', String(!!settings.autoStart));
}

async function patchSettings(patch) {
  settings = await window.api.setSettings(patch);
  paintSettings();
  return settings;
}

function openSettings() {
  el.settingsModal.hidden = false;
}

function closeSettings() {
  el.settingsModal.hidden = true;
}

/* ------------------------------------------------------------------ */
/* Ligacoes de eventos                                                 */
/* ------------------------------------------------------------------ */

el.startBtn.addEventListener('click', startTest);

$('settingsBtn').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', closeSettings);
el.settingsModal.addEventListener('click', (e) => {
  if (e.target === el.settingsModal) closeSettings();
});

el.modeSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  if (running) {
    toast('Nao e possivel mudar a precisao durante um teste.');
    return;
  }
  patchSettings({ mode: btn.dataset.mode });
});

el.unitSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-unit]');
  if (!btn) return;
  patchSettings({ unit: btn.dataset.unit }).then(() => {
    renderUnits();
    const shown = selectedId ? history.find((r) => r.id === selectedId) : lastResult;
    if (shown) {
      renderResult(shown, false);
      gauge.setValue(toDisplay(shown.download && shown.download.mbps));
    }
    renderHistory(history, null);
    window.api.getHistory().then((d) => renderHistory(d.history, d.stats));
  });
});

el.particlesSwitch.addEventListener('click', async () => {
  const next = !settings.showParticles;
  await patchSettings({ showParticles: next });
  particles.setEnabled(next);
});

el.autoStartSwitch.addEventListener('click', () => {
  patchSettings({ autoStart: !settings.autoStart });
});

$('openDataBtn').addEventListener('click', () => window.api.openDataFolder());

$('exportBtn').addEventListener('click', async () => {
  if (!history.length) {
    toast('Nao ha testes para exportar.');
    return;
  }
  const res = await window.api.exportHistory();
  if (res.ok) toast('Historico exportado com sucesso.', 'success');
  else if (res.error) toast('Falha ao exportar: ' + res.error, 'error');
});

$('clearBtn').addEventListener('click', async () => {
  if (!history.length) return;
  if (running) {
    toast('Aguarde o teste terminar.');
    return;
  }
  const res = await window.api.clearHistory();
  selectedId = null;
  renderHistory(res.history, res.stats);
  toast('Historico limpo.');
});

$('minBtn').addEventListener('click', () => window.api.minimize());
$('maxBtn').addEventListener('click', () => window.api.toggleMaximize());
$('closeBtn').addEventListener('click', () => window.api.close());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!el.settingsModal.hidden) closeSettings();
    else if (running) window.api.abortTest();
  }
  if ((e.key === ' ' || e.key === 'Enter') && el.settingsModal.hidden) {
    if (document.activeElement && document.activeElement.tagName === 'BUTTON') return;
    e.preventDefault();
    startTest();
  }
});

window.api.onTestEvent(onTestEvent);

/* ------------------------------------------------------------------ */
/* Inicializacao                                                       */
/* ------------------------------------------------------------------ */

async function init() {
  settings = await window.api.getSettings();
  paintSettings();
  renderUnits();

  particles.setEnabled(!!settings.showParticles);
  particles.setMode('idle');

  const info = await window.api.getAppInfo();
  el.abVersion.textContent = 'v' + info.version;
  el.abElectron.textContent = info.electron;
  el.abPath.textContent = info.dataPath;

  const data = await window.api.getHistory();
  renderHistory(data.history, data.stats);

  if (data.history.length) {
    lastResult = data.history[0];
    renderResult(lastResult, false);
    gauge.setPhase('done');
    gauge.setValue(toDisplay(lastResult.download && lastResult.download.mbps));
    gauge.setProgress(1);
    el.readoutHint.textContent = 'Ultimo teste · ' + formatDateTime(lastResult.timestamp);
    resetPhaseUI();
  } else {
    el.readoutHint.textContent = 'Toque em iniciar para medir sua conexao';
  }

  setStatus(navigator.onLine ? 'Conectado' : 'Sem conexao', navigator.onLine ? '' : 'offline');
  el.startBtn.classList.add('idle');
  startReadoutLoop();

  // Anima a agulha ate o valor inicial e depois libera a GPU.
  gauge.start();
  setTimeout(() => {
    if (!running) {
      gauge.stop(true);
      settleReadout();
    }
  }, 1800);

  if (settings.autoStart) setTimeout(startTest, 700);
}

window.addEventListener('online', () => setStatus('Conectado', ''));
window.addEventListener('offline', () => setStatus('Sem conexao', 'offline'));

window.api.onWindowState(() => {
  // O layout e fluido; apenas forca o recalculo dos canvas.
  gauge.resize();
  liveChart.resize();
  historyChart.resize();
});

init().catch((err) => {
  console.error(err);
  toast('Erro ao iniciar a interface: ' + err.message, 'error');
});
