const toggle = document.querySelector('.wiki-menu-toggle');
const mobile = matchMedia('(max-width: 45em)');
const root = document.documentElement;
const menus = '#wiki-tools, #wiki-sections';

function setExpanded(expanded) {
  toggle.setAttribute('aria-expanded', String(expanded));
  root.dataset.wikiNavigation = expanded ? 'open' : 'closed';
}

function focusFragment(fragment) {
  if (!fragment.startsWith('#')) return;
  let id;
  try {
    id = decodeURIComponent(fragment.slice(1));
  } catch {
    return;
  }
  const target = document.getElementById(id);
  if (!target || target === document.activeElement) return;
  if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
  target.focus({ preventScroll: true });
}

if (toggle instanceof HTMLButtonElement) {
  setExpanded(false);
  root.toggleAttribute('data-wiki-compact', mobile.matches);
  toggle.hidden = false;

  toggle.addEventListener('click', () => setExpanded(toggle.getAttribute('aria-expanded') === 'false'));
  mobile.addEventListener('change', () => {
    const active = document.activeElement;
    const menuHadFocus = active?.closest(menus);
    root.toggleAttribute('data-wiki-compact', mobile.matches);
    setExpanded(false);
    if (mobile.matches && menuHadFocus) toggle.focus();
    if (!mobile.matches && active === toggle) document.querySelector('#wiki-tools a')?.focus();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !mobile.matches || root.dataset.wikiNavigation !== 'open') return;
    event.preventDefault();
    setExpanded(false);
    toggle.focus();
  });

  window.addEventListener('hashchange', () => focusFragment(location.hash));

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
    if (mobile.matches && link.closest(menus)) setExpanded(false);

    const fragment = link.getAttribute('href');
    if (!fragment?.startsWith('#')) return;
    requestAnimationFrame(() => focusFragment(fragment));
  });
}
