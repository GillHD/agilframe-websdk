import { parseWikiMarkdown } from '@agil/protocol';
import type { CallState } from '@agil/calls-widget';

interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: true; untrustedContentHint?: true };
  execute: (input: unknown, context?: { signal?: AbortSignal }) => unknown;
}

interface ModelContext {
  registerTool(tool: WebMcpTool, options: { signal: AbortSignal }): void | Promise<void>;
}

const wiki = [
  { markdown: '/docs/wiki-handbook.md', page: '/wiki/' },
  { markdown: '/docs/wiki-setup.md', page: '/wiki/setup.html' },
  { markdown: '/docs/wiki-b2b.md', page: '/wiki/b2b.html' },
] as const;
const unavailable = { error: 'call_inactive' };
const readonly = { readOnlyHint: true } as const;

async function searchWiki(terms: string[], signal: AbortSignal) {
  const pages = await Promise.allSettled(wiki.map(async ({ markdown, page }) => {
    const response = await fetch(markdown, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/markdown')) throw new Error('Wiki unavailable');
    const text = await response.text();
    if (text.length > 256_000) throw new Error('Wiki page too large');
    const publication = parseWikiMarkdown(text);
    if (publication.invalidAnchor) throw new Error('Wiki anchors invalid');
    return [{ id: '', markdown: publication.introduction }, ...publication.sections]
      .flatMap(({ id, markdown }) => {
        const title = /^#{1,2}\s+(.+)$/m.exec(markdown)?.[1]?.trim();
        const searchable = markdown.toLowerCase();
        return title && terms.every((term) => searchable.includes(term))
          ? [{ title: title.slice(0, 140), url: new URL(page + (id ? `#${id}` : ''), location.origin).href }]
          : [];
      });
  }));
  if (signal.aborted) return { error: 'search_cancelled' };
  if (pages.every(({ status }) => status === 'rejected')) return { error: 'wiki_unavailable' };
  return { results: pages.flatMap((result) => result.status === 'fulfilled' ? result.value : []).slice(0, 8) };
}

/** Opt-in adapter for a single, standalone, same-origin embed document. */
export function attachWebMcp(options: {
  serverUrl: string;
  room: string;
  readState: () => CallState | undefined;
}): (() => void) | undefined {
  if (!window.isSecureContext || window.top !== window) return;
  const modelContext = (document as Document & { modelContext?: ModelContext }).modelContext;
  if (typeof modelContext?.registerTool !== 'function') return;
  if (!URL.canParse(options.serverUrl, location.origin) ||
      new URL(options.serverUrl, location.origin).origin !== location.origin) return;

  const scope = new URL(location.href);
  let registration: AbortController | undefined;
  let pageActive = true;
  const currentCall = () => {
    const state = options.readState();
    const query = new URLSearchParams(location.search);
    const sameSiteScope = location.pathname === scope.pathname &&
      ['tenant', 'server'].every((key) => query.get(key) === scope.searchParams.get(key));
    return pageActive && sameSiteScope && query.get('webmcp') === '1' && query.get('room')?.trim() === options.room && state?.phase === 'joined' &&
      state.room?.id === options.room && state.self ? state : undefined;
  };
  const refresh = () => {
    if (!currentCall()) {
      registration?.abort();
      registration = undefined;
      return;
    }
    if (registration) return;
    const controller = new AbortController();
    registration = controller;
    const active = () => controller.signal.aborted ? undefined : currentCall();
    const tools: WebMcpTool[] = [
      {
        name: 'agil_call_status',
        description: 'Read the connection status and, when visible to this participant, the count in the current AgilFrame room.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: readonly,
        execute() {
          const state = active();
          if (!state) return unavailable;
          const visibleCount = state.config.features.participantList && (state.permissions?.includes('participantList') ?? true);
          return {
            connection: state.connection,
            ...(visibleCount ? { participantCount: state.participants.length + 1 } : {}),
          };
        },
      },
      {
        name: 'agil_search_public_wiki',
        description: 'Find matching sections of the public AgilFrame Wiki. Returns public titles and links.',
        inputSchema: { type: 'object', properties: {
          query: { type: 'string', minLength: 2, maxLength: 120, description: 'Words to find in the published Wiki.' },
        }, required: ['query'], additionalProperties: false },
        annotations: { ...readonly, untrustedContentHint: true },
        async execute(input, context) {
          if (!active()) return unavailable;
          const query = (input as { query?: unknown } | null)?.query;
          const trimmed = typeof query === 'string' ? query.trim() : '';
          if (trimmed.length < 2 || trimmed.length > 120) return { error: 'invalid_query' };
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(4000), ...(context?.signal ? [context.signal] : [])]);
          const results = await searchWiki(trimmed.toLowerCase().split(/\s+/), signal);
          return active() ? results : unavailable;
        },
      },
    ];
    void Promise.all(tools.map(async (tool) => modelContext.registerTool(tool, { signal: controller.signal })))
      .catch(() => controller.abort());
  };
  window.addEventListener('pagehide', () => {
    pageActive = false;
    refresh();
  });
  window.addEventListener('pageshow', () => {
    pageActive = true;
    refresh();
  });
  window.addEventListener('popstate', refresh);
  refresh();
  return refresh;
}
