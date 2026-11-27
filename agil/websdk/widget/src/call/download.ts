/**
 * Browser download helpers.
 *
 * Two separate paths on purpose:
 *
 *  - `triggerDownload()` for server/provider URLs (`http:`/`https:` only). A
 *    chat attachment or a signed recording link must never be able to smuggle
 *    a `javascript:`/`data:`/foreign `blob:` URL into an anchor.
 *  - `triggerBlobDownload()` for blobs the widget itself just created (local
 *    recording, transcript export). `safeHttpUrl()` deliberately rejects
 *    `blob:`, so the old code path silently did nothing while the UI claimed
 *    the file was downloaded (pilot P1). The blob is minted here, used for one
 *    click and revoked immediately after, so a provider URL can never take
 *    this path.
 */

/** Href used for relative-URL resolution in DOM-free tests. */
const FALLBACK_HREF = 'http://localhost/';

function resolveHref(href?: string): string {
  if (href) return href;
  if (typeof window !== 'undefined' && window.location?.href) return window.location.href;
  return FALLBACK_HREF;
}

/** True when `url` is a `blob:` URL whose inner origin equals the page origin. */
export function isSameOriginBlobUrl(url: string | null | undefined, href?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url, resolveHref(href));
    if (parsed.protocol !== 'blob:') return false;
    // `blob:` carries the origin of the document that created the object URL;
    // `blob:null/...` and `blob:https://elsewhere/...` are not ours.
    const origin = new URL(resolveHref(href)).origin;
    if (origin === 'null') return false;
    return parsed.origin === origin;
  } catch {
    return false;
  }
}

export interface BlobDownloadDeps {
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  document?: Pick<Document, 'createElement'> & { body?: Pick<HTMLElement, 'appendChild'> };
  href?: string;
}

/**
 * Downloads a locally created blob: mint `blob:` URL → click one anchor →
 * revoke. Returns `true` only when the anchor was actually clicked.
 *
 * `blob:` URLs are rejected unless they are same-origin with the page, so a
 * compromised/foreign object URL cannot be passed off as a local download.
 */
export function triggerBlobDownload(blob: Blob, filename: string, deps: BlobDownloadDeps = {}): boolean {
  const doc = deps.document ?? (typeof document !== 'undefined' ? document : undefined);
  if (!doc) return false;
  const create = deps.createObjectUrl ?? (typeof URL !== 'undefined' ? URL.createObjectURL.bind(URL) : null);
  const revoke = deps.revokeObjectUrl ?? (typeof URL !== 'undefined' ? URL.revokeObjectURL.bind(URL) : null);
  if (!create || !revoke) return false;

  let url: string;
  try {
    url = create(blob);
  } catch {
    return false;
  }
  try {
    if (!isSameOriginBlobUrl(url, deps.href)) return false;
    const anchor = doc.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener noreferrer';
    // No `target="_blank"`: a local blob download must stay in this document.
    doc.body?.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } finally {
    // Revoking after the synchronous click is the documented browser pattern:
    // the download has already been handed to the browser at this point.
    try {
      revoke(url);
    } catch {
      /* ignore */
    }
  }
}
