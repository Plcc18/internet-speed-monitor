// Harness de validacao do motor de medicao (roda fora do Electron).
const { runFullTest } = require('../electron/speedtest');

let lastPhase = '';
const { promise } = runFullTest((ev) => {
  if (ev.type === 'phase') {
    lastPhase = ev.phase;
    process.stdout.write('\n[' + ev.phase + '] ');
  } else if (ev.type === 'server') {
    console.log('servidor:', JSON.stringify(ev.server));
  } else if (ev.type === 'progress') {
    if (lastPhase === 'latency') {
      process.stdout.write('\r[latency] ping=' + ev.ping.toFixed(1) + 'ms jitter=' + ev.jitter.toFixed(1) + 'ms  ');
    } else {
      process.stdout.write(
        '\r[' + lastPhase + '] inst=' + ev.instantMbps.toFixed(1) +
        ' Mbps | parcial=' + ev.runningMbps.toFixed(1) +
        ' Mbps | ' + (ev.bytes / 1048576).toFixed(1) + ' MB   '
      );
    }
  } else if (ev.type === 'phaseDone') {
    process.stdout.write('\n  -> concluido: ' + JSON.stringify(ev) + '\n');
  }
});

promise
  .then((r) => {
    console.log('\n===== RESULTADO =====');
    console.log(JSON.stringify(r, null, 2));
  })
  .catch((e) => {
    console.error('\nFALHA:', e.message);
    process.exitCode = 1;
  });
