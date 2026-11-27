/**
 * Embedded desktop (embedded call) layout contract — CSS source lock.
 *
 * The compact dock and the detached overflow tray are pure CSS, so the
 * Puppeteer harness (`agil/core/qa/call-ui-v3/embedded call-capture.mjs`) is the
 * authoritative geometry test. This unit test is the cheap early warning: the
 * exact contract values live in one place and a refactor cannot silently drop
 * the 12 px island inset, the 16 px radius, the 460 px tray cap or the
 * 13 px gap above the dock without failing on every run (no browser needed).
 *
 * The selectors are all scoped to `[data-agil-embedded-desktop='true']`, so the
 * default widget and every touch layout are intentionally untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

interface CssRule {
  selector: string;
  body: string;
}

/** Flat list of `selector { declarations }` pairs (nested @media rules included). */
const rules: CssRule[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selector: match[1].replace(/\s+/g, ' ').trim(),
  body: match[2],
}));

/** First rule whose selector includes `selector` and whose body matches `body`. */
function rule(selector: string, body?: RegExp): CssRule {
  const found = rules.find((candidate) => candidate.selector.includes(selector) && (!body || body.test(candidate.body)));
  assert.ok(found, `missing rule: ${selector}${body ? ` matching ${body}` : ''}`);
  return found;
}

const embedded = ".agil-root[data-agil-embedded-desktop='true']";
const panelSelector = `${embedded} .agil-controls .agil-controls-more-popover`;

test('the floating dock is a fit-content overlay over the video, 12px above the bottom', () => {
  const dock = rule(`${embedded} .agil-controls-layer .agil-controls`).body;
  assert.match(dock, /bottom:\s*12px/);
  // Fit-content: the island hugs its buttons instead of spanning the card.
  assert.match(dock, /width:\s*fit-content/);
  assert.match(dock, /max-width:\s*calc\(100% - 24px\)/);
  assert.match(dock, /display:\s*flex/);
  assert.match(dock, /flex-wrap:\s*nowrap/);
  assert.match(dock, /justify-content:\s*center/);
  // No stretched three-column grid and no space-between.
  assert.doesNotMatch(dock, /space-between/);
  assert.doesNotMatch(dock, /grid-template-columns/);
  assert.match(dock, /border-radius:\s*16px/);
  assert.match(dock, /box-shadow:/);
  assert.match(dock, /backdrop-filter:\s*blur/);
  // A real border, not a transparent hairline.
  assert.match(dock, /border:\s*1px solid/);
});

test('the stage has no reserved dock band; the video reaches the bottom', () => {
  const stage = rule(`${embedded} .agil-stage`).body;
  assert.match(stage, /padding-bottom:\s*0/);
  assert.doesNotMatch(stage, /padding-bottom:\s*(62|64|72)px/);
});

test('dock groups are tight runs with a proximity divider, not empty cells', () => {
  const group = rule(`${embedded} .agil-controls-group`, /gap:\s*4px/).body;
  assert.match(group, /display:\s*flex/);
  assert.match(group, /flex:\s*0 0 auto/);
  assert.match(group, /gap:\s*4px/);

  const divider = rule(`${embedded} .agil-controls-group + .agil-controls-group`, /border-inline-start/).body;
  assert.match(divider, /margin-inline-start:\s*8px/);
  assert.match(divider, /padding-inline-start:\s*8px/);

});

test('the bottom-row tile overlay lifts labels above the floating island', () => {
  const safe = rule('.agil-root .agil-tile-overlay', /--agil-tile-dock-inset/).body;
  assert.match(safe, /bottom:\s*var\(--agil-tile-dock-inset,\s*0px\)/);
});

