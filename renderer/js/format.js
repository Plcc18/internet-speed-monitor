// Formatacao de numeros, bytes e datas no padrao pt-BR.

const nf = (min, max) =>
  new Intl.NumberFormat('pt-BR', { minimumFractionDigits: min, maximumFractionDigits: max });

const nf0 = nf(0, 0);
const nf1 = nf(1, 1);
const nf2 = nf(2, 2);

/** Escolhe a precisao conforme a magnitude, como fazem os medidores comerciais. */
export function formatSpeed(mbps) {
  if (!isFinite(mbps) || mbps < 0) return '—';
  if (mbps >= 100) return nf0.format(mbps);
  if (mbps >= 10) return nf1.format(mbps);
  return nf2.format(mbps);
}

export function formatBytes(bytes) {
  if (!isFinite(bytes) || bytes <= 0) return '0 MB';
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes >= GB) return nf2.format(bytes / GB) + ' GB';
  if (bytes >= MB) return nf1.format(bytes / MB) + ' MB';
  if (bytes >= KB) return nf0.format(bytes / KB) + ' KB';
  return nf0.format(bytes) + ' B';
}

export function formatDuration(ms) {
  if (!isFinite(ms) || ms <= 0) return '—';
  const s = ms / 1000;
  if (s < 60) return nf1.format(s) + ' s';
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return m + ' min ' + String(rest).padStart(2, '0') + ' s';
}

export function formatPing(ms) {
  if (!isFinite(ms) || ms < 0) return '—';
  return ms >= 100 ? nf0.format(ms) : nf1.format(ms);
}

export function formatDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const today = new Date();
  const sameDay =
    d.getDate() === today.getDate() &&
    d.getMonth() === today.getMonth() &&
    d.getFullYear() === today.getFullYear();
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return 'Hoje, ' + time;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (
    d.getDate() === yesterday.getDate() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getFullYear() === yesterday.getFullYear()
  ) {
    return 'Ontem, ' + time;
  }
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ', ' + time;
}

/** Classificacao qualitativa do jitter. */
export function jitterLabel(ms) {
  if (!isFinite(ms)) return '—';
  if (ms < 5) return 'estabilidade otima';
  if (ms < 15) return 'estabilidade boa';
  if (ms < 30) return 'oscilacao moderada';
  return 'conexao instavel';
}
