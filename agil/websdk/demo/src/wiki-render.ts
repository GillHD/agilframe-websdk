import { decodeWikiAnchor, parseWikiMarkdown } from '@agil/protocol';
import { renderWikiMarkdown } from '../../../core/apps/dashboard/src/markdown.js';

function renderPublicWikiMarkdown(source: string): HTMLElement {
  return renderWikiMarkdown(source, undefined, { publicDocLinks: true });
}

function applyPublishedWiki(main: HTMLElement, source: string): void {
  const publication = parseWikiMarkdown(source);
  if (publication.invalidAnchor) return;
  const introduction = renderPublicWikiMarkdown(publication.introduction);
  const introCard = main.querySelector<HTMLElement>(':scope > .page-intro');
  if (!introduction.querySelector(':scope > h1')) {
    const fallbackTitle = introCard?.querySelector(':scope > h1') ?? main.querySelector(':scope > h1');
    if (fallbackTitle) introduction.prepend(fallbackTitle);
  }
  const title = introduction.querySelector(':scope > h1');
  const next = title?.nextElementSibling;
  const lead = next?.tagName === 'P' ? next : null;
  lead?.classList.add('lead');
  if (introCard && title) {
    title.before(introCard);
    introCard.replaceChildren(title, ...(lead ? [lead] : []));
  }
  const existing = new Map(Array.from(main.querySelectorAll<HTMLElement>(':scope > section[id]'), (section) => [section.id, section]));
  const navigationMenu = document.getElementById('wiki-sections');
  const focused = document.activeElement;
  const focusedLink = focused instanceof HTMLAnchorElement && navigationMenu?.contains(focused) ? focused.hash : '';
  const focusedContent = focused instanceof HTMLElement && main.contains(focused) ? focused : null;
  const focusedSection = focusedContent?.closest('section[id]')?.id;
  let matchingLink: HTMLAnchorElement | undefined;
  navigationMenu?.querySelectorAll(':scope > a[href^="#"]').forEach((link) => link.remove());
  const addLink = (id: string, label: string | null): void => {
    const link = document.createElement('a');
    link.href = `#${id}`;
    link.textContent = label;
    if (link.hash === focusedLink) matchingLink = link;
    navigationMenu?.append(link);
  };
  const sections: HTMLElement[] = [];
  for (const heading of introduction.querySelectorAll<HTMLElement>('h3[id], h4[id]')) addLink(heading.id, heading.textContent);
  for (const { id, markdown } of publication.sections) {
    const original = existing.get(id);
    const section = original ?? document.createElement('section');
    section.id = id;
    const rendered = renderPublicWikiMarkdown(markdown);
    const heading = rendered.querySelector('h2');
    const previousHeading = section.querySelector(':scope > h2');
    if (heading && previousHeading?.id) heading.id = previousHeading.id;
    if (heading) addLink(id, heading.textContent);
    for (const subheading of rendered.querySelectorAll<HTMLElement>('h3[id], h4[id]')) addLink(subheading.id, subheading.textContent);
    const publishedImages = new Set(Array.from(rendered.querySelectorAll<HTMLImageElement>('img'), (image) => image.src));
    const illustrations = Array.from(section.querySelectorAll(':scope > figure, :scope > .media-credit')).filter((illustration) => {
      const images = Array.from(illustration.querySelectorAll<HTMLImageElement>('img'));
      return images.length === 0 || images.some((image) => !publishedImages.has(image.src));
    });
    section.replaceChildren(...rendered.children, ...illustrations);
    sections.push(section);
  }
  main.replaceChildren(...introduction.children, ...sections);
  if (focusedLink) {
    const nextLink = matchingLink ?? navigationMenu?.querySelector<HTMLAnchorElement>('a[href^="#"]') ??
      navigationMenu?.querySelector<HTMLAnchorElement>('a[href]');
    (nextLink ?? main).focus({ preventScroll: true });
    if (nextLink && navigationMenu && navigationMenu.scrollHeight > navigationMenu.clientHeight) {
      // Reveal the focused link within the sidebar without moving the article.
      const outlineInset = 6;
      const menuTop = navigationMenu.getBoundingClientRect().top + navigationMenu.clientTop + outlineInset;
      const menuBottom = menuTop + navigationMenu.clientHeight - 2 * outlineInset;
      const link = nextLink.getBoundingClientRect();
      navigationMenu.scrollTop += link.top < menuTop ? link.top - menuTop : Math.max(0, link.bottom - menuBottom);
    }
  } else if (focusedContent && document.activeElement !== focusedContent) {
    const section = (focusedSection && document.getElementById(focusedSection)) || main;
    const sameElement = focusedContent.id ? document.getElementById(focusedContent.id) : null;
    const sameLink = focusedContent instanceof HTMLAnchorElement
      ? Array.from(section.querySelectorAll<HTMLAnchorElement>('a[href]')).find((link) => link.href === focusedContent.href)
      : undefined;
    const nextFocus = sameElement ?? sameLink ?? section;
    if (!nextFocus.hasAttribute('tabindex') && nextFocus.tabIndex < 0) nextFocus.tabIndex = -1;
    nextFocus.focus({ preventScroll: true });
  }
}

async function loadPublishedWiki(): Promise<void> {
  const page = location.pathname.split('/').pop();
  const name = page === 'b2b.html' ? 'wiki-b2b.md' : page === 'setup.html' ? 'wiki-setup.md' : 'wiki-handbook.md';
  const main = document.querySelector<HTMLElement>('main');
  if (!main) return;
  let fragmentPosition = window.scrollY;
  const rememberFragmentPosition = (): void => {
    fragmentPosition = window.scrollY;
  };
  window.addEventListener('hashchange', rememberFragmentPosition);
  try {
    const response = await fetch(`/docs/${name}`, { cache: 'no-store', signal: AbortSignal.timeout(6500) });
    if (!response.ok || response.headers.get('x-agil-doc-source') !== 'published') return;
    const source = await response.text();
    const anchor = decodeWikiAnchor(location.hash) ?? '';
    const target = anchor ? document.getElementById(anchor) : null;
    const targetTop = target?.getBoundingClientRect().top;
    // A late publication must not take the reader back to an anchor they have scrolled past.
    const revealAnchor = anchor && (targetTop === undefined
      ? window.scrollY === fragmentPosition
      : targetTop >= 0 && targetTop < window.innerHeight);
    applyPublishedWiki(main, source);
    if (revealAnchor) document.getElementById(anchor)?.scrollIntoView();
  } catch {
    // The bundled Wiki stays readable when the documentation API is unavailable.
  } finally {
    window.removeEventListener('hashchange', rememberFragmentPosition);
  }
}

void loadPublishedWiki();
