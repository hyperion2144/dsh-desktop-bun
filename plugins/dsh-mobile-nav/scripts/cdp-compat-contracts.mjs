// Upstream-compatibility contract checker for dsh-web-mobile.
// Machine-readable counterpart of docs/upstream/upgrade-runbook.md §2.
// Consumes docs/upstream/compat-contracts.json; scans the live page
// (DOM class attributes + every reachable CSSRule's cssText) for each
// needle. **HIT means the string exists in the DOM or in any loaded
// stylesheet — NOT that an element renders with it**: a CSS-module class
// that ships in a plugin's sheet but is used by no element still HITs
// (2026-09-18 实测 group-card-1/3/5 即此情况), so pair a hash contract with
// a rendering assertion in a probe when the page shape matters.
// A lazy contract whose needle is absent is SKIP (state-gated or
// not yet loaded; see its "state" note); a non-lazy MISS exits 1 so a host
// upgrade surfaces rehash drift immediately.
// Inputs (environment): DSH_PROBE_URL (default http://127.0.0.1:3080/),
// DSH_PROBE_CHROME (default chromium), DSH_PROBE_TIMEOUT_MS (default 30000),
// DSH_CONTRACTS_FILE (optional path override for the contracts JSON).
// Exits 0 when miss=0. Never calls process.exit().
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_URL = 'http://127.0.0.1:3080/';
const DEFAULT_TIMEOUT_MS = 30_000;
const SETTLE_STABLE_SAMPLES = 2;
const SETTLE_SAMPLE_INTERVAL_MS = 1_500;
const SETTLE_MAX_SAMPLES = 14;

function readConfig(env = process.env) {
  const parsedUrl = new URL(env.DSH_PROBE_URL || DEFAULT_URL);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('DSH_PROBE_URL must use http or https');
  }
  const timeoutMs = Number(env.DSH_PROBE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('DSH_PROBE_TIMEOUT_MS must be a positive integer');
  }
  const contractsFile = env.DSH_CONTRACTS_FILE?.trim()
    || join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'upstream', 'compat-contracts.json');
  return { url: parsedUrl.toString(), chromePath: env.DSH_PROBE_CHROME || 'chromium', timeoutMs, contractsFile };
}

async function loadContracts(path) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const contracts = raw.contracts;
  if (!Array.isArray(contracts) || contracts.length === 0) {
    throw new Error(`contracts file has no entries: ${path}`);
  }
  for (const contract of contracts) {
    if (!contract.id || !contract.needle) {
      throw new Error(`contract entry missing id/needle: ${JSON.stringify(contract)}`);
    }
    if (contract.kind !== 'hash' && contract.kind !== 'marker') {
      throw new Error(`contract ${contract.id} has unknown kind: ${contract.kind}`);
    }
  }
  return contracts;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

async function waitFor(label, timeoutMs, signal, probe) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(100, signal);
  }
  throw new Error(`timeout after ${timeoutMs}ms: ${label}`);
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function createCdpClient(ws, signal) {
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  const rejectPending = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
      return;
    }
    for (const handler of listeners.get(message.method) || []) handler(message.params);
  };
  ws.onerror = () => rejectPending(new Error('CDP WebSocket error'));
  ws.onclose = () => rejectPending(new Error('CDP WebSocket closed'));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason || new Error('aborted'));
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result.value;
  };
  return {
    send,
    evaluate,
    close(error = new Error('CDP client closed')) {
      rejectPending(error);
      if (ws.readyState === WebSocket.OPEN) ws.close();
    },
  };
}

// One snapshot of everything a hash needle could live in: class attributes
// of every element plus the cssText of every reachable style rule (recursed
// through media/grouping rules; cross-origin access is ignored).
const SCAN_TEXT_EXPRESSION = `(() => {
  const chunks = [];
  document.querySelectorAll('*').forEach((el) => {
    if (typeof el.className === 'string') chunks.push(el.className);
  });
  const collect = (list) => {
    for (const rule of list) {
      try { chunks.push(rule.cssText || ''); } catch { /* skip single rule */ }
      try { if (rule.cssRules) collect(rule.cssRules); } catch { /* skip subtree */ }
    }
  };
  try { collect(document.styleSheets); } catch { /* skip sheet */ }
  return chunks.join('\\n');
})()`;

