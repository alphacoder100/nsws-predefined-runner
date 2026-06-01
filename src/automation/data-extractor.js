const path = require('path');
const fs = require('fs');

class DataExtractor {
  constructor(page) {
    this.page = page;
    this._capturedApiResponses = [];
  }

  startNetworkCapture() {
    this.page.on('response', async (response) => {
      const url = response.url();
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      if (
        url.includes('kya') || url.includes('approval') ||
        url.includes('license') || url.includes('know-your') ||
        url.includes('investor') || url.includes('result')
      ) {
        try {
          const body = await response.json().catch(() => null);
          if (body) this._capturedApiResponses.push({ url, status: response.status(), body });
        } catch (_) {}
      }
    });
  }

  getCapturedApiResponses() { return this._capturedApiResponses; }

  async waitForResults(timeout = 20000) {
    const resultSelectors = [
      '.kya-result-card', '.approval-result-card', '.kya-approval-item',
      '.result-approval-card', '.approval-name-container',
      '.ant-result', '.kya-result', '.results-container',
      '[class*="kya-result"]', '[class*="approval-list"]',
    ];
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = await this.page.evaluate((sels) =>
        sels.some(s => document.querySelectorAll(s).length > 0)
      , resultSelectors);
      if (found) break;
      await this.page.waitForTimeout(500);
    }
    await this.page.waitForTimeout(2000);
  }

  async extractStructured() {
    return await this.page.evaluate(() => {
      const norm = t => (t || '').trim().replace(/\s+/g, ' ');
      const pickText = (el, ...sels) => {
        for (const s of sels) {
          const found = el.querySelector(s);
          if (found && found.innerText.trim()) return norm(found.innerText);
        }
        return '';
      };
      const pickAttr = (el, attr, ...sels) => {
        for (const s of sels) {
          const found = el.querySelector(s);
          if (found && found.getAttribute(attr)) return found.getAttribute(attr).trim();
        }
        return '';
      };
      const extractLinks = el =>
        [...el.querySelectorAll('a[href]')]
          .map(a => ({ text: norm(a.innerText), href: a.href }))
          .filter(l => l.href && !l.href.startsWith('javascript'));

      const cardSelectors = [
        '.kya-result-card', '.approval-result-card', '.kya-approval-item',
        '.result-approval-card', '.approval-name-container',
        '[class*="kya-approval"]', '[class*="approval-card"]',
        '.ant-card', '.ant-list-item',
      ];

      for (const cardSel of cardSelectors) {
        const cards = [...document.querySelectorAll(cardSel)];
        if (!cards.length) continue;
        const results = cards.map(card => {
          const name = pickText(card,
            '.approval-name', '.kya-approval-name', '.approval-title',
            '.result-title', '.ant-card-head-title', 'h3', 'h4', 'h2',
            '.approval-name-container', '[class*="name"]', '[class*="title"]'
          ) || norm(card.querySelector('strong, b')?.innerText || '');
          const authority  = pickText(card, '.approval-authority', '.kya-authority', '.department-name', '.authority-name', '[class*="authority"]', '[class*="department"]', '.ant-card-extra', '.issuing-authority');
          const category   = pickText(card, '.approval-category', '.kya-category', '.approval-type', '[class*="category"]', '[class*="type"]', '.ant-tag');
          const description= pickText(card, '.approval-description', '.kya-description', '.approval-detail', '.card-body', '.ant-card-body', '[class*="description"]', '[class*="detail"]', 'p');
          const fee        = pickText(card, '[class*="fee"]', '[class*="cost"]', '[class*="charge"]');
          const timeline   = pickText(card, '[class*="timeline"]', '[class*="duration"]', '[class*="days"]');
          const links      = extractLinks(card);
          const applyLink  = pickAttr(card, 'href', 'a[class*="apply"]', 'a[class*="register"]', 'a.ant-btn-primary');
          const status     = pickText(card, '[class*="status"]', '[class*="mandatory"]', '[class*="required"]');
          const rawText    = norm(card.innerText);
          return { name, authority, category, description, fee, timeline, status, applyLink, links, rawText, cardSelector: cardSel };
        }).filter(r => r.rawText.length > 5);
        if (results.length) return { source: cardSel, cards: results };
      }
      return null;
    });
  }

  async extractResultsSummary() {
    return await this.page.evaluate(() => {
      const norm = t => (t || '').trim().replace(/\s+/g, ' ');
      const summary = {};
      const countEl = document.querySelector('.result-count, .kya-count, [class*="approval-count"], [class*="total-count"], .ant-result-title');
      if (countEl) summary.countText = norm(countEl.innerText);
      const heading = document.querySelector('.kya-result-heading, .result-heading, h1.ant-typography, h2.ant-typography, .ant-result-subtitle');
      if (heading) summary.heading = norm(heading.innerText);
      const bodyText = document.body.innerText;
      const match = bodyText.match(/(\d+)\s*(approval|license|registration|permit)/i);
      if (match) summary.countExtracted = parseInt(match[1], 10);
      // Also pick up "My Approvals(N)" badge
      const myApprovalsMatch = bodyText.match(/My Approvals\((\d+)\)/i);
      if (myApprovalsMatch) summary.myApprovalsCount = parseInt(myApprovalsMatch[1], 10);
      summary.pageTitle = document.title;
      summary.pageUrl = window.location.href;
      return summary;
    });
  }

  async extractTable() {
    return await this.page.evaluate(() => {
      const norm = t => (t || '').trim().replace(/\s+/g, ' ');
      const tables = [...document.querySelectorAll('table')];
      const tableData = [];
      for (const table of tables) {
        const headers = [...table.querySelectorAll('thead th, tr:first-child th')].map(th => norm(th.innerText));
        const rows = [...table.querySelectorAll('tbody tr, tr:not(:first-child)')]
          .map(tr => {
            const cells = [...tr.querySelectorAll('td, th')].map(td => norm(td.innerText));
            if (!cells.some(c => c.length > 0)) return null;
            if (headers.length) {
              const obj = {};
              headers.forEach((h, i) => { obj[h || `col${i}`] = cells[i] || ''; });
              return obj;
            }
            return cells;
          }).filter(Boolean);
        if (rows.length) tableData.push({ headers, rows });
      }
      return tableData.length ? tableData : null;
    });
  }

  async extractPageSections() {
    return await this.page.evaluate(() => {
      const norm = t => (t || '').trim().replace(/\s+/g, ' ');
      const root = document.querySelector(
        'main, .content, #content, .results-container, .kya-result, .approval-list, [class*="result"]'
      ) || document.body;
      const sections = [];
      const headings = [...root.querySelectorAll('h1, h2, h3, h4')];
      if (headings.length) {
        headings.forEach(h => {
          let content = '';
          let sib = h.nextElementSibling;
          while (sib && !['H1','H2','H3','H4'].includes(sib.tagName)) {
            content += ' ' + sib.innerText;
            sib = sib.nextElementSibling;
          }
          sections.push({ heading: norm(h.innerText), content: norm(content) });
        });
      }
      if (!sections.length) {
        root.innerText.split('\n').map(l => norm(l)).filter(l => l.length > 10)
          .forEach(l => sections.push({ heading: '', content: l }));
      }
      return sections;
    });
  }

  // ── Parse structured approvals from the fullText body ─────────────────────
  // The NSWS results page renders approvals in plain text as:
  //   "[Name] For [Step] Issued by [Dept] [Ministry]"
  // This parser extracts them reliably when card-based CSS selectors fail.
  static parseApprovalsFromText(fullText) {
    if (!fullText) return [];

    // Isolate the CENTRAL APPROVALS section
    const sectionStart = fullText.search(/CENTRAL APPROVALS\s*\(\d+\)/);
    if (sectionStart === -1) return [];
    const sectionEnd = fullText.indexOf('Add to Dashboard', sectionStart);
    const section = fullText.slice(sectionStart, sectionEnd !== -1 ? sectionEnd : fullText.length);

    // Count claimed by the page
    const countMatch = section.match(/CENTRAL APPROVALS\s*\((\d+)\)/);
    const claimedCount = countMatch ? parseInt(countMatch[1]) : 0;

    // Split on "Issued by" — gives us alternating [name+step] and [dept+nextName] chunks
    const parts = section.split(' Issued by ');

    const STEP_CATS = [
      'For Business Registration',
      'For Business Activity Details',
      'For Project Land Details',
      'For Foreign Investment Details',
    ];
    const STEP_RE = new RegExp(
      '\\s+(' + STEP_CATS.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$'
    );

    // Boilerplate patterns that appear at the START of every chunk[i>=1]
    // (left over from the previous entry's "Issued by" line)
    const BOILERPLATE_RE = /^(?:DPIIT|Department of [A-Za-z,\s&]+?|Ministry of [A-Za-z,\s&]+?|Bureau of [A-Za-z\s]+?)(?:\s+(?:DPIIT|Department of [A-Za-z,\s&]+?|Ministry of [A-Za-z,\s&]+?))*\s*/;
    const PROJECT_NOTE_RE = /\s*This approval will be applied from project Project \d+\s*/g;

    const approvals = [];

    for (let i = 0; i < parts.length - 1; i++) {
      let chunk = parts[i].replace(PROJECT_NOTE_RE, ' ').trim();

      // Extract step category from end of chunk
      const stepMatch = chunk.match(STEP_RE);
      if (!stepMatch) continue;
      const step = stepMatch[1].replace(/^For /, '');
      chunk = chunk.slice(0, chunk.length - stepMatch[0].length).trim();

      // Strip boilerplate from the start (previous entry's dept/ministry text)
      let name;
      if (i === 0) {
        // First chunk starts with "CENTRAL APPROVALS (N) "
        name = chunk.replace(/^CENTRAL APPROVALS\s*\(\d+\)\s*/, '').trim();
      } else {
        // Strip leading ministry/dept noise until we hit the real name
        const stripped = chunk.replace(BOILERPLATE_RE, '').trim();
        name = stripped.length > 3 ? stripped : chunk;
      }

      // Extract issuedBy from the start of the NEXT part
      const nextPart = (parts[i + 1] || '').replace(PROJECT_NOTE_RE, ' ').trim();
      const issuedByMatch = nextPart.match(/^((?:DPIIT|Department of [A-Za-z,\s&]+?|Ministry of [A-Za-z,\s&]+?|Bureau of [A-Za-z\s]+?)(?:\s+(?:DPIIT|Department of [A-Za-z,\s&]+?|Ministry of [A-Za-z,\s&]+?))*)\s*(?=[A-Z]|$)/);
      const issuedBy = issuedByMatch ? issuedByMatch[1].trim() : '';

      // Split issuedBy into department + ministry
      const ministryIdx = issuedBy.search(/\s+Ministry of\s/);
      const department = ministryIdx > 0 ? issuedBy.slice(0, ministryIdx).trim() : issuedBy;
      const ministry   = ministryIdx > 0 ? issuedBy.slice(ministryIdx).trim() : '';

      if (name && name.length > 3) {
        approvals.push({ name, step, department, ministry, issuedBy });
      }
    }

    return { approvals, claimedCount };
  }

  // ── Screenshot just the approvals section of the results page ─────────────
  async screenshotApprovalsSection(outputPath) {
    // Try to locate the approvals list container on the page
    const candidates = [
      '[class*="kya-result"]',
      '[class*="approval-list"]',
      '[class*="approvalList"]',
      '[class*="result-container"]',
      '[class*="resultContainer"]',
      '.ant-layout-content',
      'main',
    ];

    for (const sel of candidates) {
      const loc = this.page.locator(sel).first();
      try {
        if (await loc.isVisible({ timeout: 1000 })) {
          await loc.screenshot({ path: outputPath });
          console.log(`[extractor] Screenshot (${sel}) → ${outputPath}`);
          return outputPath;
        }
      } catch (_) {}
    }

    // Fallback: full page
    await this.page.screenshot({ path: outputPath, fullPage: true });
    console.log(`[extractor] Screenshot (full page) → ${outputPath}`);
    return outputPath;
  }

  // ── Master extraction ──────────────────────────────────────────────────────
  async extractAll(screenshotDir = null) {
    await this.waitForResults();

    const [structured, summary, tableData, sections] = await Promise.all([
      this.extractStructured(),
      this.extractResultsSummary(),
      this.extractTable(),
      this.extractPageSections(),
    ]);

    // Full body text snapshot
    const fullText = await this.page.evaluate(() =>
      document.body.innerText.trim().replace(/\s+/g, ' ').substring(0, 15000)
    );

    // Parse approvals from fullText — more reliable than CSS selectors for NSWS
    const parsed = DataExtractor.parseApprovalsFromText(fullText);
    const parsedApprovals = parsed.approvals || [];

    // Use structured cards if found; fall back to fullText parsing
    const approvals = (structured?.cards?.length)
      ? structured.cards
      : parsedApprovals;

    const approvalCount = approvals.length || summary?.myApprovalsCount || summary?.countExtracted || 0;
    const extractionSource = structured?.cards?.length ? structured.source
      : parsedApprovals.length ? 'fulltext-parsed'
      : 'fallback';

    // Screenshot the approvals section (not full page)
    let screenshotPath = null;
    if (screenshotDir) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      screenshotPath = path.join(screenshotDir, `result-${ts}.png`);
      await this.screenshotApprovalsSection(screenshotPath);
    }

    return {
      summary,
      approvals,
      approvalCount,
      extractionSource,
      tables: tableData,
      pageSections: sections,
      fullText,
      screenshotPath,
      apiResponses: this._capturedApiResponses,
    };
  }

  // Legacy method
  async extractApprovals() {
    const result = await this.extractAll();
    if (result.approvals.length) {
      return result.approvals.map(a => ({
        source: result.extractionSource,
        rawText: a.rawText || a.name || JSON.stringify(a),
        ...a,
      }));
    }
    return await this.page.evaluate(() => {
      const approvals = [];
      const selectors = ['.kya-result-card','.approval-result-card','.kya-approval-item','.approval-name-container','.result-approval-card','.ant-card','.ant-list-item'];
      for (const sel of selectors) {
        const items = document.querySelectorAll(sel);
        if (items.length > 0) {
          items.forEach(item => {
            const text = item.innerText.trim().replace(/\s+/g, ' ');
            if (text.length > 5) approvals.push({ source: sel, rawText: text });
          });
          if (approvals.length) return approvals;
        }
      }
      approvals.push({ source: 'body', rawText: document.body.innerText.substring(0, 3000).replace(/\s+/g, ' ') });
      return approvals;
    });
  }
}

module.exports = { DataExtractor };
