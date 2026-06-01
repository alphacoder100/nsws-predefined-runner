'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3001;
const RUNNER_DIR = path.join(__dirname, '..');
const RESULTS_JSON = path.join(__dirname, '../../NSWS/data/results.json');
const CONFIG_PATH = path.join(RUNNER_DIR, 'answers.config.json');
const PORTAL_HTML = path.join(RUNNER_DIR, 'public', 'portal.html');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (_) { resolve({}); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET / or /wizard.html -> serve the standalone wizard (preferred entry point)
  if (method === 'GET' && (url === '/' || url === '/wizard.html')) {
    const wizardPath = path.join(RUNNER_DIR, 'public', 'wizard.html');
    try {
      const html = fs.readFileSync(wizardPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`wizard.html not found at ${wizardPath}`);
    }
    return;
  }

  // GET /portal.html -> serve the old server-based portal (still supported)
  if (method === 'GET' && url === '/portal.html') {
    try {
      const html = fs.readFileSync(PORTAL_HTML, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Portal HTML not found at ${PORTAL_HTML}`);
    }
    return;
  }

  // GET /api/config -> return current answers.config.json (so wizard can pre-load saved answers)
  if (method === 'GET' && url === '/api/config') {
    try {
      if (!fs.existsSync(CONFIG_PATH)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No saved config found.' }));
        return;
      }
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(config));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/questions -> return decision tree from NSWS/data/results.json
  if (method === 'GET' && url === '/api/questions') {
    try {
      if (!fs.existsSync(RESULTS_JSON)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'results.json not found. Run the NSWS crawler first (open http://localhost:3000, click Start Central).',
        }));
        return;
      }
      const data = JSON.parse(fs.readFileSync(RESULTS_JSON, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        decisionTree: data.decisionTree || [],
        allQuestions: data.allQuestions || [],
        metadata: data.metadata || {},
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/run -> save answers.config.json, spawn runner, stream output via SSE
  if (method === 'POST' && url === '/api/run') {
    const body = await readBody(req);
    const { mode = 'central', answers = [] } = body;

    if (!answers.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No answers provided' }));
      return;
    }

    const config = {
      mode,
      outputFile: 'data/predefined-result.json',
      answers,
    };

    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Could not save config: ${e.message}` }));
      return;
    }

    // Stream runner output via Server-Sent Events
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (type, text) => {
      try { res.write(`data: ${JSON.stringify({ type, text })}\n\n`); } catch (_) {}
    };

    send('info', `Config saved to answers.config.json\nStarting runner (mode: ${mode})...\n`);

    const proc = spawn('node', ['src/runner.js'], {
      cwd: RUNNER_DIR,
      env: { ...process.env },
    });

    proc.stdout.on('data', data => send('stdout', data.toString()));
    proc.stderr.on('data', data => send('stderr', data.toString()));

    proc.on('close', code => {
      send('info', `\nProcess exited with code ${code}\n`);

      // Attach result file contents if available
      const resultPath = path.join(RUNNER_DIR, 'data', 'predefined-result.json');
      if (fs.existsSync(resultPath)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
          send('result', JSON.stringify(result, null, 2));
        } catch (_) {}
      }

      send('done', String(code));
      try { res.end(); } catch (_) {}
    });

    proc.on('error', err => {
      send('stderr', `Failed to start runner: ${err.message}\n`);
      send('done', '1');
      try { res.end(); } catch (_) {}
    });

    req.on('close', () => { try { proc.kill(); } catch (_) {} });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`NSWS KYA Wizard Portal running at http://localhost:${PORT}`);
  console.log(`Reads questions from: ${RESULTS_JSON}`);
  console.log(`Saves config to:      ${CONFIG_PATH}`);
});
