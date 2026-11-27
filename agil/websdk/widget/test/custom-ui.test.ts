/**
 * Custom-UI contract tests.
 *
 * The widget controller is DOM-light in headless mode: a tiny fake DOM is
 * enough to mount it and exercise lifecycle/actions/streams without jsdom.
 * CSS scoping, icon URL validation and reaction normalization are pure.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, type Participant } from '@agil/protocol';
import { mountWidget, withoutEmptyRemoteStreams } from '../src/index.js';
import { ApiClient } from '../src/api.js';
import { WebRtcEngine } from '../src/call/webrtc-engine.js';
import { playWithTimeout } from '../src/call/recording.js';
import { CallStore, createInitialState } from '../src/state.js';
import { I18n } from '../src/i18n.js';
import { HeadlessUi } from '../src/ui/headless.js';
import { ParticipantsPanel } from '../src/ui/participants-panel.js';
import { VideoTile } from '../src/ui/video-tile.js';
import { resolveUiMode } from '../src/ui-mode.js';
import { scopeCss } from '../src/custom-css.js';
import { createIconImage, resolveIconOverrides, resolveIconUrl } from '../src/custom-icons.js';
import { MAX_REACTION_LENGTH, normalizeReaction } from '../src/reactions.js';

/* ------------------------------------------------------------------ */
/* Minimal DOM shim (headless rendering creates only the root element) */
/* ------------------------------------------------------------------ */

class FakeStyle {
  readonly props = new Map<string, string>();
  backgroundColor = '';
  color = '';
  fontFamily = '';
  width = '';
  height = '';
  borderRadius = '';
  setProperty(name: string, value: string): void {
    this.props.set(name, value);
  }
}

class FakeElement {
  readonly tagName: string;
  className = '';
  id = '';
  textContent = '';
  title = '';
  hidden = false;
  tabIndex = 0;
  width = 0;
  height = 0;
  src = '';
  alt = '';
  decoding = '';
  loading = '';
  referrerPolicy = '';
  readonly children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  parentElement: FakeElement | null = null;
  readonly dataset: Record<string, string> = {};
  readonly style = new FakeStyle();
  readonly attributes = new Map<string, string>();
  readonly classList = {
    add: (token: string): void => this.setClassToken(token, true),
    remove: (token: string): void => this.setClassToken(token, false),
    toggle: (token: string, force?: boolean): boolean => {
      const on = force ?? !this.hasClassToken(token);
      this.setClassToken(token, on);
      return on;
    },
    contains: (token: string): boolean => this.hasClassToken(token),
  };

  private tokens(): Set<string> {
    return new Set(this.className.split(/\s+/).filter(Boolean));
  }

  private hasClassToken(token: string): boolean {
    return this.tokens().has(token);
  }

  private setClassToken(token: string, on: boolean): void {
    const tokens = this.tokens();
    if (on) tokens.add(token);
    else tokens.delete(token);
    this.className = [...tokens].join(' ');
  }

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  appendChild<T extends FakeElement>(child: T): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  removeChild<T extends FakeElement>(child: T): T {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    child.parentElement = null;
    return child;
  }

  replaceChild<T extends FakeElement>(next: T, old: T): T {
    const index = this.children.indexOf(old);
    if (index >= 0) this.children[index] = next;
    next.parentNode = this;
    next.parentElement = this;
    old.parentNode = null;
    old.parentElement = null;
    return old;
  }

  replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) {
      child.parentNode = null;
      child.parentElement = null;
    }
    this.children.length = 0;
    for (const child of children) this.appendChild(child);
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
    if (name === 'data-agil-icon') this.dataset.agilIcon = String(value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(): void {
    /* no-op */
  }

  removeEventListener(): void {
    /* no-op */
  }

  querySelector(): null {
    return null;
  }

  querySelectorAll(): FakeElement[] {
    return [];
  }

  replaceWith(): void {
    /* no-op */
  }

  closest(): null {
    return null;
  }

  focus(): void {
    /* no-op */
  }
}

