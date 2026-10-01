// Port handling that survives real machines.
// Windows reserves blocks of ports (Hyper-V, WSL2, Docker: see
// `netsh interface ipv4 show excludedportrange protocol=tcp`). Listening inside such a
// block fails with EACCES even as administrator. So: try the preferred port, then the
// next few, then let the OS pick any free port.
'use strict';

const RETRYABLE = new Set(['EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL']);

function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (e) => { server.off('listening', onListening); reject(e); };
    const onListening = () => { server.off('error', onError); resolve(server.address().port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** Returns the port actually used. Throws only for non-port errors or if nothing works. */
async function listenWithFallback(server, host, preferred, extra = 10) {
  const candidates = [];
  for (let i = 0; i <= extra; i++) if (preferred + i <= 65535) candidates.push(preferred + i);
  candidates.push(0); // any free port
  let last;
  for (const port of candidates) {
    try { return await listenOnce(server, port, host); }
    catch (e) { last = e; if (!RETRYABLE.has(e.code)) throw e; }
  }
  throw last;
}

module.exports = { listenWithFallback, RETRYABLE };