test('the detached overflow tray wraps inside its host', () => {
  // 13px = 12px visible gap after the dock's 1px border. The offset is shared
  // with the camera/reactions menus so every popover clears the dock equally.
  const detachRule = rule(`${embedded} .agil-controls .agil-video-menu`, /calc\(100% \+ 13px\)/);
  assert.match(detachRule.body, /bottom:\s*calc\(100% \+ 13px\) !important/);
  assert.match(detachRule.selector, /more-popover/);

  // `100%` is the dock width, so this is also the centred-above-the-dock rule.
  const panel = rule(panelSelector, /display:\s*flex/).body;
  assert.match(panel, /flex-wrap:\s*wrap/);
  assert.match(panel, /width:\s*fit-content/);
  // Cap the tray by the viewport and, in a narrow embed, by the call container.
  assert.match(panel, /max-width:\s*min\(460px, calc\(100vw - 24px\)\)/);
  assert.match(rule(`${embedded} .agil-controls-layer .agil-controls .agil-controls-more-popover`, /100cqw/).body,
    /max-width:\s*min\(460px, calc\(100cqw - 24px\)\)/);
  assert.match(panel, /justify-content:\s*center/);
  assert.match(panel, /left:\s*50%/);
  assert.match(panel, /transform:\s*translateX\(-50%\)/);
  assert.match(panel, /max-height:\s*none/);
  assert.match(panel, /overflow:\s*auto/);
  assert.match(panel, /border-radius:\s*16px/);
  assert.match(panel, /box-shadow:/);
  assert.match(panel, /backdrop-filter:\s*blur/);

  // Groups retain the flexible chip layout when they wrap.
  const columns = rules.filter(
    (candidate) => candidate.selector.includes(embedded) && candidate.selector.includes('more-popover') && /grid-template-columns/.test(candidate.body),
  );
  assert.deepEqual(columns, [], 'embedded tray must not use a column grid');
});

test('chips are 50x54, icon-over-label, with a 9.5px short label', () => {
  const chip = rule(`${panelSelector} .agil-control`, /height:\s*54px/).body;
  assert.match(chip, /width:\s*50px/);
  assert.match(chip, /min-width:\s*50px/);
  assert.match(chip, /height:\s*54px/);
  assert.match(chip, /min-height:\s*54px/);
  assert.match(chip, /flex-direction:\s*column/);
  assert.match(chip, /gap:\s*3px/);
  assert.match(chip, /border-radius:\s*10px/);

  const glyph = rule(`${panelSelector} .agil-control > svg`, /width:\s*18px/).body;
  assert.match(glyph, /height:\s*18px/);

  const shortLabel = rule(`${panelSelector} .agil-control-label-short`, /font-size:\s*9.5px/).body;
  assert.match(shortLabel, /display:\s*block/);
  assert.match(shortLabel, /font-size:\s*9.5px/);
  assert.match(shortLabel, /letter-spacing:\s*-0\.1px/);
  assert.match(shortLabel, /white-space:\s*nowrap/);
});

test('groups wrap their own chips and keep their dividers and 4px gaps', () => {
  const group = rule(`${panelSelector} .agil-overflow-group`, /display:\s*flex/).body;
  assert.match(group, /flex-wrap:\s*wrap/);
  assert.match(group, /max-width:\s*100%/);
  assert.match(group, /gap:\s*4px/);

  const divider = rule(`${panelSelector} .agil-overflow-group + .agil-overflow-group`, /border-inline-start/).body;
  assert.match(divider, /border-inline-start:\s*1px solid/);

  // The headings stay in the DOM for assistive tech but do not print in the
  // tray (the chips carry the visible labels).
  const heading = rule(`${panelSelector} .agil-overflow-group .agil-overflow-group-label`, /clip-path/).body;
  assert.match(heading, /position:\s*absolute/);
  assert.match(heading, /clip-path:\s*inset\(50%\)/);
});

test('touch/default popover is untouched: grid popover, transparent groups, full labels', () => {
  // The default C-08 popover keeps its auto-fit grid; 900px+ keeps 3 columns.
  const base = rule('.agil-controls-more-popover', /grid-template-columns:\s*repeat\(auto-fit/).body;
  assert.match(base, /grid-template-columns:\s*repeat\(auto-fit, minmax\(150px, 1fr\)\)/);
  const wide = rule('.agil-controls-more-popover,', /grid-template-columns:\s*repeat\(3/).body;
  assert.match(wide, /width:\s*620px/);

  // Group wrappers must not add a layout box outside the embedded desktop.
  const group = rule('.agil-overflow-group', /display:\s*contents/);
  assert.equal(group.selector, '.agil-overflow-group');

  // The short chip label only exists for the embedded tray.
  const hidden = rule('.agil-controls-more-popover .agil-control-label-short', /display:\s*none/).body;
  assert.match(hidden, /display:\s*none/);
});
