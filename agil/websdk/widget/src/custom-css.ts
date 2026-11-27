/**
 * Host-supplied `customCss` support.
 *
 * CSS is injected as a single `<style>` element and every selector is prefixed
 * with a per-instance attribute selector, so host rules cannot leak into the
 * embedding page (and two widgets on one page do not collide):
 *
 *   `.my-button { color: red }`
 *   → `[data-agil-widget="w-…"] .my-button { color: red }`
 *
 * `:root`, `html` and `body` map to the widget root itself; `&` is replaced by
 * the scope (CSS-nesting style). `@media`, `@supports`, `@container` and
 * `@layer` bodies are scoped recursively. `@keyframes`/`@font-face` stay global
 * by design, and `@import`/`@charset`/`@namespace` are dropped so custom CSS
 * cannot pull a remote stylesheet into the host page.
 *
 * The input is trusted host code; it is never inserted as HTML. A full
 * CSS-in-JS parser is out of scope — plain CSS without nesting is supported.
 */

let instanceSeq = 0;

/**
 * Decodes one CSS escape starting at `index` (a backslash). Hex escapes take
 * up to six digits plus one optional whitespace terminator; anything else is a
 * literal escaped character (`\i` → `i`). Returns `\uFFFD` for invalid code
 * points, matching the CSS tokenizer.
 */
function decodeCssEscape(css: string, index: number): { char: string; next: number } {
  let cursor = index + 1;
  if (cursor >= css.length) return { char: '\uFFFD', next: cursor };
  let hex = '';
  while (cursor < css.length && hex.length < 6 && /[0-9a-fA-F]/.test(css[cursor] ?? '')) {
    hex += css[cursor];
    cursor += 1;
  }
  if (hex) {
    if (isWhitespace(css[cursor] ?? '')) cursor += 1;
    const code = Number.parseInt(hex, 16);
    const invalid = code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff);
    return { char: invalid ? '\uFFFD' : String.fromCodePoint(code), next: cursor };
  }
  return { char: css[cursor] ?? '\uFFFD', next: cursor + 1 };
}

/**
 * Reads the at-rule keyword with CSS escapes decoded, so `@\69mport` /
 * `@\69 mport` / `@\000069mport` are all recognized as `@import` (QA P2-1).
 * Comparing the raw slice missed every escaped form.
 */
