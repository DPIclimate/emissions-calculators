// @ts-check

import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { calculateEmissions } from './packages/calculators/dist/index.mjs';
import { allCalculatorNames, isValidCalculatorName } from './packages/calculators/dist/calculators/strings.mjs';

/** Escape user-supplied text before inserting it in HTML. @param {string} text */
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

/** Render the form and retain the submitted input and result.
 * @param {string} calculator @param {string} input
 * @param {string} output @param {string} message
 * @returns {string}
 */
function page(calculator = 'cotton', input = '', output = '', message = '') {
  const options = allCalculatorNames.map(name =>
    `<option value="${name}"${name === calculator ? ' selected' : ''}>${name}</option>`).join('');
  const alert = !message ? 'info' : message === 'Calculation complete.' ? 'success' : 'error';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EAP calculator</title><link rel="stylesheet" href="/vendor/fonts.css"><link rel="stylesheet" href="/vendor/nsw.css"><link rel="stylesheet" href="/style.css"><script src="/client.js" defer></script></head>
<body><nav class="nsw-skip" aria-label="Skip links"><a href="#main-content">Skip to content</a></nav>
<header class="nsw-header nsw-header--simple"><p class="nsw-container calculator-brand">Environmental Accounting Platform</p></header>
<main id="main-content" class="nsw-container calculator-main"><h1>Emissions calculator</h1>
<p class="nsw-intro">Choose a calculator, supply its JSON input, and submit to see the result.</p>
<section class="calculator-grid" aria-label="Calculator workspace">
<form class="nsw-form" method="post" action="/calculate">
<label class="nsw-form__label" for="calculator">Calculator</label><select class="nsw-form__select" id="calculator" name="calculator">${options}</select>
<fieldset id="drop-zone"><legend class="nsw-form__legend">Input JSON</legend>
<label class="nsw-form__label" for="file">Drop a JSON file here or choose a file</label>
<input id="file" type="file" accept=".json,application/json" aria-describedby="file-help">
<p id="file-help" class="nsw-form__helper">A selected file replaces the input below. Files are processed locally by this server.</p>
<p id="file-status" class="nsw-form__helper" role="status"></p>
<label class="nsw-form__label" for="input">Or paste JSON</label>
<textarea class="nsw-form__input" id="input" name="input" rows="22" required spellcheck="false" placeholder="Paste calculator input here">${escapeHtml(input)}</textarea>
</fieldset><button class="nsw-button nsw-button--dark" type="submit">Calculate emissions</button></form>
<section aria-labelledby="result-heading"><h2 id="result-heading">Result</h2>
<p id="result-status" class="nsw-in-page-alert nsw-in-page-alert--${alert}" role="status">${escapeHtml(message || 'Your result will appear here.')}</p>
<header class="calculator-output-tools"><label class="nsw-form__label" for="output">Output JSON</label><button id="copy-output" class="nsw-button nsw-button--dark-outline" type="button"${output ? '' : ' disabled'}>Copy output</button></header><p id="copy-status" class="nsw-form__helper" role="status"></p><textarea class="nsw-form__input" id="output" rows="28" readonly spellcheck="false">${escapeHtml(output)}</textarea></section>
</section></main>
<footer class="nsw-footer"><p class="nsw-container calculator-attribution">This product incorporates the EAP Calculator Engine open-source code developed and maintained by Agricultural Innovation Australia Ltd. Free access to AIA’s open-source code is supported by the Australian Government through funding from the Improving Consistency of On-Farm Emissions Estimates Program.</p></footer>
</body></html>`;
}

/** Run one calculation off the HTTP thread.
 * @param {string} calculator @param {unknown} input @returns {Promise<{status: string, [key: string]: unknown}>}
 */
function calculate(calculator, input) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { calculator, input } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0) reject(new Error(`Calculator worker exited (${code}).`));
    });
  });
}

/** Start the HTTP server. @returns {void} */
function main() {
  let host = '0.0.0.0';
  let port = 8080;
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node server.mjs [--host HOST] [--port PORT]\n\n--host HOST  Listen address (default 0.0.0.0).\n--port PORT  Listen port (default 8080).\n-h, --help   Show this help.');
    return;
  }
  while (args.length) {
    const option = args.shift();
    if (option === '--host') host = args.shift();
    else if (option === '--port') port = Number(args.shift());
    else throw new Error(`Unknown option: ${option}`);
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Supply a host and a port between 1 and 65535.');
  }
  const assets = new Map([
    ['/style.css', { type: 'text/css; charset=utf-8', body: readFileSync(new URL('./web/style.css', import.meta.url)) }],
    ['/client.js', { type: 'text/javascript; charset=utf-8', body: readFileSync(new URL('./web/client.js', import.meta.url)) }],
  ]);
  const vendor = new URL('./web/vendor/', import.meta.url);
  // Serve a fixed asset allowlist; no request path is used to read the filesystem.
  for (const filename of ['nsw.css', 'fonts.css']) {
    assets.set(`/vendor/${filename}`, { type: 'text/css; charset=utf-8', body: readFileSync(new URL(filename, vendor)) });
  }
  for (const filename of readdirSync(new URL('fonts/', vendor))) {
    assets.set(`/vendor/fonts/${filename}`, {
      type: filename.endsWith('.woff2') ? 'font/woff2' : 'font/woff',
      body: readFileSync(new URL(`fonts/${filename}`, vendor)),
    });
  }
  let active = 0;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    /** Send a complete HTML page. @param {number} status @param {string} html */
    function send(status, html) {
      response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html);
    }
    if (request.method === 'GET' && request.url === '/') {
      send(200, page());
      return;
    }
    const asset = assets.get(request.url);
    if (request.method === 'GET' && asset) {
      response.writeHead(200, { 'Content-Type': asset.type });
      response.end(asset.body);
      return;
    }
    if (request.method !== 'POST' || request.url !== '/calculate') {
      send(404, page('cotton', '', '', 'Page not found.'));
      return;
    }
    let calculator = 'cotton';
    let input = '';
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 5 * 1024 * 1024) {
          send(413, page(calculator, '', '', 'Input is too large (maximum request size: 5 MiB).'));
          return;
        }
        chunks.push(chunk);
      }
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      calculator = form.get('calculator') || '';
      input = form.get('input') || '';
      if (!isValidCalculatorName(calculator)) {
        send(400, page('cotton', input, '', 'Choose a valid calculator.'));
        return;
      }
      let parsed;
      try { parsed = JSON.parse(input); }
      catch (error) {
        send(400, page(calculator, input, JSON.stringify({ status: 'ERROR', message: error.message }, null, 2), 'Input is not valid JSON.'));
        return;
      }
      if (active >= 2) {
        send(503, page(calculator, input, '', 'Both calculator workers are busy. Please submit again shortly.'));
        return;
      }
      active += 1;
      let result;
      try { result = await calculate(calculator, parsed); }
      finally { active -= 1; }
      send(200, page(calculator, input, JSON.stringify(result, null, 2),
        result.status === 'OK' ? 'Calculation complete.' : 'The calculator reported errors. See the output below.'));
    } catch (error) {
      send(500, page(calculator, input, JSON.stringify({ status: 'ERROR', message: error.message }, null, 2), 'Calculation failed.'));
    }
  });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, host, () => console.log(`Calculator page listening on http://${host}:${port}`));
  process.on('SIGTERM', () => server.close());
  process.on('SIGINT', () => server.close());
}

if (isMainThread) {
  main();
} else {
  try {
    const result = calculateEmissions(workerData.calculator, workerData.input, { disableMetrics: true });
    parentPort.postMessage(result.status === 'ERROR'
      ? { status: 'ERROR', message: result.error.message } : result);
  } catch (error) {
    parentPort.postMessage({ status: 'ERROR', message: error.message });
  }
}
