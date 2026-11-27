/** Shared section syntax for the public Wiki and its publication API. */
export function isWikiDocument(name: string): boolean {
  return name === 'wiki-handbook.md' || name === 'wiki-setup.md' || name === 'wiki-b2b.md';
}

export function decodeWikiAnchor(fragment: string): string | undefined {
  try {
    return decodeURIComponent(fragment.startsWith('#') ? fragment.slice(1) : fragment);
  } catch {
    return undefined;
  }
}

export function parseWikiMarkdown(source: string): {
  introduction: string;
  sections: Array<{ id: string; markdown: string }>;
  invalidAnchor?: string;
  malformedAnchorLine?: number;
  missingAnchor?: { id: string; line: number };
} {
  // IDs owned by the Wiki shell or retained as aliases for bundled headings.
  const anchors = new Set(['main', 'wiki-tools', 'wiki-sections', 'architecture-title', 'external-title']);
  const introduction: string[] = [];
  const sections: Array<{ id: string; markdown: string[] }> = [];
  const references: Array<{ id: string; line: number }> = [];
  let current = introduction;
  let fenced = false;
  let malformedAnchorLine: number | undefined;
  for (const [index, raw] of source.split(/\r\n?|\n/).entries()) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      fenced = !fenced;
    } else if (!fenced) {
      const prose = raw.replace(/`[^`]+`/g, ' ');
      for (const link of prose.matchAll(/(?<!!)\[[^\]]+\]\(#([a-z0-9_%.-]+)\)/gi)) {
        const rawAnchor = link[1]!;
        references.push({ id: decodeWikiAnchor(rawAnchor) ?? rawAnchor, line: index + 1 });
      }
      const marker = /^(#{2,4})\s+\[([a-z][a-z0-9-]*)\]\s+(.+)$/.exec(line);
      if (marker) {
        const [, level, id, title] = marker;
        if (anchors.has(id!)) return { introduction: '', sections: [], invalidAnchor: id!, malformedAnchorLine };
        anchors.add(id!);
        if (level === '##') {
          current = [`## ${title}`];
          sections.push({ id: id!, markdown: current });
          continue;
        }
      } else if (malformedAnchorLine === undefined && /^#{2,4}\s+\[[^\]]*\](?:\s|$)/.test(line)) {
        malformedAnchorLine = index + 1;
      }
    }
    current.push(raw);
  }
  const missingAnchor = references.find(({ id }) => !anchors.has(id));
  return {
    introduction: introduction.join('\n'),
    sections: sections.map(({ id, markdown }) => ({ id, markdown: markdown.join('\n') })),
    ...(malformedAnchorLine === undefined ? {} : { malformedAnchorLine }),
    ...(missingAnchor ? { missingAnchor } : {}),
  };
}
