/**
 * Public URLs of sibling apps (demo, editor, API explorer).
 *
 * Deployed: everything is served by the AgilFrame server (dashboard at
 * /dashboard/, editor at /editor/, demo at /). In Vite dev the apps run on
 * their own ports (demo 5173, editor 5174), so links are derived from the
 * dashboard port; `VITE_*` env vars can override both.
 */
import { normalizeBaseUrl } from './api.js';

export interface PublicLinks {
  demo: string;
  editor: string;
  sdk: string;
  apiDocs: string;
  openapi: string;
  securityAudit: string;
  extensibility: string;
  messenger: string;
  scaling: string;
  backlog: string;
  apiGuide: string;
  apiMd: string;
  contract: string;
  mcpDocs: string;
}

function envUrl(name: 'VITE_DEMO_URL' | 'VITE_EDITOR_URL'): string | undefined {
  const value = import.meta.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function publicLinks(serverUrl: string): PublicLinks {
  const base = normalizeBaseUrl(serverUrl);
  let origin = base;
  let host = 'localhost';
  let protocol = 'http:';
  try {
    const url = new URL(base);
    origin = url.origin;
    host = url.hostname;
    protocol = url.protocol;
  } catch {
    /* keep defaults */
  }

  const isDevDashboard = typeof window !== 'undefined' && window.location.port === '5175';
  const demoOrigin = isDevDashboard ? `${protocol}//${host}:5173` : origin;
  const demo = envUrl('VITE_DEMO_URL') ?? `${demoOrigin}/`;
  const editor =
    envUrl('VITE_EDITOR_URL') ?? (isDevDashboard ? `${protocol}//${host}:5174/editor/` : `${origin}/editor/`);

  return {
    demo,
    editor,
    sdk: `${base}/sdk/agilframe.js`,
    apiDocs: `${origin}/docs`,
    openapi: `${origin}/openapi.json`,
    // Repository-relative path: works from /dashboard/ when the server serves
    // AGIL_DOCS_DIR, and never points at a hardcoded hosted URL.
    securityAudit: '../docs/security-audit.md',
    extensibility: '../docs/extensibility.md',
    messenger: '../docs/messenger.md',
    scaling: '../docs/scaling.md',
    backlog: '../docs/backlog.md',
    apiGuide: '../docs/api-guide.md',
    apiMd: '../docs/api.md',
    contract: '../docs/contract.md',
    mcpDocs: `${origin}/docs`,
  };
}

/** Dashboard documentation viewer route; `name` selects the file. */
export function docsRoute(name?: string, tab?: 'edit' | 'history'): string {
  if (!name) return '#/docs';
  const query = new URLSearchParams({ name });
  if (tab) query.set('tab', tab);
  return `#/docs?${query}`;
}

/** Built-in markdown files used when the admin docs API is unavailable. */
export const BUNDLED_DOCS: ReadonlyArray<{ name: string; title: string }> = [
  { name: 'api-guide.md', title: 'Руководство интегратора' },
  { name: 'api.md', title: 'Справочник API' },
  { name: 'security-audit.md', title: 'Аудит безопасности и приватности' },
  { name: 'extensibility.md', title: 'Расширяемость и внешние сервисы' },
  { name: 'messenger.md', title: 'Интеграция с мессенджером' },
  { name: 'p2p.md', title: 'P2P-звонки один на один' },
  { name: 'scaling.md', title: 'Масштабирование и несколько серверов' },
  { name: 'contract.md', title: 'Контракт монорепо' },
  { name: 'backlog.md', title: 'Планы и задачи' },
  { name: 'saas.md', title: 'Организации и платформенный ключ' },
];

/** Public raw markdown URL (used inside the docs screen for download/open). */
export function docsRawUrl(serverUrl: string, name: string): string {
  const base = normalizeBaseUrl(serverUrl);
  return `${base}/docs/${encodeURIComponent(name)}`;
}

/** Builds a demo join URL for a room token (used by "Открыть демо"). */
export function demoJoinUrl(serverUrl: string, roomId: string, token?: string, tenantId?: string): string {
  const links = publicLinks(serverUrl);
  try {
    const url = envUrl('VITE_DEMO_URL') ? new URL(links.demo) : new URL('./embed.html', links.demo);
    url.searchParams.set('server', normalizeBaseUrl(serverUrl));
    url.searchParams.set('room', roomId);
    if (token) url.searchParams.set('token', token);
    if (tenantId) url.searchParams.set('tenant', tenantId);
    return url.toString();
  } catch {
    return links.demo;
  }
}
