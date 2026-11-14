// Minimal headless-Chrome driver over the DevTools protocol, using only what ships
// with Node (child_process, fetch, WebSocket). Enough to load the app, poke it with
// real mouse and keyboard events, run script in the page and take screenshots.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || 'google-chrome';

export async function launchBrowser({ width = 1440, height = 900 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gameboy-chrome-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', `--window-size=${width},${height}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const port = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`Chrome did not start:\n${text}`)), 20000);
    proc.stderr.on('data', (chunk) => {
      text += chunk;
      const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(text);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome exited (${code}):\n${text}`)); });
  });

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((t) => t.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) return; // answered after its deadline
      const { resolve, reject } = entry;
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} ${message.error.data || ''}`));
      else resolve(message.result);
    } else {
      for (const handler of listeners.get(message.method) || []) handler(message.params);
    }
  });

  // Every command gets a deadline, so a wedged browser fails the run instead of
  // hanging it.
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`browser did not answer ${method} within 20 s`));
    }, 20000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const on = (method, handler) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(handler);
  };

  /** Problems the page reported: uncaught exceptions and console errors/warnings. */
  const problems = [];
  on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails;
    problems.push(`exception: ${d.exception?.description || d.text}`);
  });
  on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'warning') {
      problems.push(`console.${p.type}: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    }
  });
  on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error') problems.push(`log: ${p.entry.text} ${p.entry.url || ''}`);
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('DOM.enable');

  const page = {
    send, on, problems,

    async setViewport(w, h, { mobile = false, scale = 1 } = {}) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale, mobile });
      if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    },

    async goto(url) {
      const loaded = new Promise((resolve) => on('Page.loadEventFired', resolve));
      await send('Page.navigate', { url });
      await loaded;
    },

    /** Evaluates an expression in the page and returns its (JSON-serialisable) value. */
    async eval(expression) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        throw new Error(`page threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
      }
      return result.result.value;
    },

    /** Polls until the expression is truthy. */
    async waitFor(expression, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        // Only the truthiness crosses the wire: the value itself may not serialise.
        if (await page.eval(`!!(${expression})`)) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for: ${expression}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    },

    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),

    async screenshot(file) {
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
    },

    /** Centre of an element in viewport coordinates. */
    async centre(selector) {
      const box = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
      if (!box) throw new Error(`no element matches ${selector}`);
      return box;
    },

    async mouseMove(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    },

    async click(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },

    /** Clicks a point given as fractions (0-1) of an element's box; default is its centre. */
    async clickOn(selector, fx = 0.5, fy = 0.5) {
      const box = await page.centre(selector);
      await page.click(box.x + box.w * fx, box.y + box.h * fy);
    },

    async hoverOn(selector, fx = 0.5, fy = 0.5) {
      const box = await page.centre(selector);
      await page.mouseMove(box.x + box.w * fx, box.y + box.h * fy);
    },

    async key(type, code, key = code) {
      const keyCodes = { Enter: 13, Space: 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Escape: 27, Tab: 9 };
      const vk = keyCodes[code] ?? (code.startsWith('Key') ? code.charCodeAt(3) : 0);
      await send('Input.dispatchKeyEvent', {
        type: type === 'down' ? 'rawKeyDown' : 'keyUp', code, key,
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      });
    },

    async press(code, key = code, holdMs = 60) {
      await page.key('down', code, key);
      await page.sleep(holdMs);
      await page.key('up', code, key);
    },

    /** Chooses files in an <input type="file">, as if picked in the dialog. */
    async setFiles(selector, files) {
      const { root } = await send('DOM.getDocument');
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
      await send('DOM.setFileInputFiles', { nodeId, files: files.map((f) => path.resolve(f)) });
    },

    async close() {
      try { await send('Browser.close'); } catch { /* already gone */ }
      proc.kill('SIGKILL');
      try { socket.close(); } catch { /* already closed */ }
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    },
  };
  return page;
}

/** Starts server.mjs on a free port and resolves with its base URL. */
export async function startServer(root) {
  const net = await import('node:net');
  const port = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: p } = probe.address();
      probe.close(() => resolve(p));
    });
  });
  const proc = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.once('data', resolve);
    proc.once('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
  return { url: `http://127.0.0.1:${port}/`, stop: () => proc.kill() };
}
