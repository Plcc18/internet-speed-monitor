// Benchmark cru: mede quantos bytes o Node consegue puxar em N streams / T ms.
const https = require('https');
const streams = parseInt(process.argv[2] || '6', 10);
const durMs = parseInt(process.argv[3] || '12000', 10);
const chunk = 25 * 1024 * 1024;

const agent = new https.Agent({ keepAlive: true, maxSockets: 64 });
let bytes = 0;
const t0 = performance.now();
const deadline = t0 + durMs;

function one(i) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    const loop = () => {
      if (performance.now() >= deadline) return fin();
      const req = https.get(
        { host: 'speed.cloudflare.com', path: '/__down?bytes=' + chunk + '&r=' + Math.random(), agent },
        (res) => {
          let nx = false;
          const next = () => { if (!nx) { nx = true; loop(); } };
          res.on('data', (c) => {
            bytes += c.length;
            if (performance.now() >= deadline) res.destroy();
          });
          res.on('end', next);
          res.on('close', next);
        }
      );
      req.on('socket', (s) => s.setMaxListeners(0));
      req.on('error', fin);
    };
    loop();
  });
}

const tick = setInterval(() => {
  const el = (performance.now() - t0) / 1000;
  process.stdout.write('\r' + el.toFixed(1) + 's  ' + (bytes / 1048576).toFixed(1) + ' MB  ' + ((bytes * 8) / (el * 1e6)).toFixed(1) + ' Mbps   ');
}, 500);

Promise.all(Array.from({ length: streams }, (_, i) => one(i))).then(() => {
  clearInterval(tick);
  const el = (performance.now() - t0) / 1000;
  console.log('\nFINAL: streams=' + streams + ' ' + (bytes / 1048576).toFixed(1) + ' MB em ' + el.toFixed(2) + 's = ' + ((bytes * 8) / (el * 1e6)).toFixed(2) + ' Mbps');
  agent.destroy();
});
