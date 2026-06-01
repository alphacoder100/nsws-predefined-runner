'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3001;
const RUNNER_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(RUNNER_DIR, 'data');
const RESULTS_JSON = path.join(__dirname, '../../NSWS/data/results.json');
const CONFIG_PATH = path.join(RUNNER_DIR, 'answers.config.json');
const PORTAL_HTML = path.join(RUNNER_DIR, 'public', 'portal.html');

const MIME = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json',
  '.html': 'text/html',
};

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
  const { method } = req;
  const url = req.url.split('?')[0]; // strip query string

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Static: wizard + portal HTML ─────────────────────────────────────────

  if (method === 'GET' && (url === '/' || url === '/wizard.html')) {
    const p = path.join(RUNNER_DIR, 'public', 'wizard.html');
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      res.writeHead(500); res.end('wizard.html not found');
    }
    return;
  }

  if (method === 'GET' && url === '/portal.html') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(PORTAL_HTML, 'utf8'));
    } catch (e) {
      res.writeHead(500); res.end('portal.html not found');
    }
    return;
  }

  // ── Static: data directory (screenshots, JSONs) ───────────────────────────
  // Serves GET /data/<filename> from the local data/ folder.
  // Used by the wizard to display screenshots.

  if (method === 'GET' && url.startsWith('/data/')) {
    const filename = path.basename(url); // prevent path traversal
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const ext = path.extname(filename).toLowerCase();
    const ct = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // ── API: GET /api/config ──────────────────────────────────────────────────

  if (method === 'GET' && url === '/api/config') {
    if (!fs.existsSync(CONFIG_PATH)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No saved config.' })); return;
    }
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── API: GET /api/result ──────────────────────────────────────────────────
  // Returns the latest predefined-result.json so the wizard can display
  // extracted approvals + screenshot path after a run.

  if (method === 'GET' && url === '/api/result') {
    const resultPath = path.join(DATA_DIR, 'predefined-result.json');
    const postPath   = path.join(DATA_DIR, 'predefined-result-post-submit.json');
    if (!fs.existsSync(resultPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No result yet. Run the auto-fill first.' })); return;
    }
    try {
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      // Merge post-submit data if available (has screenshotPath, pageSections, etc.)
      if (fs.existsSync(postPath)) {
        const post = JSON.parse(fs.readFileSync(postPath, 'utf8'));
        result.postSubmit = post;
        // Expose screenshot as a web-accessible relative path
        if (post.screenshotPath) {
          result.screenshotUrl = '/data/' + path.basename(post.screenshotPath);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── API: GET /api/questions ───────────────────────────────────────────────

  if (method === 'GET' && url === '/api/questions') {
    if (!fs.existsSync(RESULTS_JSON)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'results.json not found. Run the NSWS crawler first.' })); return;
    }
    try {
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

  // ── API: POST /api/run ────────────────────────────────────────────────────

  if (method === 'POST' && url === '/api/run') {
    const body = await readBody(req);
    const { mode = 'central', answers = [] } = body;

    if (!answers.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No answers provided' })); return;
    }

    const config = { mode, outputFile: 'data/predefined-result.json', answers };
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Could not save config: ${e.message}` })); return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (type, text) => {
      try { res.write(`data: ${JSON.stringify({ type, text })}\n\n`); } catch (_) {}
    };

    send('info', `Starting runner (mode: ${mode})...\n`);

    const proc = spawn('node', ['src/runner.js'], { cwd: RUNNER_DIR, env: { ...process.env } });
    proc.stdout.on('data', d => send('stdout', d.toString()));
    proc.stderr.on('data', d => send('stderr', d.toString()));

    proc.on('close', code => {
      send('info', `\nProcess exited with code ${code}\n`);

      // Send full result JSON — wizard uses this to build the results screen
      const resultPath = path.join(DATA_DIR, 'predefined-result.json');
      const postPath   = path.join(DATA_DIR, 'predefined-result-post-submit.json');
      if (fs.existsSync(resultPath)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
          if (fs.existsSync(postPath)) {
            const post = JSON.parse(fs.readFileSync(postPath, 'utf8'));
            result.postSubmit = post;
            if (post.screenshotPath) {
              result.screenshotUrl = '/data/' + path.basename(post.screenshotPath);
            }
          }
          send('result', JSON.stringify(result));
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
  console.log(`\nNSWS KYA Wizard  →  http://localhost:${PORT}`);
  console.log(`Config           →  ${CONFIG_PATH}`);
  console.log(`Data dir         →  ${DATA_DIR}\n`);
});