async function main() {
  const abortController = new AbortController();
  const onSignal = (signalName) => abortController.abort(new Error(`received ${signalName}`));
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  const signal = abortController.signal;

  let client = null;
  let chrome = null;
  let profileDir = null;
  let missCount = 0;

  try {
    const config = readConfig();
    const contracts = await loadContracts(config.contractsFile);
    console.log(`contracts file: ${config.contractsFile} (${contracts.length} entries)`);

    const port = await allocatePort();
    const cacheRoot = join(homedir(), '.cache');
    await mkdir(cacheRoot, { recursive: true });
    profileDir = await mkdtemp(join(cacheRoot, 'dsh-web-mobile-contracts-'));

    chrome = spawn(config.chromePath, [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--remote-debugging-port=' + port,
      '--user-data-dir=' + profileDir,
      '--window-size=390,844',
      'about:blank',
    ], { stdio: 'ignore' });
    let chromeFailure = null;
    let chromeExit = null;
    chrome.once('error', (error) => { chromeFailure = error; });
    chrome.once('exit', (code, signalCode) => { chromeExit = { code, signalCode }; });

    const target = await waitFor('chrome target', config.timeoutMs, signal, async () => {
      if (chromeFailure) throw new Error(`chromium launch failed: ${chromeFailure.message}`);
      if (chromeExit) throw new Error(`chromium exited early (code=${chromeExit.code}, signal=${chromeExit.signalCode})`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json`);
        if (!response.ok) return null;
        const targets = await response.json();
        return targets.length ? targets[0] : null;
      } catch {
        return null;
      }
    });

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        try { ws.close(); } catch { /* best effort */ }
        reject(signal.reason || new Error('aborted'));
      };
      if (signal.aborted) { onAbort(); return; }
      ws.onopen = () => { signal.removeEventListener('abort', onAbort); resolve(); };
      ws.onerror = () => { signal.removeEventListener('abort', onAbort); reject(new Error('CDP WebSocket connection failed')); };
      signal.addEventListener('abort', onAbort, { once: true });
    });

    client = createCdpClient(ws, signal);
    signal.addEventListener('abort', () => client.close(signal.reason || new Error('aborted')), { once: true });
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    if (process.env.DSH_PROBE_COOKIE) {
      const raw = process.env.DSH_PROBE_COOKIE
      const eq = raw.indexOf('=')
      await client.send('Network.setCookie', { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: config.url })
    }
    await client.send('Page.navigate', { url: config.url });

    await waitFor('page load complete', config.timeoutMs, signal, async () => {
      try {
        const state = await client.evaluate(`({ ready: document.readyState === 'complete', href: location.href })`);
        return state.ready && state.href.startsWith(config.url) ? state : null;
      } catch {
        return null;
      }
    });

    // Let lazy plugin bundles inject their style tags: wait until the
    // (style tag count, rule count) fingerprint is stable for two
    // consecutive samples, then scan.
    let previous = null;
    let stable = 0;
    for (let sample = 0; sample < SETTLE_MAX_SAMPLES; sample += 1) {
      const fingerprint = await client.evaluate(`(() => ({
        styles: document.querySelectorAll('style').length,
        rules: (() => { let n = 0; for (const sheet of document.styleSheets) { try { n += sheet.cssRules.length; } catch { /* skip */ } } return n; })(),
      }))()`);
      if (previous && fingerprint.styles === previous.styles && fingerprint.rules === previous.rules) {
        stable += 1;
        if (stable >= SETTLE_STABLE_SAMPLES) break;
      } else {
        stable = 0;
      }
      previous = fingerprint;
      await sleep(SETTLE_SAMPLE_INTERVAL_MS, signal);
    }

    const scanText = await client.evaluate(SCAN_TEXT_EXPRESSION);
    const statuses = [];

    for (const contract of contracts) {
      let found = false;
      try {
        if (contract.kind === 'hash') {
          found = scanText.includes(contract.needle);
        } else {
          found = await client.evaluate(`!!document.querySelector(${JSON.stringify(contract.needle)})`);
        }
      } catch (error) {
        console.log(`CONTRACT ERROR ${contract.id} (${contract.owner}) — evaluation failed: ${error.message}`);
        missCount += 1;
        continue;
      }
      const status = found ? 'hit' : (contract.lazy ? 'skip' : 'miss');
      statuses.push(status);
      if (found) {
        console.log(`CONTRACT HIT  ${contract.id} (${contract.owner}) ${contract.needle}`);
      } else if (contract.lazy) {
        console.log(`CONTRACT SKIP ${contract.id} (${contract.owner}) ${contract.needle} — lazy${contract.state ? `; ${contract.state}` : ''}`);
      } else {
        console.log(`CONTRACT MISS ${contract.id} (${contract.owner}) ${contract.needle} — manual audit: ${contract.note || '(no note)'}`);
        missCount += 1;
      }
    }

    const hits = statuses.filter((status) => status === 'hit').length;
    const skips = statuses.filter((status) => status === 'skip').length;
    console.log(`SUMMARY CONTRACTS total=${contracts.length} hit=${hits} skip=${skips} miss=${missCount} green=${missCount === 0 ? 'yes' : 'no'}`);
    process.exitCode = missCount > 0 ? 1 : 0;
  } finally {
    if (client) client.close(new Error('probe finished'));
    if (chrome) chrome.kill('SIGTERM');
    if (profileDir) {
      await sleep(300, signal).catch(() => {});
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

await main();
