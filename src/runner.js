/**
 * NSWS Predefined Runner
 *
 * Fills the NSWS KYA form at https://www.nsws.gov.in/portal/investor-decision
 * using a fixed set of answers from answers.config.json, then writes the
 * approvals result to the configured outputFile.
 *
 * Usage:
 *   node src/runner.js
 *   node src/runner.js --config=path/to/custom.json
 */

const path = require('path');
const fs = require('fs');
const { BrowserController } = require('./automation/browser-controller');
const { FieldDiscovery } = require('./automation/field-discovery');
const { FormFiller } = require('./automation/form-filler');
const { DataExtractor } = require('./automation/data-extractor');

// ── Load config ───────────────────────────────────────────────────────────────

const configArg = process.argv.find(a => a.startsWith('--config='));
const configPath = configArg
  ? path.resolve(configArg.split('=')[1])
  : path.resolve(__dirname, '..', 'answers.config.json');

if (!fs.existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const { mode = 'central', answers = [], outputFile = 'data/predefined-result.json' } = config;

if (!answers.length) {
  console.error('No answers defined in config.');
  process.exit(1);
}

const norm = t => (t || '').replace(/\s+/g, ' ').trim().toLowerCase();

// Lookup: normalized question label → answer text
const answerMap = new Map(answers.map(a => [norm(a.question), a.answer]));

// ── Click "Continue with Central/State" on the landing page ──────────────────

async function clickContinue(page, mode) {
  const clicked = await page.evaluate((m) => {
    const fillBtn = document.querySelector('.button.fill');
    if (fillBtn) { fillBtn.click(); return true; }
    const all = [...document.querySelectorAll('.button, button')];
    const match = all.find(b =>
      (b.innerText || '').toLowerCase().includes('continue with ' + m.toLowerCase())
    );
    if (match) { match.click(); return true; }
    return false;
  }, mode === 'state' ? 'state' : 'central');

  if (clicked) await page.waitForTimeout(2000);
  return clicked;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`[runner] Starting — mode: ${mode}`);
  console.log(`[runner] ${answers.length} predefined answer(s) loaded from ${configPath}`);

  const browserCtrl = new BrowserController();
  await browserCtrl.init(true); // headed=true so you can watch it

  try {
    const page = browserCtrl.getPage();
    const fieldDiscovery = new FieldDiscovery(page);
    const formFiller = new FormFiller(page);
    const dataExtractor = new DataExtractor(page);

    // Capture JSON API responses produced after submit
    dataExtractor.startNetworkCapture();

    // Navigate and open the form
    await browserCtrl.navigateTo('https://www.nsws.gov.in/portal/investor-decision');
    await page.waitForTimeout(1500);

    const started = await clickContinue(page, mode);
    if (!started) throw new Error('Could not click "Continue" on the landing page');

    await page.waitForSelector('.question-container', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const appliedQuestions = new Set();
    const stepData = [];
    let rounds = 0;
    const MAX_ROUNDS = answers.length * 4; // handle dynamic reveals

    while (rounds < MAX_ROUNDS) {
      rounds++;

      // Discover every visible field across all accordion steps
      const allFields = await fieldDiscovery.discoverFromAllSteps();
      const pending = allFields.filter(
        f => !appliedQuestions.has(norm(f.label)) && answerMap.has(norm(f.label))
      );

      if (!pending.length) break; // nothing left to fill

      for (const field of pending) {
        const answerText = answerMap.get(norm(field.label));
        console.log(`[runner] Filling: "${field.label}" → "${answerText}"`);

        // Expand the correct accordion step before filling
        if (field.step) await fieldDiscovery.expandStepByHeader(field.step);
        await fieldDiscovery.discover(); // refresh data-nsws-id after expansion

        let optionId = null;

        if (field.type === 'radio') {
          const match = (field.options || []).find(o => norm(o.text) === norm(answerText));
          if (!match) {
            console.warn(`[runner] Option "${answerText}" not found in radio "${field.label}" — skipping`);
            appliedQuestions.add(norm(field.label));
            continue;
          }
          optionId = match.id;

        } else if (field.type === 'ant-select') {
          const options = await fieldDiscovery.getSelectOptions(field.id);
          const match = options.find(o => norm(o.text) === norm(answerText));
          // FormFiller does its own text-based search inside the dropdown;
          // optionId is only used as a fallback when the element needs to be located.
          optionId = match ? match.id : field.id;
        }

        const fieldsBefore = await fieldDiscovery.discover();
        const labelsBefore = new Set(fieldsBefore.map(f => f.label));

        try {
          await formFiller.fillField({
            fieldId: field.id,
            fieldType: field.type,
            optionId,
            text: answerText,
            label: field.label,
            step: field.step,
          });
        } catch (e) {
          console.error(`[runner] Fill failed for "${field.label}": ${e.message}`);
          appliedQuestions.add(norm(field.label));
          continue;
        }

        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);

        const additionalInfo = await fieldDiscovery.captureAdditionalInfoPanel();

        if (field.step) await fieldDiscovery.expandStepByHeader(field.step);
        const fieldsAfter = await fieldDiscovery.discover();
        const newQs = fieldsAfter
          .filter(f => !labelsBefore.has(f.label))
          .map(f => ({ question: f.label, type: f.type, step: f.step }));

        if (newQs.length) {
          console.log(`[runner]   Revealed ${newQs.length} new question(s): ${newQs.map(q => q.question).join(', ')}`);
        }

        stepData.push({
          step: field.step || '',
          question: field.label,
          answerSelected: answerText,
          newQuestionsRevealed: newQs,
          additionalInfoPanel: additionalInfo,
        });

        appliedQuestions.add(norm(field.label));
      }
    }

    // Expand all steps so the submit button is reachable
    await fieldDiscovery.expandAllSteps();
    await page.waitForTimeout(500);

    console.log('[runner] Submitting form…');
    const submitted = await formFiller.clickSubmit();

    const outDir = path.resolve(path.dirname(path.resolve(outputFile)));
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    let extractionResult = { approvals: [], summary: {}, tables: null, pageSections: [], fullText: '', screenshotPath: null, apiResponses: [], approvalCount: 0, extractionSource: 'none' };

    if (submitted) {
      console.log('[runner] Extracting all post-submit data…');
      extractionResult = await dataExtractor.extractAll(outDir);
      console.log(`[runner] ${extractionResult.approvalCount} approval(s) found via "${extractionResult.extractionSource}"`);
      if (extractionResult.screenshotPath) {
        console.log(`[runner] Screenshot → ${extractionResult.screenshotPath}`);
      }
      if (extractionResult.apiResponses.length) {
        console.log(`[runner] ${extractionResult.apiResponses.length} API response(s) captured`);
      }
    } else {
      console.warn('[runner] Submit button not visible — form may be incomplete or answers are insufficient');
    }

    // ── Write result JSON ────────────────────────────────────────────────────
    const output = {
      metadata: {
        generatedAt: new Date().toISOString(),
        mode,
        configFile: configPath,
        totalAnswersApplied: appliedQuestions.size,
        submitted,
        resultPageUrl: extractionResult.summary?.pageUrl || '',
        resultPageTitle: extractionResult.summary?.pageTitle || '',
        approvalCount: extractionResult.approvalCount,
        extractionSource: extractionResult.extractionSource,
        screenshotPath: extractionResult.screenshotPath,
      },
      answers,
      selections: stepData,
      resultSummary: extractionResult.summary,
      approvalsRequired: extractionResult.approvals,
      tables: extractionResult.tables,
      pageSections: extractionResult.pageSections,
      fullPageText: extractionResult.fullText,
      apiResponses: extractionResult.apiResponses,
    };

    const outPath = path.resolve(outputFile);
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`[runner] Result saved → ${outPath}`);

  } finally {
    await browserCtrl.close();
  }
}

run().catch(e => {
  console.error('[runner] Fatal:', e.message);
  process.exit(1);
});