interface FakeDocument {
  baseURI: string;
  head: FakeElement;
  body: FakeElement;
  documentElement: FakeElement;
  createElement: (tag: string) => FakeElement;
  createElementNS: (_ns: string, tag: string) => FakeElement;
  createTextNode: (text: string) => { textContent: string };
  addEventListener: (type: string, handler: (event: unknown) => void) => void;
  removeEventListener: (type: string, handler: (event: unknown) => void) => void;
  listeners: Map<string, Set<(event: unknown) => void>>;
  dispatch: (type: string, event: unknown) => void;
  getElementById: () => null;
  querySelector: () => null;
}

let fakeDocument: FakeDocument | null = null;
let previousGlobals: Record<string, PropertyDescriptor | undefined> = {};

function installDom(): void {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const doc: FakeDocument = {
    baseURI: 'http://localhost/',
    head: new FakeElement('head'),
    body: new FakeElement('body'),
    documentElement: new FakeElement('html'),
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener: (type, handler) => {
      const set = listeners.get(type) ?? new Set();
      set.add(handler);
      listeners.set(type, set);
    },
    removeEventListener: (type, handler) => {
      listeners.get(type)?.delete(handler);
    },
    listeners,
    dispatch: (type, event) => {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
    },
    getElementById: () => null,
    querySelector: () => null,
  };
  fakeDocument = doc;
  const globals: Record<string, unknown> = {
    document: doc,
    window: {
      location: { origin: 'http://localhost', href: 'http://localhost/' },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    MutationObserver: class {
      observe(): void {}
      disconnect(): void {}
    },
    MediaStream: class {
      readonly tracks: unknown[] = [];
      addTrack(track: unknown): void {
        this.tracks.push(track);
      }
      getTracks(): unknown[] {
        return this.tracks;
      }
      getAudioTracks(): unknown[] {
        return [];
      }
      getVideoTracks(): unknown[] {
        return [];
      }
    },
    fetch: async () =>
      new Response(JSON.stringify({ error: { code: 'internal_error', message: 'offline test' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
  };
  previousGlobals = {};
  for (const [name, value] of Object.entries(globals)) {
    previousGlobals[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
}

function uninstallDom(): void {
  for (const [name, descriptor] of Object.entries(previousGlobals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  previousGlobals = {};
  fakeDocument = null;
}

before(installDom);
after(uninstallDom);

/* ------------------------------------------------------------------ */
/* Pure customization helpers                                          */
/* ------------------------------------------------------------------ */

test('ui mode: explicit ui wins over the legacy headless alias', () => {
  assert.equal(resolveUiMode({}), 'default');
  assert.equal(resolveUiMode({ headless: true }), 'headless');
  assert.equal(resolveUiMode({ ui: 'headless' }), 'headless');
  assert.equal(resolveUiMode({ ui: 'default', headless: true }), 'default');
  assert.equal(resolveUiMode({ ui: 'headless', headless: false }), 'headless');
  assert.equal(resolveUiMode(null), 'default');
});

test('customCss: selectors are scoped to the widget root', () => {
  const scope = '[data-agil-widget="w1"]';
  const scoped = scopeCss('.my-button, .my-card { color: red }', scope);
  assert.equal(scoped, '[data-agil-widget="w1"] .my-button, [data-agil-widget="w1"] .my-card { color: red }');
  assert.equal(scopeCss(':root { --brand: red }', scope), '[data-agil-widget="w1"] { --brand: red }');
  assert.equal(scopeCss('html, body { margin: 0 }', scope), '[data-agil-widget="w1"], [data-agil-widget="w1"] { margin: 0 }');
  assert.equal(scopeCss('& > .x { color: blue }', scope), '[data-agil-widget="w1"] > .x { color: blue }');
  // Commas inside functional selectors are not selector separators.
  assert.equal(
    scopeCss(':is(.a, .b) .c { color: green }', scope),
    '[data-agil-widget="w1"] :is(.a, .b) .c { color: green }',
  );
});

test('customCss: at-rules are scoped, keyframes stay global, imports are dropped', () => {
  const scope = '[data-agil-widget="w1"]';
  const media = scopeCss('@media (max-width: 600px) { .x { display: none } }', scope);
  assert.equal(media, '@media (max-width: 600px) {[data-agil-widget="w1"] .x { display: none }}');
  const keyframes = scopeCss('@keyframes pulse { from { opacity: 0 } to { opacity: 1 } }', scope);
  assert.equal(keyframes, '@keyframes pulse { from { opacity: 0 } to { opacity: 1 } }');
  assert.equal(scopeCss('@import url("https://evil.example/x.css"); .x { color: red }', scope), '[data-agil-widget="w1"] .x { color: red }');
  assert.equal(scopeCss('', scope), '');
  assert.equal(scopeCss('@supports (display: grid) { .x { grid: 1 } }', scope), '@supports (display: grid) {[data-agil-widget="w1"] .x { grid: 1 }}');
});

test('customCss: escaped at-rules are decoded and dropped', () => {
  const scope = '[data-agil-widget="w1"]';
  const dropped = [
    '@\\69mport url("https://evil.example/x.css"); .x { color: red }',
    '@\\000069mport url("https://evil.example/x.css"); .x { color: red }',
    '@\\69 mport url("https://evil.example/x.css"); .x { color: red }',
    '@im\\70ort url("https://evil.example/x.css"); .x { color: red }',
    '@\\49MPORT url("https://evil.example/x.css"); .x { color: red }',
    '@\\63 harset "utf-8"; .x { color: red }',
    '@\\6e amespace svg url("https://evil.example/x.css"); .x { color: red }',
  ];
  for (const css of dropped) {
    assert.equal(scopeCss(css, scope), '[data-agil-widget="w1"] .x { color: red }', css);
  }
  // Escaped block at-rules are still scoped, not mistaken for an import.
  const escapedMedia = scopeCss('@\\6d edia (max-width: 600px) { .x { display: none } }', scope);
  assert.ok(escapedMedia.includes('[data-agil-widget="w1"] .x { display: none }'), escapedMedia);
  // Nested imports are dropped at any depth.
  assert.equal(
    scopeCss('@media (min-width: 1px) { @\\69mport url("https://evil.example/x.css"); .x { color: red } }', scope),
    '@media (min-width: 1px) {[data-agil-widget="w1"] .x { color: red }}',
  );
});

test('iconUrls: only known icon names and http(s) URLs are accepted', () => {
  const base = 'https://cdn.example.com/app/';
  assert.equal(resolveIconUrl('mic.svg', base), 'https://cdn.example.com/app/mic.svg');
  assert.equal(resolveIconUrl('https://cdn.example.com/mic.svg', base), 'https://cdn.example.com/mic.svg');
  assert.equal(resolveIconUrl('javascript:alert(1)', base), null);
  assert.equal(resolveIconUrl('data:image/svg+xml,<svg/>', base), null);
  assert.equal(resolveIconUrl('', base), null);

  const overrides = resolveIconOverrides(
    {
      mic: '/icons/mic.svg',
      camera: 'https://cdn.example.com/camera.png',
      close: 'javascript:alert(1)',
      notAnIcon: 'https://cdn.example.com/nope.svg',
      chat: 42 as unknown as string,
    },
    base,
  );
  assert.deepEqual([...overrides.keys()], ['mic', 'camera']);
  assert.equal(overrides.get('mic'), 'https://cdn.example.com/icons/mic.svg');
});

test('iconUrls: replacements are <img> elements with copied size and no HTML injection', () => {
  assert.ok(fakeDocument);
  const svg = new FakeElement('svg');
  svg.setAttribute('data-agil-icon', 'mic');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  const img = createIconImage(svg as unknown as Element, 'https://cdn.example.com/mic.svg');
  assert.equal(img.tagName, 'IMG');
  assert.equal(img.src, 'https://cdn.example.com/mic.svg');
  assert.equal(img.className, 'agil-icon agil-icon-custom');
  assert.equal(img.getAttribute('width'), '24');
  assert.equal(img.getAttribute('height'), '24');
  assert.equal(img.getAttribute('aria-hidden'), 'true');
  assert.equal(img.alt, '');
});

test('reactions: only short text without control characters is sent', () => {
  assert.equal(normalizeReaction(' 👍 '), '👍');
  assert.equal(normalizeReaction(''), null);
  assert.equal(normalizeReaction('x'.repeat(MAX_REACTION_LENGTH + 1)), null);
  assert.equal(normalizeReaction('bad\u0000reaction'), null);
  assert.equal(normalizeReaction(42), null);
});

/* ------------------------------------------------------------------ */
/* Continuity: reconnecting peer presence is rendered                  */
/* ------------------------------------------------------------------ */

function findElement(root: FakeElement, predicate: (element: FakeElement) => boolean): FakeElement | null {
  if (predicate(root)) return root;
  for (const child of root.children) {
    if (!Array.isArray((child as FakeElement).children)) continue;
    const found = findElement(child as FakeElement, predicate);
    if (found) return found;
  }
  return null;
}

test('presence: a reconnecting peer is visible in the participants panel and on the tile', () => {
  const i18n = new I18n('en');
  const peer: Participant = {
    id: 'peer-1',
    name: 'Alisa',
    role: 'guest',
    joinedAt: 1,
    state: { mic: 'on', cam: 'on', screen: false, handRaised: false, network: 'good' },
    verified: false,
    integrity: 'unknown',
    permissions: ['chat'],
    presence: 'reconnecting',
  };
  const state = createInitialState(defaultConfig({ tenantId: 'demo' }), 'en');
  state.self = { ...peer, id: 'self-1', name: 'Host', presence: 'online' };
  state.participants = [peer];

  const panel = new ParticipantsPanel(i18n, { onClose: () => undefined });
  panel.update(state);
  const row = findElement(panel.element, (element) => element.dataset.participantId === 'peer-1');
  assert.ok(row, 'peer row is rendered');
  assert.equal(row.dataset.presence, 'reconnecting');
  assert.ok(row.className.includes('is-reconnecting'));
  const badge = findElement(row, (element) => element.dataset.agilPresence === 'reconnecting');
  assert.ok(badge, 'presence badge is rendered in the participant row');
  assert.ok(badge.textContent.includes('Reconnecting'));
  panel.destroy();

  const tile = new VideoTile(
    {
      participant: peer,
      stream: null,
      isSelf: false,
      speaking: false,
      pinned: false,
      connection: 'connected',
      integrity: 'unknown',
      mirrored: false,
    },
    i18n,
    { onPin: () => undefined },
  );
  assert.equal(tile.element.dataset.presence, 'reconnecting', 'tile exposes the peer presence');
  assert.ok(tile.element.className.includes('is-reconnecting'));
  const tileBadge = findElement(tile.element, (element) => element.className.includes('agil-presence-badge'));
  assert.ok(tileBadge, 'presence badge is rendered on the tile');
  assert.equal(tileBadge.title, 'Reconnecting…');
  tile.destroy();
});

/* ------------------------------------------------------------------ */
/* Headless lifecycle / actions / streams                              */
/* ------------------------------------------------------------------ */

interface Mounted {
  container: FakeElement;
  instance: Awaited<ReturnType<typeof mountWidget>>;
  root: FakeElement;
  doc: FakeDocument;
}

async function mountHeadless(extra: Record<string, unknown> = {}): Promise<Mounted> {
  assert.ok(fakeDocument);
  const container = new FakeElement('div');
  const instance = await mountWidget(container as unknown as HTMLElement, {
    room: 'custom-ui',
    serverUrl: 'http://localhost:8787',
    participantName: 'Host',
    ui: 'headless',
    ...extra,
  });
  const root = container.children[0];
  assert.ok(root);
  return { container, instance, root, doc: fakeDocument };
}

test('headless: no built-in markup, root stays themed and empty, lifecycle is idle', async () => {
  const { container, instance, root } = await mountHeadless({ customCss: '.own-btn { color: red }' });
  assert.equal(container.children.length, 1);
  assert.ok(root.className.includes('agil-root'));
  assert.ok(root.className.includes('agil-headless'));
  assert.equal(root.dataset.agilHeadless, 'true');
  assert.equal(root.dataset.agilUi, 'headless');
  assert.equal(root.children.length, 0, 'no built-in UI subtree is rendered');
  assert.equal(instance.getState().phase, 'idle');
  assert.equal(instance.getLocalStream(), null);
  assert.deepEqual(instance.getRemoteStreams(), {});
  assert.equal(instance.getScreenStream(), null);
  assert.equal(instance.getSelf(), null);
  assert.deepEqual(instance.getParticipants(), []);
  assert.equal(root.getAttribute('data-agil-widget') !== null, true, 'customCss installs a scoped root id');

  const style = fakeDocument?.head.children.find((child) => child.getAttribute('data-agil-custom-css') !== null);
  assert.ok(style, 'customCss <style> was injected');
  assert.match(style.textContent, /\[data-agil-widget="w[^"]+"\] \.own-btn \{ color: red \}/);

  instance.destroy();
  assert.equal(container.children.length, 0);
  assert.equal(fakeDocument?.head.children.includes(style), false, 'customCss is removed on destroy');
});

test('headless: state/actions are DOM-free and emit documented events', async () => {
  const { instance } = await mountHeadless();
  const observed: Array<[string, unknown]> = [];
  for (const name of ['media-state', 'reaction', 'state', 'toast'] as const) {
    instance.on(name, (payload) => observed.push([name, payload]));
  }
  instance.subscribe((state) => observed.push(['subscribe', state.phase]));

  assert.equal(instance.raiseHand(true), true);
  assert.equal(instance.getState().settings.handRaised, true);
  assert.ok(observed.some(([name, payload]) => name === 'media-state' && (payload as { handRaised?: boolean }).handRaised === true));
  assert.ok(observed.some(([name]) => name === 'state'));
  assert.ok(observed.some(([name]) => name === 'subscribe'));

  assert.equal(instance.raiseHand(true), true);
  const mediaEvents = observed.filter(([name]) => name === 'media-state').length;
  assert.equal(mediaEvents, 1, 're-raising an already raised hand is idempotent');
  instance.lowerHand();
  assert.equal(instance.getState().settings.handRaised, false);

  assert.equal(instance.sendReaction('👋'), true);
  const reaction = observed.find(([name]) => name === 'reaction')?.[1] as { emoji?: string; self?: boolean } | undefined;
  assert.equal(reaction?.emoji, '👋');
  assert.equal(reaction?.self, true);
  assert.equal(instance.sendReaction('x'.repeat(MAX_REACTION_LENGTH + 1)), false);

  assert.equal(await instance.startRecording(), false, 'recording is disabled by default config');
  assert.ok(observed.some(([name]) => name === 'toast'), 'headless toasts are emitted as events');
  const stats = await instance.getStats();
  assert.equal(stats.phase, 'idle');
  assert.equal(stats.recording, false);

  instance.destroy();
});

test('headless: 200 simulated participants expose one paginated gallery and no DOM', async () => {
  const { instance, root } = await mountHeadless();
  instance.simulateParticipants(200);
  const state = instance.getState();
  assert.equal(state.phase, 'joined');
  assert.equal(state.participants.length, 199, '200 total includes self');
  assert.equal(state.self?.id, 'sim-self');
  assert.equal(state.gallery.total, 199);
  assert.equal(state.gallery.pageSize, 36);
  assert.equal(state.gallery.pageCount, 6);
  assert.equal(state.gallery.followSpeaker, true);
  assert.equal(root.children.length, 0, 'headless host owns all rendering: no 200-tile DOM');

  instance.setGalleryPage(5);
  assert.equal(instance.getState().gallery.page, 5);
  instance.setGalleryPage(99);
  assert.equal(instance.getState().gallery.page, 5, 'page is clamped');
  instance.setFollowSpeaker(false);
  assert.equal(instance.getState().gallery.followSpeaker, false);
  instance.setVideoQuality('low');
  assert.equal(instance.getState().settings.videoQuality, 'low');
  instance.clearSimulatedParticipants();
  assert.equal(instance.getState().participants.length, 0);
  instance.destroy();
});

test('headless: second widget instance gets its own CSS scope and does not render UI', async () => {
  const first = await mountHeadless({ customCss: '.a { color: red }' });
  const second = await mountHeadless({ customCss: '.b { color: blue }' });
  const firstId = first.root.getAttribute('data-agil-widget');
  const secondId = second.root.getAttribute('data-agil-widget');
  assert.ok(firstId);
  assert.ok(secondId);
  assert.notEqual(firstId, secondId);
  assert.equal(first.root.children.length, 0);
  assert.equal(second.root.children.length, 0);
  first.instance.destroy();
  second.instance.destroy();
});

test('headless: no global keyboard shortcuts are installed', async () => {
  const { instance } = await mountHeadless();
  assert.ok(fakeDocument);
  assert.equal(fakeDocument.listeners.get('keydown')?.size ?? 0, 0, 'headless must not steal m/v/c/b/h/f');
  instance.destroy();
});

test('headless: offline join emits a typed error and a terminal error phase', async () => {
  const { instance } = await mountHeadless();
  const events: Array<{ code?: string; offline?: boolean; message?: string }> = [];
  instance.on('error', (payload) => events.push(payload as { code?: string; offline?: boolean }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError('Failed to fetch');
  }) as typeof fetch;
  try {
    await instance.join();
  } finally {
    globalThis.fetch = originalFetch;
  }
  const state = instance.getState();
  assert.equal(state.phase, 'error', 'headless never parks on the default-UI join screen');
  assert.equal(state.serverOnline, false);
  assert.equal(state.error?.code, 'network_error');
  assert.equal(events.length, 1, 'offline failures emit exactly one error event');
  assert.equal(events[0]?.offline, true);
  instance.destroy();
});

test('headless: toast events keep actionable buttons', () => {
  const store = new CallStore(createInitialState(defaultConfig({ tenantId: 'demo' }), 'ru'));
  const seen: Array<{ message: string; kind: string; actions?: Array<{ label: string; onClick: () => void }> }> = [];
  const ui = new HeadlessUi(new FakeElement('div') as unknown as HTMLElement, store, (message, kind, actions) => {
    seen.push({ message, kind, actions });
  });
  let clicks = 0;
  ui.showToast('SFU unavailable', 'error', 9000, [{ label: 'Retry', onClick: () => (clicks += 1) }]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.message, 'SFU unavailable');
  assert.equal(seen[0]?.actions?.[0]?.label, 'Retry');
  seen[0]?.actions?.[0]?.onClick();
  assert.equal(clicks, 1, 'the headless action runs the same handler as the default UI');
  ui.showToast('Plain info', 'info');
  assert.equal(seen[1]?.actions, undefined);
  ui.destroy();
});

test('api: the join token never appears in the WebSocket URL', () => {
  const api = new ApiClient({ baseUrl: 'https://calls.example.com' });
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.signature';
  const url = api.websocketUrl({ token, roomId: 'room-1', name: 'Анна', role: 'guest' });
  assert.equal(url, 'wss://calls.example.com/ws');
  assert.equal(url.includes(token), false);
  assert.equal(new URL(url).searchParams.has('token'), false);
  const protocols = api.websocketProtocols(token);
  assert.equal(protocols[0], 'agil-calls.v1');
  assert.equal(decodeURIComponent((protocols[1] ?? '').slice('agil-token.'.length)), token);
  // Anonymous joins still use query identity, and never leak a token protocol.
  const anonymous = api.websocketUrl({ roomId: 'room-1', name: 'Анна', role: 'guest' });
  assert.equal(new URL(anonymous).searchParams.get('room'), 'room-1');
  assert.deepEqual(api.websocketProtocols(), ['agil-calls.v1']);
});

test('recording: a stalled video.play() cannot hang startRecording', async () => {
  const started = Date.now();
  const status = await playWithTimeout({ play: () => new Promise<void>(() => undefined) }, 20);
  assert.equal(status, 'timeout');
  assert.ok(Date.now() - started < 500, 'the timeout must win over a never-settling play()');
  assert.equal(await playWithTimeout({ play: async () => undefined }, 50), 'played');
  assert.equal(
    await playWithTimeout(
      {
        play: async () => {
          throw new Error('autoplay blocked');
        },
      },
      50,
    ),
    'rejected',
  );
});

test('remote streams: empty 0-track streams never resurrect a departed id', () => {
  const live = new MediaStream();
  live.addTrack({ id: 'track-1' } as MediaStreamTrack);
  const empty = new MediaStream();
  const result = withoutEmptyRemoteStreams({ peer: live, departed: empty });
  assert.deepEqual(Object.keys(result), ['peer']);
  assert.equal(result.peer, live);
});

test('mesh engine: removePeer emits one removal and no ghost 0-track stream', () => {
  const removed: string[] = [];
  const streams: MediaStream[] = [];
  const engine = new WebRtcEngine({
    selfId: 'self',
    config: defaultConfig({ tenantId: 'demo' }),
    iceServers: [],
    signaling: {} as never,
    callbacks: {
      onRemoteStream: (_participantId, stream) => streams.push(stream),
      onPeerRemoved: (participantId) => removed.push(participantId),
      onConnectionState: () => undefined,
      onQuality: () => undefined,
      onNegotiationError: () => undefined,
      onIceRestart: () => undefined,
    },
  });
  const peers = (engine as unknown as { peers: Map<string, unknown> }).peers;
  peers.set('peer-1', {
    participant: { id: 'peer-1' },
    pc: { close: () => undefined },
    relayTimer: null,
  });
  engine.removePeer('peer-1');
  engine.removePeer('peer-1');
  assert.deepEqual(removed, ['peer-1'], 'onPeerRemoved fires exactly once');
  assert.equal(streams.length, 0, 'removePeer must not emit an empty remote-stream');
});

test('mesh updates the TURN credentials on an existing peer without an ICE restart', () => {
  const oldCredential = { urls: 'turn:relay.example:3478', username: '600:participant', credential: 'old-password' };
  const newCredential = { ...oldCredential, username: '900:participant', credential: 'new-password' };
  const engine = new WebRtcEngine({
    selfId: 'self', config: defaultConfig({ tenantId: 'demo' }), iceServers: [oldCredential], signaling: {} as never,
    callbacks: {
      onRemoteStream: () => undefined, onPeerRemoved: () => undefined, onConnectionState: () => undefined,
      onQuality: () => undefined, onNegotiationError: () => undefined, onIceRestart: () => undefined,
    },
  });
  const current: RTCConfiguration = { iceServers: [oldCredential], iceTransportPolicy: 'relay' };
  let updated: RTCConfiguration | undefined;
  const peers = (engine as unknown as { peers: Map<string, unknown> }).peers;
  peers.set('connected-peer', { pc: {
    signalingState: 'stable',
    getConfiguration: () => current,
    setConfiguration: (next: RTCConfiguration) => { updated = next; },
    restartIce: () => assert.fail('The active ICE connection must not be restarted'),
  } });
  engine.setIceServers([newCredential]);
  assert.deepEqual(updated, { ...current, iceServers: [newCredential] });
  assert.equal(peers.size, 1);
});

test('mesh engine keeps video through audio-only samples and restores it after hysteresis', async () => {
  const config = defaultConfig({ tenantId: 'demo' });
  config.fallback.lowBandwidth.enabled = true;
  const results: Array<{ tier: string; video: string; inbound: number }> = [];
  const engine = new WebRtcEngine({
    selfId: 'self', config, iceServers: [], signaling: {} as never,
    callbacks: {
      onRemoteStream: () => undefined,
      onPeerRemoved: () => undefined,
      onConnectionState: () => undefined,
      onQuality: (decision, snapshot) => results.push({
        tier: decision.tier, video: decision.actions.video, inbound: snapshot.inboundBitrateKbps,
      }),
      onNegotiationError: () => undefined,
      onIceRestart: () => undefined,
    },
  });
  const internal = engine as unknown as { peers: Map<string, unknown>; sampleStats(emit: boolean): Promise<unknown> };
  let rtt = 0;
  let bytesReceived = 0;
  internal.peers.set('peer', {
    participant: { id: 'peer' }, connectionState: 'connected', iceRestarts: 0,
    lastStatsAt: 0, lastBytesReceived: 0, lastBytesSent: 0, lastPacketsLost: 0, lastPacketsReceived: 0,
    pc: {
      connectionState: 'connected', restartIce: () => undefined,
      getStats: async () => [
        { type: 'candidate-pair', nominated: true, currentRoundTripTime: rtt },
        { type: 'inbound-rtp', kind: 'audio', bytesReceived: bytesReceived += 3000 },
      ],
    },
  });
  await internal.sampleStats(true);
  assert.deepEqual(results[0], { tier: 'good', video: 'on', inbound: 12 });
  assert.equal(engine.currentVideoSuspended, false);
  rtt = 5;
  await internal.sampleStats(true);
  assert.equal(engine.currentVideoSuspended, true, 'transport degradation still suspends video');
  rtt = 0;
  await internal.sampleStats(true);
  assert.equal(engine.currentVideoSuspended, true, 'the first recovered sample keeps hysteresis');
  assert.equal(results.at(-1)?.tier, 'good');
  await internal.sampleStats(true);
  assert.equal(results.at(-1)?.tier, 'good');
  assert.equal(engine.currentVideoSuspended, false, 'the next good sample restores video');
});

test('mesh engine: duplicate ontrack for one stream emits a single remote-stream', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection');
  class FakePeerConnection {
    connectionState = 'new';
    signalingState = 'stable';
    localDescription = null;
    remoteDescription = null;
    addTransceiver(): unknown {
      return {
        sender: { replaceTrack: async () => undefined },
        setCodecPreferences: () => undefined,
      };
    }
    close(): void {
      /* no-op */
    }
  }
  Object.defineProperty(globalThis, 'RTCPeerConnection', { value: FakePeerConnection, configurable: true, writable: true });
  try {
    const events: MediaStream[] = [];
    const engine = new WebRtcEngine({
      selfId: 'zzz-self',
      config: defaultConfig({ tenantId: 'demo' }),
      iceServers: [],
      signaling: {} as never,
      callbacks: {
        onRemoteStream: (_participantId, stream) => events.push(stream),
        onPeerRemoved: () => undefined,
        onConnectionState: () => undefined,
        onQuality: () => undefined,
        onNegotiationError: () => undefined,
        onIceRestart: () => undefined,
      },
    });
    await engine.addPeer({ id: 'a-peer', name: 'A' } as never);
    const peer = (engine as unknown as { peers: Map<string, { pc: { ontrack?: (event: unknown) => void } }> }).peers.get('a-peer');
    assert.ok(peer?.pc.ontrack);
    const stream = new MediaStream();
    const track = { id: 'track-1', addEventListener: () => undefined };
    stream.addTrack(track as unknown as MediaStreamTrack);
    peer.pc.ontrack!({ streams: [stream], track, receiver: {} });
    peer.pc.ontrack!({ streams: [stream], track, receiver: {} });
    assert.equal(events.length, 1, 'audio+video ontrack for the same stream is not duplicated');
    assert.equal(events[0], stream);
  } finally {
    if (original) Object.defineProperty(globalThis, 'RTCPeerConnection', original);
    else delete (globalThis as Record<string, unknown>).RTCPeerConnection;
  }
});

test('destroy clears public subscribe() listeners', async () => {
  const { instance } = await mountHeadless();
  let calls = 0;
  instance.subscribe(() => {
    calls += 1;
  });
  instance.destroy();
  const before = calls;
  instance.raiseHand(true);
  assert.equal(calls, before, 'store subscribers are dropped by destroy()');
});
