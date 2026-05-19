const path = require('path');
const fs = require('fs');

class DataExtractor {
  constructor(page) {
    this.page = page;
    this._capturedApiResponses = [];
  }

  // Call before submit to wire up network interception
  startNetworkCapture() {
    this.page.on('response', async (response) => {
      const url = response.url();
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      // Capture any JSON endpoint that looks like approval/KYA results
      if (
        url.includes('kya') ||
        url.includes('approval') ||
        url.includes('license') ||
        url.includes('know-your') ||
        url.includes('investor') ||
        url.includes('result')
      ) {
        try {
          const body = await response.json().catch(() => null);
          if (body) {
            this._capturedApiResponses.push({ url, status: response.status(), body });
          }
        } catch (_) {}
      }
    });
  }

  getCapturedApiResponses() {
    return this._capturedApiResponses;
  }

  // Wait for the results page to stabilise after submit
  async waitForResults(timeout = 20000) {
    const resultSelectors = [
      '.kya-result-card',
      '.approval-result-card',
      '.kya-approval-item',
      '.result-approval-card',
      '.approval-name-container',
      '.ant-result',
      '.kya-result',
      '.results-container',
    ];

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = await this.page.evaluate((sels) => {
        return sels.some(s => document.querySelectorAll(s).length > 0);
      }, resultSelectors);
      if (found) break;
      await this.page.waitForTimeout(500);
    }
    // Extra settle time for dynamic renders
    await this.page.waitForTimeout(2000);
  }

  // Core structured extraction — walks every visible result card
  async extractStructured() {
    return await this.page.evaluate(() => {
      const norm = t => (t || '').trim().replace(/\s+/g, ' ');

      // Try to pull a named text field from a container
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

      const extractLinks = (el) => {
        return [...el.querySelectorAll('a[href]')]
          .map(a => ({ text: norm(a.innerText), href: a.href }))
          .filter(l => l.href && !l.href.startsWith('javascript'));
      };

      // Ordered list of candidate card selectors
      const cardSelectors = [
        '.kya-result-card',
        '.approval-result-card',
        '.kya-approval-item',
        '.result-approval-card',
        '.approval-name-container',
        '.ant-card',
        '.ant-list-item',
      ];

      for (const cardSel of cardSelectors) {
        const cards = [...document.querySelectorAll(cardSel)];
        if (!cards.length) continue;

        const results = cards.map(card => {
          // --- Approval name / title ---
          const name = pickText(
            card,
            '.approval-name', '.kya-approval-name', '.approval-title',
            '.result-title', '.ant-card-head-title', 'h3', 'h4', 'h2',
            '.approval-name-container', '[class*="name"]', '[class*="title"]'
          ) || norm(card.querySelector('strong, b')?.innerText || '');

          // --- Authority / department ---
          const authority = pickText(
            card,
            '.approval-authority', '.kya-authority', '.department-name',
            '.authority-name', '[class*="authority"]', '[class*="department"]',
            '.ant-card-extra', '.issuing-authority'
          );

          // --- Category / type ---
          const category = pickText(
            card,
            '.approval-category', '.kya-category', '.approval-type',
            '[class*="category"]', '[class*="type"]', '.ant-tag'
          );

          // --- Description / details ---
          const description = pickText(
            card,
            '.approval-description', '.kya-description', '.approval-detail',
            '.card-body', '.ant-card-body', '[class*="description"]',
            '[class*="detail"]', 'p'
          );

          // --- Fee / timeline ---
          const fee = pickText(card, '[class*="fee"]', '[class*="cost"]', '[class*="charge"]');
          const timeline = pickText(card, '[class*="timeline"]', '[class*="duration"]', '[class*="days"]');

          // --- Apply / more-info links ---
          const links = extractLinks(card);
          const applyLink = pickAttr(card, 'href', 'a[class*="apply"]', 'a[class*="register"]', 'a.ant-btn-primary');

          // --- Status / mandatory ---
          const status = pickText(card, '[class*="status"]', '[class*="mandatory"]', '[class*="required"]');

          // --- Full raw text (fallback) ---
          const rawText = norm(card.innerText);

          return { name, authority, category, description, fee, timeline, status, applyLink, links, rawText, cardSelector: cardSel };
        }).filter(r => r.rawText.length > 5);

        if (results.length) return { source: cardSel, cards: results };
      }

      return null;
    });
  }

  // Extract summary header / count shown on results page
  async extractResultsSummary() {
    return await this.page.evaluate(() => {
      const norm = t => (t || '').trim().replace(/\s+/g, ' ');
      const summary = {};

      // Count badge / heading
      const countEl = document.querySelector(
        '.result-count, .kya-count, [class*="approval-count"], [class*="total-count"], .ant-result-title'
      );
      if (countEl) summary.countText = norm(countEl.innerText);

      // Page heading
      const heading = document.querySelector(
        '.kya-result-heading, .result-heading, h1.ant-typography, h2.ant-typography, .ant-result-subtitle'
      );
      if (heading) summary.heading = norm(heading.innerText);

      // Extract any visible number from common patterns
      const bodyText = document.body.innerText;
      const match = bodyText.match(/(\d+)\s*(approval|license|registration|permit)/i);
      if (match) summary.countExtracted = parseInt(match[1], 10);

      summary.pageTitle = document.title;
      summary.pageUrl = window.location.href;

      return summary;
    });
  }

  // Extract table-based results (some pages render a table)
  async extractTable() {
    return await this.page.evaluate(() => {
      const norm = t => (t || '').trim().replace(/\s+/g, ' ');
      const tables = [...document.querySelectorAll('table')];

      const tableData = [];
      for (const table of tables) {
        const headers = [...table.querySelectorAll('thead th, tr:first-child th')]
          .map(th => norm(th.innerText));
        const rows = [...table.querySelectorAll('tbody tr, tr:not(:first-child)')]
          .map(tr => {
            const cells = [...tr.querySelectorAll('td, th')].map(td => norm(td.innerText));
            if (cells.some(c => c.length > 0)) {
              if (headers.length) {
                const obj = {};
                headers.forEach((h, i) => { obj[h || `col${i}`] = cells[i] || ''; });
                return obj;
              }
              return cells;
            }
            return null;
          })
          .filter(Boolean);

        if (rows.length) tableData.push({ headers, rows });
      }
      return tableData.length ? tableData : null;
    });
  }

  // Full-page text sections — section-by-section fallback
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
        root.innerText.split('\n')
          .map(l => norm(l))
          .filter(l => l.length > 10)
          .forEach(l => sections.push({ heading: '', content: l }));
      }

      return sections;
    });
  }

  // Master extraction: runs all strategies and returns a unified object
  async extractAll(screenshotDir = null) {
    await this.waitForResults();

    const [structured, summary, tableData, sections] = await Promise.all([
      this.extractStructured(),
      this.extractResultsSummary(),
      this.extractTable(),
      this.extractPageSections(),
    ]);

    let screenshotPath = null;
    if (screenshotDir) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      screenshotPath = path.join(screenshotDir, `result-${ts}.png`);
      await this.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    }

    // Full body text snapshot (last resort)
    const fullText = await this.page.evaluate(() =>
      document.body.innerText.trim().replace(/\s+/g, ' ').substring(0, 10000)
    );

    const approvalCount = structured?.cards?.length
      ?? summary?.countExtracted
      ?? (tableData ? tableData.reduce((n, t) => n + t.rows.length, 0) : 0);

    return {
      summary,
      approvals: structured?.cards ?? [],
      approvalCount,
      extractionSource: structured?.source ?? 'fallback',
      tables: tableData,
      pageSections: sections,
      fullText,
      screenshotPath,
      apiResponses: this._capturedApiResponses,
    };
  }

  // Legacy method kept for backwards compat
  async extractApprovals() {
    const result = await this.extractAll();
    if (result.approvals.length) return result.approvals.map(a => ({ source: result.extractionSource, rawText: a.rawText, ...a }));

    // Fall through to old broad extraction
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
