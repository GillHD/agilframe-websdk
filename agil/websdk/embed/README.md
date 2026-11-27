# @agil/calls-embed

Framework-agnostic `<agil-call>` Web Component for AgilFrame. It embeds the
hosted `/embed.html` iframe in **inline** or **floating-launcher** mode, owns a
strict postMessage bridge, maps iframe events to DOM events, and ships a safe
URL builder and fallback UI. No React/Vue/Svelte dependency, no runtime
dependencies, no build step for consumers.

- ESM: `dist/agil-call-embed.js` (auto-registers the element)
- IIFE: `dist/agil-call-embed.iife.js` (global `AgilCallEmbed`, auto-registers)
- Types: `dist/types/index.d.ts`
- Full integrator guide: `agil/core/docs/embed-module.md` in the AgilFrame repository
  (not shipped in this package, so npm does not render a broken relative link).

## Install

The package is currently a private workspace package (`"private": true`), not an
npm registry release. Build it from the AgilFrame monorepo with
`npm run build:embed`, then consume `dist/agil-call-embed.js` (ESM) or
`dist/agil-call-embed.iife.js` (script tag). Publishing requires removing the
`private` flag and deciding on a distribution URL first.

## Build

```bash
npm run build:embed          # from the repo root
# or
npm run build -w @agil/calls-embed
# or, inside agil/websdk/embed:
npm run typecheck && npm test && npm run build
```

Latest local artifacts (source maps excluded):

| Artifact | Raw | Gzip |
| --- | ---: | ---: |
| `dist/agil-call-embed.js` (ESM) | 47.78 kB | 13.83 kB |
| `dist/agil-call-embed.iife.js` (IIFE) | 35.70 kB | 11.95 kB |

Vite keeps whitespace in ES library output by design; the IIFE is fully
minified. Gzip sizes are the relevant delivery numbers.

## Quick start (script tag)

The IIFE build self-registers `<agil-call>`:

```html
<script src="https://calls.example.com/embed/agil-call-embed.iife.js"></script>

<agil-call
  server-url="https://calls.example.com"
  tenant="acme"
  room="team-sync"
  token="<short-lived-jwt>"
  name="Anna"
  theme="auto"
  language="en"
  height="640px"
></agil-call>
```

Floating launcher (iframe is created only when the button is clicked):

```html
<agil-call
  launcher
  server-url="https://calls.example.com"
  room="team-sync"
  token="<short-lived-jwt>"
></agil-call>
```

## Quick start (ESM)

```ts
import '@agil/calls-embed'; // registers <agil-call> in the browser

const call = document.querySelector('agil-call')!;
call.addEventListener('agil-ready', (event) => {
  console.log('ready', event.detail.capabilities);
});
call.addEventListener('agil-chat', (event) => {
  console.log('chat', event.detail.message);
});
await call.join();
```

Node/SSR is safe: importing the module does not touch `window`, `document` or
`customElements`. Call `defineAgilCall()` yourself when you control
registration (for example with a custom tag name).

## Attributes

| Attribute | Type | Default | Description |
| --- | --- | --- | --- |
| `server-url` | URL | current origin | AgilFrame server; **http(s) only**, no credentials/query/fragment. Public `http://` is rejected unless `allow-insecure` is set. |
| `tenant` | string | server-resolved | Tenant id (`?tenant=`). |
| `room` | string | — (required) | Room id (`?room=`). Missing room renders the fallback UI. |
| `token` | string | — | Short-lived join JWT. Sent only in the iframe URL query. |
| `identity-token` | string | — | Corporate OIDC token (`?identity_token=`). Same validation/redaction as `token`. |
| `role` | `host\|moderator\|guest` | — | Role for anonymous (token-less) joins (`?role=`). |
| `name` | string | — | Participant display name. |
| `theme` | `light\|dark\|auto` | `auto` | Chrome theme and iframe `?theme=` scheme. Use `setTheme()` for live changes. |
| `language` | BCP-47 | browser | Iframe `?lang=` and component chrome (`ru`/`en` translated). |
| `widget-path` | path | `embed.html` | Widget page path relative to `server-url` (subpath deployments preserved; `/embed.html` targets the origin root). |
| `height` | CSS length or `auto` | `640px` | Inline iframe height. `auto` uses same-origin measurement / `agil:resize`. |
| `relay-only` | boolean | `false` | Adds `?relay=1` (forces TURN relay). |
| `allowed-origins` | origins | iframe origin | Comma/space-separated **exact** origins allowed for inbound postMessage. Never `*`. |
| `launcher` | boolean or label | `false` | Floating button + modal. A non-boolean value becomes the button label (max 60 chars). |
| `allow-insecure` | boolean | `false` | Allows plain `http://` for non-loopback servers. Development only. |
| `max-participants` | number | `200` | Large-room cap (2..200) for the participant digest. The element emits `agil-participants` snapshots/deltas instead of a 200-id array on every `agil-state`. |

Boolean attributes follow HTML semantics, except explicit `false`/`0` also
disable them. The JS property for `role` is `callRole`, because
`HTMLElement.role` already exists.

## Properties and methods

