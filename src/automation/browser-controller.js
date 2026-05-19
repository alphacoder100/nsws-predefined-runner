const { chromium } = require('playwright');
const config = require('../../playwright.config.js');

class BrowserController {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async init(headed = false) {
    this.browser = await chromium.launch({
      headless: !headed,
      viewport: config.use.viewport,
    });
    this.context = await this.browser.newContext({ ignoreHTTPSErrors: true });
    this.page = await this.context.newPage();
  }

  async navigateTo(url) {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.page
      .locator('.button.fill')
      .first()
      .waitFor({ state: 'visible', timeout: 20000 })
      .catch(() => {});
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  getPage() {
    return this.page;
  }
}

module.exports = { BrowserController };
