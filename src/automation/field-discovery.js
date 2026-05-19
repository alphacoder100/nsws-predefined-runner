class FieldDiscovery {
  constructor(page) {
    this.page = page;
  }

  async expandStepByHeader(headerText) {
    if (!headerText) return false;
    const expanded = await this.page.evaluate((text) => {
      const items = [...document.querySelectorAll('.ant-collapse-item')];
      for (const item of items) {
        const h = item.querySelector('.ant-collapse-header');
        const normalised = (h?.innerText || '').trim().replace(/\n+/g, ' ').substring(0, 40);
        if (normalised === text && !item.classList.contains('ant-collapse-item-active')) {
          h.click();
          return true;
        }
      }
      return false;
    }, headerText);
    if (expanded) await this.page.waitForTimeout(1200);
    return expanded;
  }

  async expandAllSteps() {
    const stepCount = await this.page.evaluate(() =>
      document.querySelectorAll('.ant-collapse-item').length
    );
    let expanded = 0;
    for (let i = 0; i < stepCount; i++) {
      const clicked = await this.page.evaluate((idx) => {
        const items = [...document.querySelectorAll('.ant-collapse-item')];
        const item = items[idx];
        if (!item || item.classList.contains('ant-collapse-item-active')) return false;
        const header = item.querySelector('.ant-collapse-header');
        if (header) { header.click(); return true; }
        return false;
      }, i);
      if (clicked) {
        await this.page.waitForTimeout(700);
        expanded++;
      }
    }
    return expanded;
  }

  async discoverFromAllSteps() {
    const stepCount = await this.page.evaluate(() =>
      document.querySelectorAll('.ant-collapse-item').length
    );

    let allFields = [];
    const seenIds = new Set();

    for (let i = 0; i < stepCount; i++) {
      const clicked = await this.page.evaluate((idx) => {
        const items = [...document.querySelectorAll('.ant-collapse-item')];
        const item = items[idx];
        if (!item) return false;
        if (!item.classList.contains('ant-collapse-item-active')) {
          const header = item.querySelector('.ant-collapse-header');
          if (header) { header.click(); return true; }
        }
        return false;
      }, i);
      if (clicked) await this.page.waitForTimeout(700);

      const stepFields = await this.discover();
      for (const f of stepFields) {
        if (!seenIds.has(f.id)) {
          seenIds.add(f.id);
          allFields.push(f);
        }
      }
    }

    return allFields;
  }

  async discover() {
    return await this.page.evaluate(() => {
      const fields = [];

      const cleanText = (text) =>
        (text || '').trim().toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .substring(0, 80);

      const getFieldMeta = (element, fallbackLabel, index) => {
        const container =
          element.closest('.question-container, .question-list-wrapper, .ant-form-item, .form-group, .ant-row')
          || element.parentElement;

        const questionDetail = container && container.querySelector('.question-detail');
        const questionNumber = container && container.querySelector('.question-number');

        const prompt = questionDetail ? questionDetail.innerText.trim().replace(/\s+/g, ' ') : '';
        const number = questionNumber ? questionNumber.innerText.trim() : '';
        const label = prompt || (fallbackLabel || '').trim().replace(/\s+/g, ' ') || `Question ${index + 1}`;
        const stableBase = [number, prompt || fallbackLabel || `question_${index + 1}`]
          .filter(Boolean).map(cleanText).filter(Boolean).join('_');

        const collapsePanel = element.closest('.ant-collapse-content');
        const stepHeader = collapsePanel
          ? collapsePanel.closest('.ant-collapse-item')
              ?.querySelector('.ant-collapse-header')?.innerText?.trim()
              .replace(/\n+/g, ' ').substring(0, 40) || ''
          : '';

        const hasInfo = !!(container && container.querySelector(
          '.anticon-question-circle, .anticon-info-circle, [class*="info-icon"]'
        ));

        return { label, stableBase, step: stepHeader, hasInfo };
      };

      const getStableId = (type, stableBase, index) => {
        const cleanBase = cleanText(stableBase);
        return cleanBase ? `${type}_${cleanBase}` : `${type}_field_${index}`;
      };

      const selects = Array.from(document.querySelectorAll('.ant-select'));
      let selectCount = 0;
      selects.forEach(select => {
        if (select.classList.contains('ant-select-disabled')) return;
        const isVisible = select.offsetWidth > 0 || select.offsetHeight > 0 || select.getClientRects().length > 0;
        if (!isVisible) return;

        const { label, stableBase, step, hasInfo } = getFieldMeta(select, '', selectCount++);
        const stableId = getStableId('select', stableBase, selectCount - 1);
        select.dataset.nswsId = stableId;

        fields.push({
          id: stableId,
          type: 'ant-select',
          isMulti: select.classList.contains('ant-select-multiple'),
          label: label.replace(/\*/g, '').trim(),
          step, hasInfo,
        });
      });

      const radioGroups = Array.from(document.querySelectorAll('.ant-radio-group, .ant-checkbox-group'));
      let groupCount = 0;
      radioGroups.forEach(group => {
        const isVisible = group.offsetWidth > 0 || group.offsetHeight > 0;
        if (!isVisible) return;

        const { label, stableBase, step, hasInfo } = getFieldMeta(group, '', groupCount++);
        const stableGroupId = getStableId('radiogroup', stableBase, groupCount - 1);
        group.dataset.nswsId = stableGroupId;

        const options = [];
        const radios = Array.from(group.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
        radios.forEach((radio, rIdx) => {
          const wrapper = radio.closest(
            '.ant-radio-wrapper, .ant-radio-button-wrapper, .ant-checkbox-wrapper, label'
          );
          const optionText = wrapper ? wrapper.innerText.trim() : radio.value;
          const targetForId = wrapper || radio;
          const stableOptionId = `${stableGroupId}_opt_${rIdx}`;
          targetForId.dataset.nswsId = stableOptionId;
          options.push({ id: stableOptionId, value: radio.value, text: optionText });
        });

        fields.push({
          id: stableGroupId,
          type: 'radio',
          label: label.replace(/\*/g, '').trim(),
          options, step, hasInfo,
        });
      });

      return fields;
    });
  }

  async getSelectOptions(selectId) {
    let opened = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      opened = await this.page.evaluate((sid) => {
        const el = document.querySelector(`[data-nsws-id="${sid}"]`);
        if (!el) return false;
        el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        const sel = el.querySelector('.ant-select-selector') || el;
        sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        sel.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      }, selectId);

      if (opened) break;
      console.warn(`getSelectOptions attempt ${attempt + 1}: element not found for id="${selectId}", re-discovering...`);
      await this.discover();
      await this.page.waitForTimeout(500);
    }

    if (!opened) {
      console.warn(`getSelectOptions: element not found after retries for id="${selectId}"`);
      return [];
    }
    await this.page.waitForTimeout(1200);

    const options = await this.page.evaluate((sid) => {
      const dropdowns = Array.from(document.querySelectorAll('.ant-select-dropdown'));
      const visible = dropdowns.find(d =>
        (d.offsetWidth > 0 || d.offsetHeight > 0 || d.getClientRects().length > 0) &&
        !d.classList.contains('ant-select-dropdown-hidden')
      );
      if (!visible) return null;

      const treeNodes = Array.from(visible.querySelectorAll('.ant-select-tree-treenode'));
      if (treeNodes.length > 0) {
        const holder = visible.querySelector('.rc-virtual-list-holder') || visible;
        const allTexts = new Set();
        const results = [];
        let idx = 0;

        const scanCurrent = () => {
          for (const node of visible.querySelectorAll('.ant-select-tree-treenode')) {
            const titleEl = node.querySelector('.ant-select-tree-title');
            if (!titleEl) continue;
            const text = titleEl.innerText.trim();
            if (!text || allTexts.has(text)) continue;
            allTexts.add(text);
            const optionId = `${sid}_opt_${idx++}`;
            titleEl.dataset.nswsOptionId = optionId;
            node.dataset.nswsOptionId = optionId;
            results.push({ id: optionId, text, isTree: true });
          }
        };

        scanCurrent();
        const maxScroll = holder.scrollHeight;
        for (let pos = 50; pos <= maxScroll; pos += 50) {
          holder.scrollTop = pos;
          scanCurrent();
        }
        holder.scrollTop = 0;
        return results.length > 0 ? results : null;
      }

      const items = Array.from(visible.querySelectorAll('.ant-select-item-option'));
      return items.map((item, i) => {
        const optionId = `${sid}_opt_${i}`;
        item.dataset.nswsOptionId = optionId;
        return { id: optionId, text: item.innerText.trim(), isTree: false };
      });
    }, selectId);

    if (options === null) {
      await this.page.waitForTimeout(800);
      const retry = await this.page.evaluate((sid) => {
        const dropdowns = Array.from(document.querySelectorAll('.ant-select-dropdown'));
        const visible = dropdowns.find(d =>
          (d.offsetWidth > 0 || d.offsetHeight > 0 || d.getClientRects().length > 0) &&
          !d.classList.contains('ant-select-dropdown-hidden')
        );
        if (!visible) return [];
        const treeNodes = Array.from(visible.querySelectorAll('.ant-select-tree-treenode'));
        if (treeNodes.length > 0) {
          return treeNodes.map((n, i) => {
            const t = n.querySelector('.ant-select-tree-title');
            if (!t || !t.innerText.trim()) return null;
            const id = `${sid}_opt_${i}`;
            t.dataset.nswsOptionId = id;
            return { id, text: t.innerText.trim(), isTree: true };
          }).filter(Boolean);
        }
        return Array.from(visible.querySelectorAll('.ant-select-item-option'))
          .map((item, i) => ({ id: `${sid}_opt_${i}`, text: item.innerText.trim(), isTree: false }));
      }, selectId);
      await this.page.keyboard.press('Escape');
      await this.page.waitForTimeout(300);
      return retry || [];
    }

    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(300);
    return options || [];
  }

  async captureAdditionalInfoPanel() {
    const isVisible = await this.page.evaluate(() => {
      const panel = document.querySelector('.additional-detail-container');
      if (!panel) return false;
      return panel.classList.contains('show-details') &&
        (panel.offsetWidth > 0 || panel.offsetHeight > 0 || panel.getClientRects().length > 0);
    });
    if (!isVisible) return null;

    await this.page.evaluate(() => {
      const panel = document.querySelector('.additional-detail-container');
      if (!panel) return;
      panel.querySelectorAll('.ant-collapse-header').forEach(h => {
        const item = h.closest('.ant-collapse-item');
        if (item && !item.classList.contains('ant-collapse-item-active')) h.click();
      });
      panel.querySelectorAll('.anticon-plus-circle, .anticon-plus, [class*="expand"]').forEach(el => el.click());
    });
    await this.page.waitForTimeout(600);

    return await this.page.evaluate(() => {
      const panel = document.querySelector('.additional-detail-container');
      if (!panel) return null;

      const norm = t => (t || '').trim().replace(/\s+/g, ' ');
      const items = [];

      const collapseItems = panel.querySelectorAll('.ant-collapse-item');
      if (collapseItems.length > 0) {
        collapseItems.forEach(item => {
          const headerEl = item.querySelector('.ant-collapse-header');
          const contentEl = item.querySelector('.ant-collapse-content-box');
          const title = norm(headerEl?.innerText || '');
          const content = norm(contentEl?.innerText || '');
          if (title || content) items.push({ title, content });
        });
        if (items.length > 0) return { items };
      }

      const rawText = norm(panel.innerText || '');
      const marker = 'Additional Information';
      const bodyStart = rawText.indexOf(marker);
      const body = bodyStart > -1 ? rawText.substring(bodyStart + marker.length).trim() : rawText;
      if (!body) return null;

      const sectionSplits = body.split(/\n{2,}|\r\n{2,}/).map(s => s.trim()).filter(s => s.length > 3);
      if (sectionSplits.length > 1) {
        for (const section of sectionSplits) {
          if (section.endsWith('?')) {
            items.push({ title: section, content: '' });
          } else {
            const colonIdx = section.indexOf(':');
            if (colonIdx > 0 && colonIdx < 100) {
              items.push({ title: norm(section.substring(0, colonIdx)), content: norm(section.substring(colonIdx + 1)) });
            } else {
              items.push({ title: section, content: '' });
            }
          }
        }
        return { items };
      }

      return { items: [{ title: '', content: body }] };
    });
  }
}

module.exports = { FieldDiscovery };