export function atRuleName(statement: string): string {
  if (statement[0] !== '@') return '';
  let cursor = 1;
  let name = '';
  while (cursor < statement.length) {
    const char = statement[cursor] ?? '';
    if (char === '\\') {
      const decoded = decodeCssEscape(statement, cursor);
      name += decoded.char;
      cursor = decoded.next;
      continue;
    }
    // Ident code points: ASCII word chars, hyphen, and non-ASCII.
    if (/[\w-]/.test(char) || (char.codePointAt(0) ?? 0) >= 0x80) {
      name += char;
      cursor += 1;
      continue;
    }
    break;
  }
  return name.toLowerCase();
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

/** Advances past a comment starting at `index` (`/*`), returns the end index. */
function skipComment(css: string, index: number): number {
  const end = css.indexOf('*/', index + 2);
  return end < 0 ? css.length : end + 2;
}

function skipString(css: string, index: number): number {
  const quote = css[index];
  let cursor = index + 1;
  while (cursor < css.length) {
    if (css[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (css[cursor] === quote) return cursor + 1;
    cursor += 1;
  }
  return css.length;
}

/**
 * Finds the first top-level `{` or `;` (outside strings, comments, parens and
 * attribute selectors). Returns `css.length` when none is found.
 */
function findRuleBoundary(css: string, start: number): { index: number; char: '' | '{' | ';' } {
  let cursor = start;
  let parens = 0;
  let brackets = 0;
  while (cursor < css.length) {
    const char = css[cursor] ?? '';
    if (char === '/' && css[cursor + 1] === '*') {
      cursor = skipComment(css, cursor);
      continue;
    }
    if (char === '"' || char === "'") {
      cursor = skipString(css, cursor);
      continue;
    }
    if (char === '(') parens += 1;
    else if (char === ')') parens = Math.max(0, parens - 1);
    else if (char === '[') brackets += 1;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
    else if (parens === 0 && brackets === 0 && (char === '{' || char === ';')) {
      return { index: cursor, char };
    }
    cursor += 1;
  }
  return { index: css.length, char: '' };
}

/** Index of the `}` matching the `{` at `openIndex` (or `css.length`). */
function matchBrace(css: string, openIndex: number): number {
  let depth = 0;
  let cursor = openIndex;
  while (cursor < css.length) {
    const char = css[cursor] ?? '';
    if (char === '/' && css[cursor + 1] === '*') {
      cursor = skipComment(css, cursor);
      continue;
    }
    if (char === '"' || char === "'") {
      cursor = skipString(css, cursor);
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return cursor;
    }
    cursor += 1;
  }
  return css.length;
}

/** Splits a selector list on top-level commas. */
export function splitSelectors(selector: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let cursor = 0;
  let parens = 0;
  let brackets = 0;
  while (cursor < selector.length) {
    const char = selector[cursor] ?? '';
    if (char === '/' && selector[cursor + 1] === '*') {
      cursor = skipComment(selector, cursor);
      continue;
    }
    if (char === '"' || char === "'") {
      cursor = skipString(selector, cursor);
      continue;
    }
    if (char === '(') parens += 1;
    else if (char === ')') parens = Math.max(0, parens - 1);
    else if (char === '[') brackets += 1;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
    else if (parens === 0 && brackets === 0 && char === ',') {
      parts.push(selector.slice(start, cursor));
      start = cursor + 1;
    }
    cursor += 1;
  }
  parts.push(selector.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function scopeSelector(selector: string, scope: string): string {
  const trimmed = selector.trim();
  if (!trimmed) return '';
  if (trimmed === ':root' || trimmed === 'html' || trimmed === 'body' || trimmed === ':host') return scope;
  if (trimmed.startsWith(':root')) return `${scope}${trimmed.slice(':root'.length)}`;
  if (trimmed.startsWith(':host')) return `${scope}${trimmed.slice(':host'.length)}`;
  // Accept the widget's documented root selectors as well.
  if (trimmed === '.agil-root' || trimmed === '[data-agil-root]') return scope;
  if (trimmed.startsWith('.agil-root')) return `${scope}${trimmed.slice('.agil-root'.length)}`;
  if (trimmed.startsWith('[data-agil-root]')) return `${scope}${trimmed.slice('[data-agil-root]'.length)}`;
  // `html.dark` / `body[data-x]` → root.dark / root[data-x]
  if (/^html(?=[.:#[\s>+~]|$)/.test(trimmed)) return `${scope}${trimmed.slice(4)}`;
  if (/^body(?=[.:#[\s>+~]|$)/.test(trimmed)) return `${scope}${trimmed.slice(4)}`;
  if (trimmed.includes('&')) return trimmed.replace(/&/g, scope);
  return `${scope} ${trimmed}`;
}

function scopeSelectorList(selectorText: string, scope: string): string {
  return splitSelectors(selectorText)
    .map((selector) => scopeSelector(selector, scope))
    .filter(Boolean)
    .join(', ');
}

function scopeRules(css: string, scope: string, depth = 0): string {
  let output = '';
  let cursor = 0;
  while (cursor < css.length) {
    // Preserve leading whitespace/comments verbatim.
    while (cursor < css.length && isWhitespace(css[cursor] ?? '')) cursor += 1;
    if (cursor >= css.length) break;
    if (css[cursor] === '/' && css[cursor + 1] === '*') {
      const end = skipComment(css, cursor);
      output += css.slice(cursor, end);
      cursor = end;
      continue;
    }

    if (css[cursor] === '@') {
      const boundary = findRuleBoundary(css, cursor);
      if (boundary.char === ';' || boundary.char === '') {
        const statement = css.slice(cursor, boundary.index + (boundary.char === ';' ? 1 : 0));
        cursor = boundary.index + (boundary.char === ';' ? 1 : 0);
        const name = atRuleName(statement);
        // Never let host CSS import a page-wide stylesheet or change charset.
        // Escaped at-keywords are decoded first, so `@\69mport` is dropped too.
        if (name === 'import' || name === 'charset' || name === 'namespace') continue;
        output += statement;
        continue;
      }

      const openIndex = boundary.index;
      const prelude = css.slice(cursor, openIndex).trim();
      const closeIndex = matchBrace(css, openIndex);
      const body = css.slice(openIndex + 1, closeIndex);
      cursor = closeIndex + 1;
      const name = atRuleName(prelude);
      if (name === 'keyframes' || name === '-webkit-keyframes' || name === 'font-face' || name === 'page' || name === 'property' || name === 'counter-style' || name === 'font-feature-values') {
        // Global by design (documented): names must not collide with host CSS.
        output += `${prelude} {${body}}`;
        continue;
      }
      output += `${prelude} {${scopeRules(body, scope, depth + 1)}}`;
      continue;
    }

    const boundary = findRuleBoundary(css, cursor);
    if (boundary.char !== '{') {
      // Stray declaration / malformed CSS: keep it inert and move on.
      cursor = boundary.index + (boundary.char === ';' ? 1 : 0);
      continue;
    }
    const openIndex = boundary.index;
    const selectorText = css.slice(cursor, openIndex).trim();
    const closeIndex = matchBrace(css, openIndex);
    const body = css.slice(openIndex + 1, closeIndex);
    cursor = closeIndex + 1;
    if (!selectorText) continue;
    output += `${scopeSelectorList(selectorText, scope)} {${body}}`;
  }
  return output;
}

/** Scopes every selector in `css` under `scope`. Pure and DOM-free. */
export function scopeCss(css: string, scope: string): string {
  if (typeof css !== 'string' || !css.trim() || !scope) return '';
  return scopeRules(css, scope);
}

/**
 * Scope ids include per-page entropy, not just a module counter: two copies of
 * the widget bundle on one page would otherwise both start at `w1` and their
 * scoped rules would leak into each other (QA P3-9). The sequence keeps ids
 * readable; the random suffix makes cross-bundle collisions negligible.
 */
function nextScopeId(): string {
  const sequence = (instanceSeq += 1).toString(36);
  let entropy = '';
  try {
    const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
    if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
      const bytes = new Uint8Array(4);
      cryptoApi.getRandomValues(bytes);
      entropy = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    /* fall back to Math.random below */
  }
  if (!entropy) entropy = Math.random().toString(36).slice(2, 10);
  return `w${sequence}-${entropy}`;
}

/**
 * Injects scoped `customCss` for one widget root. Returns a cleanup function.
 */
export function applyCustomCss(root: HTMLElement, customCss: string | undefined): () => void {
  if (typeof document === 'undefined' || typeof customCss !== 'string' || !customCss.trim()) {
    return () => undefined;
  }
  const id = nextScopeId();
  const scope = `[data-agil-widget="${id}"]`;
  root.setAttribute('data-agil-widget', id);
  const style = document.createElement('style');
  style.setAttribute('data-agil-custom-css', '');
  style.textContent = scopeCss(customCss, scope);
  const head = document.head ?? document.body;
  head.appendChild(style);
  return () => {
    if (style.parentNode) style.parentNode.removeChild(style);
    else style.remove();
    if (root.getAttribute('data-agil-widget') === id) root.removeAttribute('data-agil-widget');
  };
}