| Member | Description |
| --- | --- |
| `join(): Promise<void>` | Opens the launcher if needed, waits for the handshake, sends `agil:action join`, focuses the iframe as a fallback join screen. |
| `leave(): Promise<void>` | Sends `agil:action leave` (no-op when no iframe is mounted). |
| `setTheme(theme): Promise<void>` | `light`/`dark`/`auto` sends `agil:scheme`; an object sends `agil:theme`. Does **not** reload the iframe. |
| `sendChat(text): Promise<void>` | Sends `agil:chat-send`; rejects empty text or text > 4000 chars. |
| `requestVideoUpgrade(): Promise<void>` | Asks the remote peer to switch audio to video in a direct P2P call. |
| `respondToVideoUpgrade(requestId, accept): Promise<void>` | Answers the incoming request from the latest `agil-state` event. |
| `open()` / `close()` | Opens/closes the launcher modal. Closing keeps the call and iframe alive. |
| `reconnect(): void` | Rebuilds the iframe from the same attributes (server/room/token preserved), resets the participant digest and starts a new bridge handshake. |
| `destroy(): void` | Stops the bridge, removes the iframe/listeners and empties the shadow root. Idempotent. |
| `status`, `isReady`, `isJoined`, `isLauncherOpen`, `callState`, `lastError` | Read-only state; `lastError` is always redacted. |
| `serverUrl`, `room`, `token`, … | Reflected attribute properties. |

`join()`, `leave()`, `setTheme()` and `sendChat()` resolve once the command is
posted over the bridge (not necessarily when the widget finishes the action).
Listen for `agil-joined`/`agil-left` for outcomes.

## Events

All events bubble, are composed, and cross the shadow boundary:

| Event | `detail` |
| --- | --- |
| `agil-ready` | `{ capabilities, room? }` |
| `agil-joined` | `{ payload? }` |
| `agil-left` | `{ payload? }` |
| `agil-chat` | `{ message }` |
| `agil-state` | `{ state }` — compact: `participantIds` is removed, `participantCount`/`participantRevision` added |
| `agil-participants` | `{ participants: ParticipantUpdate }` — one bounded `snapshot` (≤200 ids) then `delta` (`added`/`removed`) |
| `agil-connection` | `{ connection: ConnectionUpdate }` — deduplicated reconnect (`state`, `previous`, `attempt`, `delayMs`) |
| `agil-minimized` | `{ minimized }` — same shape as the mobile SDKs |
| `agil-fullscreen` | `{ fullscreen }` — same shape as the mobile SDKs |
| `agil-event` | `{ name, payload? }` — participant/quality/connection/… events |
| `agil-error` | `{ code, message, fatal, widgetCode? }` — token-free, redacted |

```ts
call.addEventListener('agil-error', (event) => {
  const { code, message, fatal } = event.detail;
  console.warn('call error', code, fatal, message); // never contains the token
});
```

Large-room details and the shared snapshot/delta rules are documented in
[`agil/core/docs/webview-large-rooms.md`](../../core/docs/webview-large-rooms.md).

## Modes

**Inline** (default) fills the host element and respects `height`. The host
controls page layout.

**Launcher** renders a floating action button. The iframe is lazy-created on
first open, kept alive when the modal is closed, and the modal becomes a
full-viewport sheet at ≤640px (including safe-area padding). Closing the modal
does **not** leave the call; use `leave()` or `destroy()`.

## Security

- Only `http:`/`https:` URLs; credentials, `javascript:`, `data:`, `file:` and
  cross-origin `widget-path` values are rejected.
- Inbound messages are accepted only when
  `event.source === iframe.contentWindow` **and** `event.origin` exactly
  matches an allowlisted origin. Wildcards are rejected.
- Outbound `postMessage` always uses the canonical iframe origin — never `*`.
- The token is never logged, never placed in DOM text, `title`, `aria-label` or
  error messages. It appears only in the iframe `src` query, as required by the
  embed contract (`referrerpolicy="no-referrer"` limits Referer leakage).
- All iframe payloads are structurally sanitized (depth/size limits, prototype
  keys dropped) before events are dispatched.
- The component can only validate messages it receives. The server must also
  allow the host via CSP `frame-ancestors` and the tenant's
  `integrations.allowedOrigins`.

## Limitations

- `join()` cannot force the hosted join screen: current `embed.html` has no
  programmatic `join` action. With a token the widget auto-joins; without one,
  `join()` requests it (forward-compatible) and focuses the iframe so the
  participant can confirm. This is documented in the event/error handling.
- Cross-origin iframes cannot be measured for `height="auto"`; the component
  waits for an optional `agil:resize` message and otherwise keeps 640px.
- The hosted page posts to its parent with `targetOrigin: '*'` (contract §7).
  This package enforces strict checks on its side but cannot change the widget.
- `allowed-origins` is defense-in-depth, not a substitute for the server's
  framing policy.
- The mobile fullscreen sheet is CSS-based (dialog occupies `100dvh`); it does
  not call the native Fullscreen API.
- No framework wrappers are shipped; use the element directly (examples in the
  docs). The package is private to the workspace and is not deployed/published.
