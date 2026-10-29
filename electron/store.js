'use strict';
/**
 * Persistencia local em JSON (historico + preferencias).
 * Gravada em app.getPath('userData'), portanto sobrevive ao fechar o app
 * e tambem a reinstalacoes.
 */

const fs = require('fs');
const path = require('path');

const MAX_HISTORY = 200;

const DEFAULT_SETTINGS = {
  mode: 'balanced', // 'quick' | 'balanced' | 'precise'
  autoStart: false,
  showParticles: true,
  unit: 'mbps', // 'mbps' | 'mbs'
};

class Store {
  constructor(userDataPath) {
    this.dir = userDataPath;
    this.file = path.join(userDataPath, 'speed-monitor-data.json');
    this.data = { version: 1, history: [], settings: { ...DEFAULT_SETTINGS } };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.data.history = Array.isArray(parsed.history) ? parsed.history : [];
        this.data.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) };
      }
    } catch (err) {
      // Arquivo ausente na primeira execucao, ou corrompido: recomeca limpo
      // mas preserva o arquivo antigo para nao perder dados silenciosamente.
      if (err.code !== 'ENOENT') {
        try {
          fs.renameSync(this.file, this.file + '.corrupted-' + Date.now());
        } catch (_) { /* ignore */ }
      }
    }
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // Escrita atomica: evita arquivo truncado se o app fechar no meio.
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch (err) {
      console.error('[store] falha ao salvar:', err.message);
      return false;
    }
  }

  getHistory() {
    return this.data.history;
  }

  addResult(result) {
    this.data.history.unshift(result);
    if (this.data.history.length > MAX_HISTORY) {
      this.data.history.length = MAX_HISTORY;
    }
    this.save();
    return this.data.history;
  }

  deleteResult(id) {
    this.data.history = this.data.history.filter((r) => r.id !== id);
    this.save();
    return this.data.history;
  }

  clearHistory() {
    this.data.history = [];
    this.save();
    return this.data.history;
  }

  getSettings() {
    return this.data.settings;
  }

  updateSettings(patch) {
    this.data.settings = { ...this.data.settings, ...(patch || {}) };
    this.save();
    return this.data.settings;
  }

  /** Estatisticas agregadas exibidas no painel de informacoes. */
  getStats() {
    const h = this.data.history;
    if (!h.length) {
      return { tests: 0, totalBytes: 0, downBytes: 0, upBytes: 0, bestDown: 0, avgDown: 0, bestUp: 0, avgPing: 0 };
    }
    let downBytes = 0;
    let upBytes = 0;
    let sumDown = 0;
    let sumPing = 0;
    let bestDown = 0;
    let bestUp = 0;
    for (const r of h) {
      downBytes += (r.download && r.download.bytes) || 0;
      upBytes += (r.upload && r.upload.bytes) || 0;
      const d = (r.download && r.download.mbps) || 0;
      const u = (r.upload && r.upload.mbps) || 0;
      sumDown += d;
      sumPing += r.ping || 0;
      if (d > bestDown) bestDown = d;
      if (u > bestUp) bestUp = u;
    }
    return {
      tests: h.length,
      downBytes,
      upBytes,
      totalBytes: downBytes + upBytes,
      bestDown: Math.round(bestDown * 100) / 100,
      bestUp: Math.round(bestUp * 100) / 100,
      avgDown: Math.round((sumDown / h.length) * 100) / 100,
      avgPing: Math.round((sumPing / h.length) * 10) / 10,
    };
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
