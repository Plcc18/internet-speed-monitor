'use strict';
/**
 * Processo principal.
 *
 * Toda a rede roda aqui (fora do renderer), para que a interface continue
 * a 60 fps enquanto o teste satura a conexao.
 */

const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { runFullTest, CFG } = require('./speedtest');
const { Store } = require('./store');

const isDev = !app.isPackaged;

/** Perfis de duracao expostos nas configuracoes. */
const MODES = {
  quick: { downDurationMs: 6000, upDurationMs: 5000, latencySamples: 10, downStreams: 6, upStreams: 3 },
  balanced: { downDurationMs: 12000, upDurationMs: 10000, latencySamples: 16, downStreams: 6, upStreams: 4 },
  precise: { downDurationMs: 20000, upDurationMs: 16000, latencySamples: 25, downStreams: 8, upStreams: 5 },
};

let mainWindow = null;
let store = null;
let activeTest = null;

// Em desenvolvimento o icone vem do arquivo; no app empacotado ele ja esta
// embutido no .exe pelo electron-builder, e build/ nao e distribuido.
const DEV_ICON = path.join(__dirname, '..', 'build', 'icon.ico');
const windowIcon = fs.existsSync(DEV_ICON) ? DEV_ICON : undefined;

/* ------------------------------------------------------------------ */
/* Janela                                                              */
/* ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    frame: false,
    backgroundColor: '#05070f',
    title: 'Internet Speed Monitor',
    icon: windowIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // O teste continua rodando se a janela perder o foco; sem isto o
      // Chromium reduz o requestAnimationFrame a ~1 fps e as animacoes
      // ficam presas num valor intermediario.
      backgroundThrottling: false,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev && process.env.SPEEDMON_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
    // Utilitario de desenvolvimento: executa JS no renderer para exercitar a
    // interface. SPEEDMON_EXEC="1500:document.getElementById('x').click()"
    if (isDev && process.env.SPEEDMON_EXEC) {
      for (const step of process.env.SPEEDMON_EXEC.split('|')) {
        const sep = step.indexOf(':');
        const at = parseInt(step.slice(0, sep), 10);
        const code = step.slice(sep + 1);
        setTimeout(() => {
          mainWindow.webContents
            .executeJavaScript(code)
            .then((r) => console.log('[exec]', at + 'ms ->', r))
            .catch((e) => console.error('[exec] falhou:', e.message));
        }, at);
      }
    }

    // Utilitario de desenvolvimento: captura a janela para conferir o layout.
    // SPEEDMON_SHOT=base.png SPEEDMON_SHOT_DELAY=4000,12000,30000
    if (isDev && process.env.SPEEDMON_SHOT) {
      const base = process.env.SPEEDMON_SHOT;
      const delays = (process.env.SPEEDMON_SHOT_DELAY || '2500')
        .split(',')
        .map((d) => parseInt(d.trim(), 10))
        .filter((d) => d > 0);

      delays.forEach((delay, idx) => {
        setTimeout(async () => {
          const out = delays.length > 1 ? base.replace(/\.png$/i, '') + '-' + (idx + 1) + '.png' : base;
          try {
            const img = await mainWindow.webContents.capturePage();
            fs.writeFileSync(out, img.toPNG());
            console.log('[shot]', out);
          } catch (err) {
            console.error('[shot] falhou:', err.message);
          }
          if (idx === delays.length - 1 && process.env.SPEEDMON_SHOT_EXIT === '1') app.quit();
        }, delay);
      });
    }
  });

  // Erros do renderer aparecem no terminal durante o desenvolvimento.
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error('[renderer]', message, '(' + sourceId + ':' + line + ')');
  });

  // Reflete o estado de maximizacao no botao da titlebar custom.
  const sendMaxState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:state', { maximized: mainWindow.isMaximized() });
    }
  };
  mainWindow.on('maximize', sendMaxState);
  mainWindow.on('unmaximize', sendMaxState);

  mainWindow.on('closed', () => {
    if (activeTest) {
      try {
        activeTest.controller.abort();
      } catch (_) { /* ignore */ }
      activeTest = null;
    }
    mainWindow = null;
  });

  // Links externos abrem no navegador do sistema, nunca dentro do app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ------------------------------------------------------------------ */
/* Ciclo de vida                                                       */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    store = new Store(app.getPath('userData'));
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

/* ------------------------------------------------------------------ */
/* IPC - controles de janela                                           */
/* ------------------------------------------------------------------ */

ipcMain.on('window:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window:toggle-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow && mainWindow.close());

/* ------------------------------------------------------------------ */
/* IPC - teste de velocidade                                          */
/* ------------------------------------------------------------------ */

function applyMode(mode) {
  const profile = MODES[mode] || MODES.balanced;
  Object.assign(CFG, profile);
}

ipcMain.handle('speedtest:start', async () => {
  if (activeTest) return { ok: false, error: 'Um teste ja esta em andamento.' };

  applyMode(store.getSettings().mode);

  const send = (ev) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('speedtest:event', ev);
    }
  };

  const test = runFullTest(send);
  activeTest = test;

  try {
    const result = await test.promise;
    store.addResult(result);
    send({ type: 'saved', history: store.getHistory(), stats: store.getStats() });
    return { ok: true, result };
  } catch (err) {
    const aborted = err && err.message === 'aborted';
    const message = aborted ? 'Teste cancelado.' : (err && err.message) || 'Falha inesperada no teste.';
    send({ type: aborted ? 'aborted' : 'error', message });
    return { ok: false, aborted, error: message };
  } finally {
    activeTest = null;
  }
});

ipcMain.handle('speedtest:abort', () => {
  if (!activeTest) return { ok: false };
  try {
    activeTest.controller.abort();
  } catch (_) { /* ignore */ }
  return { ok: true };
});

/* ------------------------------------------------------------------ */
/* IPC - historico, estatisticas e preferencias                        */
/* ------------------------------------------------------------------ */

ipcMain.handle('history:get', () => ({
  history: store.getHistory(),
  stats: store.getStats(),
}));

ipcMain.handle('history:clear', () => {
  store.clearHistory();
  return { history: store.getHistory(), stats: store.getStats() };
});

ipcMain.handle('history:delete', (_e, id) => {
  store.deleteResult(id);
  return { history: store.getHistory(), stats: store.getStats() };
});

ipcMain.handle('history:export', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Exportar historico',
    defaultPath: 'historico-velocidade.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false };
  try {
    fs.writeFileSync(filePath, JSON.stringify(store.getHistory(), null, 2), 'utf8');
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => store.updateSettings(patch));

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  dataPath: app.getPath('userData'),
  isDev,
}));

ipcMain.on('app:open-data-folder', () => {
  shell.openPath(app.getPath('userData'));
});
