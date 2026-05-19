const { FieldDiscovery } = require('./field-discovery');

class FormFiller {
  constructor(page) {
    this.page = page;
  }

  normalizeText(value) {
    return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  async scrollLocatorIntoView(locator) {
    try {
      await locator.evaluate(el => {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      });
    } catch (_) {}
    await this.page.waitForTimeout(200);
  }

  async robustClick(locator, timeout = 5000) {
    for (const attempt of [
      () => locator.click({ timeout }),
      () => locator.click({ timeout, force: true }),
      () => locator.evaluate(el => el.click()),
    ]) {
      try { await attempt(); return true; } catch (_) {}
    }
    return false;
  }

  async fillField(fieldSelection) {
    const { fieldId, fieldType, optionId, text } = fieldSelection;
    let attempts = 0;

    while (attempts < 2) {
      try {
        if (fieldType === 'radio') {
          const locator = this.page.locator(`[data-nsws-id="${optionId}"]`).first();
          await this.scrollLocatorIntoView(locator);

          let ok = await this.robustClick(locator, 3000);
          if (!ok) {
            const input = locator.locator('input').first();
            if (await input.count().catch(() => 0) > 0) {
              await this.scrollLocatorIntoView(input);
              ok = await this.robustClick(input, 3000);
            }
          }
          if (!ok) {
            ok = await locator.evaluate(el => { el.click(); return true; }).catch(() => false);
          }
          if (!ok) throw new Error(`Cannot click radio option "${text}"`);

        } else if (fieldType === 'ant-select') {
          let filled = false;
          for (let tryOpen = 0; tryOpen < 4; tryOpen++) {
            const result = await this.page.evaluate(async ({ fid, txt }) => {
              const norm = t => (t || '').replace(/\s+/g, ' ').trim().toLowerCase();
              const tgt = norm(txt);
              const sleep = ms => new Promise(r => setTimeout(r, ms));
              const isVis = d =>
                !d.classList.contains('ant-select-dropdown-hidden') &&
                (d.offsetWidth > 0 || d.offsetHeight > 0 || d.getClientRects().length > 0);

              const el = document.querySelector(`[data-nsws-id="${fid}"]`);
              if (!el) return { ok: false, reason: 'element_not_found' };
              el.scrollIntoView({ block: 'nearest', behavior: 'instant' });

              const beforeSet = new Set([...document.querySelectorAll('.ant-select-dropdown')].filter(isVis));

              const sel = el.querySelector('.ant-select-selector') || el;
              sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
              sel.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

              await sleep(1000);

              const allVis = [...document.querySelectorAll('.ant-select-dropdown')].filter(isVis);
              const newlyVis = allVis.filter(d => !beforeSet.has(d));

              let dd;
              if (newlyVis.length === 1) {
                dd = newlyVis[0];
              } else {
                const elRect = el.getBoundingClientRect();
                let minDist = Infinity;
                for (const d of allVis) {
                  const dRect = d.getBoundingClientRect();
                  const dist = Math.abs(dRect.top - elRect.bottom) + Math.abs(dRect.left - elRect.left) * 0.1;
                  if (dist < minDist) { minDist = dist; dd = d; }
                }
              }
              if (!dd) return { ok: false, reason: 'no_dropdown' };

              const tryClick = () => {
                for (const t of dd.querySelectorAll('.ant-select-tree-treenode .ant-select-tree-title')) {
                  if (norm(t.innerText).includes(tgt)) {
                    t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                    t.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    return true;
                  }
                }
                for (const item of dd.querySelectorAll('.ant-select-item-option')) {
                  if (norm(item.innerText).includes(tgt)) {
                    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    return true;
                  }
                }
                return false;
              };

              if (tryClick()) return { ok: true };

              const holder = dd.querySelector('.rc-virtual-list-holder') || dd;
              const maxScroll = holder.scrollHeight;
              for (let pos = 40; pos <= maxScroll; pos += 40) {
                holder.scrollTop = pos;
                await sleep(80);
                if (tryClick()) return { ok: true };
              }

              return { ok: false, reason: `option_not_found:${txt}` };
            }, { fid: fieldId, txt: text });

            if (result.ok) { filled = true; break; }
            if (result.reason === 'element_not_found') {
              const fd = new FieldDiscovery(this.page);
              await fd.discover();
              await this.page.waitForTimeout(300);
              continue;
            }
            throw new Error(`Select failure for "${text}": ${result.reason}`);
          }
          if (!filled) throw new Error(`Select element not found for fieldId="${fieldId}"`);

          await this.page.waitForTimeout(500);
        }

        await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
        await this.page.waitForTimeout(500);
        return true;

      } catch (e) {
        attempts++;
        console.warn(`Attempt ${attempts} failed for ${fieldId} ("${text}"): ${e.message}`);
        if (attempts >= 2) {
          console.error(`Final failure for ${fieldId} with "${text}":`, e.message);
          throw e;
        }
        await this.page.waitForTimeout(1000);
      }
    }
    return false;
  }

  async clickNext() {
    const labels = ['Next', 'CONTINUE', 'Continue'];
    const selector = labels
      .map(l => `button:not(.slick-arrow):not(.slick-disabled):has-text("${l}")`)
      .join(', ');
    const nextBtn = this.page.locator(selector).first();
    if (await nextBtn.isVisible().catch(() => false)) {
      await this.scrollLocatorIntoView(nextBtn);
      const clicked = await this.robustClick(nextBtn, 5000);
      if (!clicked) return false;
      await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await this.page.waitForTimeout(1500);
      return true;
    }
    return false;
  }

  async clickSubmit() {
    const submitBtn = this.page.locator(
      'button:has-text("Submit to Know Your Approvals"), .button:has-text("Submit to Know Your Approvals"), button:has-text("Submit"), .button:has-text("Submit")'
    ).first();

    if (await submitBtn.isVisible().catch(() => false)) {
      await this.scrollLocatorIntoView(submitBtn);
      const clicked = await this.robustClick(submitBtn, 8000);
      if (clicked) {
        await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await this.page.waitForTimeout(3000);
        return true;
      }
    }
    return false;
  }
}

module.exports = { FormFiller };
