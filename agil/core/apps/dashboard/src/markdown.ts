import { h } from './dom.js';
import { docsRoute } from './links.js';

const DOC_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*\.(md|txt)$/i;
const WIKI_IMAGE_PATH = /^\/wiki\/screens\/[a-z0-9][a-z0-9._-]*\.(png|jpe?g|webp|avif)$/i;

interface MarkdownOptions {
  wikiImages?: boolean;
  publicDocLinks?: boolean;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeHref(raw: string, publicDocLinks: boolean): { href: string; external: boolean } | null {
  const value = raw.trim();
  if (/^https?:\/\//i.test(value)) return { href: value, external: true };
  if (value.startsWith('#') || value.startsWith('/')) return { href: value, external: false };
  const fileName = publicDocLinks ? value.replace(/^\.\//, '') : value;
  if (DOC_NAME_PATTERN.test(fileName)) {
    return { href: publicDocLinks ? `/docs/${encodeURIComponent(fileName)}` : docsRoute(fileName), external: false };
  }
  if (value.startsWith('mailto:')) return { href: value, external: false };
  return null;
}

function inlineMarkdown(text: string, { wikiImages = false, publicDocLinks = false }: MarkdownOptions): string {
  const tokens: string[] = [];
  const keep = (html: string): string => {
    tokens.push(html);
    return `\u0000${tokens.length - 1}\u0000`;
  };
  let value = text;
  value = value.replace(/`([^`]+)`/g, (_match, code: string) => keep(`<code>${escapeHtml(code)}</code>`));
  value = value.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt: string, url: string) => {
    if (wikiImages && WIKI_IMAGE_PATH.test(url)) {
      return keep(`<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`);
    }
    const safe = safeHref(url, publicDocLinks);
    return safe ? keep(`<a href="${escapeHtml(safe.href)}"${safe.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escapeHtml(alt || url)}</a>`) : escapeHtml(alt);
  });
  value = value.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) => {
    const safe = safeHref(url, publicDocLinks);
    if (!safe) return escapeHtml(label);
    return keep(
      `<a href="${escapeHtml(safe.href)}"${safe.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escapeHtml(label)}</a>`,
    );
  });
  value = escapeHtml(value);
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  value = value.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  value = value.replace(/(?:^|\s)(https?:\/\/[^\s<]+)/g, (match, url: string) => {
    const prefix = match.startsWith(' ') ? ' ' : '';
    return `${prefix}<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
  });
  // Typography: inline code must not leave a gap before , . ) ; — the padding of
  // <code> plus a line join used to read as a real space.
  value = value.replace(/(\u0000\d+\u0000)\s+([),.;:!?])/g, '$1$2');
  value = value.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => tokens[Number(index)] ?? '');
  return value;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
  const row = line.trim();
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < row.length; index++) {
    const character = row[index]!;
    const next = row[index + 1];
    if (character === '\\' && (next === '|' || next === '\\')) {
      cell += next === '|' ? '|' : '\\\\';
      index++;
    } else if (character === '|') {
      if (index > 0) cells.push(cell.trim());
      if (index === row.length - 1) return cells;
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/** Safe markdown → DOM. No raw HTML from the document is executed. */
export function renderMarkdown(markdown: string, options: MarkdownOptions = {}): HTMLElement {
  const root = h('div', { class: 'docs-markdown' });
  const inline = (text: string): string => inlineMarkdown(text, options);
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith('```')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      html += `<pre class="docs-code"${language ? ` data-lang="${escapeHtml(language)}"` : ''}><code>${escapeHtml(code.join('\n'))}</code></pre>`;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      html += `<h${level}>${inline(heading[2] ?? '')}</h${level}>`;
      index += 1;
      continue;
    }
    if (/^([-*_])\1\1+\s*$/.test(trimmed)) {
      html += '<hr />';
      index += 1;
      continue;
    }
    if (trimmed.startsWith('>')) {
      const quote: string[] = [];
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('>')) {
        quote.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
        index += 1;
      }
      html += `<blockquote>${quote.map((item) => `<p>${inline(item)}</p>`).join('')}</blockquote>`;
      continue;
    }
    if (trimmed.includes('|') && isTableSeparator(lines[index + 1] ?? '')) {
      const header = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? '').trim().includes('|') && (lines[index] ?? '').trim() !== '') {
        rows.push(splitTableRow(lines[index] ?? ''));
        index += 1;
      }
      html += '<div class="docs-table-wrap"><table><thead><tr>';
      html += header.map((cell) => `<th scope="col">${inline(cell)}</th>`).join('');
      html += '</tr></thead><tbody>';
      for (const row of rows) {
        html += `<tr>${header.map((_cell, cellIndex) => `<td>${inline(row[cellIndex] ?? '')}</td>`).join('')}</tr>`;
      }
      html += '</tbody></table></div>';
      continue;
    }
    const listMatch = /^(\s*)([-*+]|\d+\.)\s+(.+)$/.exec(line);
    if (listMatch) {
      const ordered = /^\d+\.$/.test(listMatch[2] ?? '');
      const start = ordered ? Number.parseInt(listMatch[2]!, 10) : 1;
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const match = /^(\s*)([-*+]|\d+\.)\s+(.+)$/.exec(current);
        if (!match) break;
        items.push(`<li>${inline(match[3] ?? '')}</li>`);
        index += 1;
      }
      const startAttribute = Number.isSafeInteger(start) && start !== 1 ? ` start="${start}"` : '';
      html += ordered ? `<ol${startAttribute}>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`;
      continue;
    }
    if (trimmed === '') {
      index += 1;
      continue;
    }
    const paragraph: string[] = [trimmed];
    index += 1;
    while (index < lines.length) {
      const next = (lines[index] ?? '').trim();
      if (next === '' || next.startsWith('#') || next.startsWith('```') || next.startsWith('>') || /^([-*_])\1\1+\s*$/.test(next)) break;
      if (/^(\s*)([-*+]|\d+\.)\s+/.test(lines[index] ?? '')) break;
      if (next.includes('|') && isTableSeparator(lines[index + 1] ?? '')) break;
      paragraph.push(next);
      index += 1;
    }
    html += `<p>${inline(paragraph.join(' '))}</p>`;
  }
  root.innerHTML = html;
  return root;
}

/** Render the Wiki's explicit heading markers as anchors. */
export function renderWikiMarkdown(
  source: string,
  defaultTableLabel = 'Таблица',
  { publicDocLinks = false }: Pick<MarkdownOptions, 'publicDocLinks'> = {},
): HTMLElement {
  const rendered = renderMarkdown(source, { wikiImages: true, publicDocLinks });
  for (const heading of rendered.querySelectorAll('h2, h3, h4')) {
    const leading = heading.firstChild;
    if (leading?.nodeType !== Node.TEXT_NODE) continue;
    const marker = /^\[([a-z][a-z0-9-]*)\]\s+/.exec(leading.textContent ?? '');
    if (!marker) continue;
    heading.id = marker[1]!;
    leading.textContent = leading.textContent!.slice(marker[0].length);
  }
  let tableLabel = defaultTableLabel;
  for (const element of rendered.querySelectorAll('h2, h3, h4, .docs-table-wrap')) {
    if (!element.classList.contains('docs-table-wrap')) {
      tableLabel = element.textContent?.trim() || defaultTableLabel;
      continue;
    }
    element.classList.add('table-scroll');
    element.setAttribute('role', 'region');
    element.setAttribute('tabindex', '0');
    element.setAttribute('aria-label', tableLabel);
  }
  return rendered;
}
