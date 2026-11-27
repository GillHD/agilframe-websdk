# @agil/calls-sdk

[Русский](README.md) · **English**

The AgilFrame JavaScript SDK provides a self-contained script with the global `AGILCalls` API and an ES module build. The global script includes the widget, `@agil/protocol`, Zod, and styles.

## Build

```sh
npm run typecheck -w @agil/calls-sdk
npm run build -w @agil/calls-sdk
```

| Output | Purpose |
| --- | --- |
| `dist/agil-calls.js` | Self-contained script exposing `AGILCalls` |
| `dist/agil-calls-sdk.js` | ES module build |
| `dist/agil-calls.css` | Widget stylesheet for manual inclusion |

`mount()` and `resume()` inject CSS automatically under `agil-calls-widget-styles` when you use the global script.

## Load the SDK in a page

```html
<script src="http://localhost:8787/sdk/agil-calls.js"></script>
<div id="call" style="height:640px"></div>
<script type="module">
  const call = await AGILCalls.mount('#call', {
    serverUrl: 'http://localhost:8787',
    tenantId: 'demo',
    room: 'team-sync',
    token: '<jwt>',
    participantName: 'Anna',
    theme: { scheme: 'auto' },
  });

  call.on('chat', (message) => console.log('chat', message));
  call.on('quality-changed', (event) => console.log('quality', event));
  call.on('joined', () => console.log('joined'));
</script>
```

`mount()` accepts an element or a CSS selector. The widget can show the join screen when you omit the participant token. Media permission requests follow the join flow. Mounting requires a browser DOM.

For the ES module build, use named imports.

```ts
import { mount, createEmbed, themePresets } from '@agil/calls-sdk';
```

### Build your own interface

Mount the widget with `ui: 'headless'` to use the controller without the built-in markup. The controller exposes media streams, call state, chat, and participant events. The legacy `headless: true` option also selects this mode.

```ts
const call = await AGILCalls.mount('#call', {
  ui: 'headless',
  serverUrl: 'http://localhost:8787',
  room: 'team-sync',
  token: '<jwt>',
});
call.on('state', render);
call.on('remote-stream', attachStream);
call.raiseHand();
call.sendReaction('👍');
await call.sendChat('Hello');
```

The custom UI guide covers Vanilla JS, React, Svelte, `iconUrls`, `customCss`, and security considerations. [Custom UI guide](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/custom-ui.md)

## Embed a call in an iframe

```ts
const { html, iframe, url } = AGILCalls.createEmbed({
  serverUrl: 'http://localhost:8787',
  room: 'team-sync',
  token: '<jwt>',
  tenantId: 'demo',
  locale: 'en',
  theme: { scheme: 'auto' },
  width: '100%',
  height: 640,
});
document.body.append(iframe!);
```

Use `html` in a template or CRM and `url` to link directly to the embed. The `/embed.html` page accepts `server`, `room`, `token`, `tenant`, `lang`, `theme`, `name`, and `role` query parameters.

### Parent and iframe messages

Use the iframe's exact origin as the `postMessage` target. Configure `integrations.allowedOrigins` on the tenant to allow a cross-origin host page. The viewer accepts messages from `window.parent` at permitted origins. With an empty allowlist, only the same origin is allowed. [Integration contract](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/contract.md)

```js
const targetOrigin = new URL(iframe.src).origin;
const send = (message) => iframe.contentWindow.postMessage(message, targetOrigin);
send({ type: 'agil:config', config: patch });
send({ type: 'agil:theme', theme: patch });
send({ type: 'agil:scheme', scheme: 'dark' });
send({ type: 'agil:action', action: 'toggle-mic' });
send({ type: 'agil:action', action: 'minimize' });
send({ type: 'agil:action', action: 'restore' });
send({ type: 'agil:action', action: 'pip' });
send({ type: 'agil:chat-send', text: 'Hello' });
send({ type: 'agil:ping' });
```

The iframe emits `agil:ready`, `agil:event`, `agil:chat`, `agil:state`, `agil:minimized`, and `agil:pong`. A blocked action produces an `agil:event` with `event: 'action-denied'` and a payload containing `action` and `reason`.

## Themes

```ts
AGILCalls.themePresets;
AGILCalls.presets;
AGILCalls.resolveTheme(patch, 'auto');
AGILCalls.generatePalette('#0b5fff', 'dark');
AGILCalls.auditTheme(theme);
```

The preset names are `light`, `dark`, `corporate`, `night`, and `minimal`.

## Resume a call after navigation

Enable `layout.persistAcrossPages` or call `call.persistSession(true)` to save room, token, tenant, name, and theme in `sessionStorage`. `resume()` returns `null` when no saved session exists. In a single-page application, keep the mounted widget alive across route changes to preserve the active call.

```ts
const call = await AGILCalls.resume('#call');
// Alternatively:
const restored = await AGILCalls.mount('#call', { room: '', resume: true });
```

## Chat and display controls

- `config.session.chat.ui = 'external'` uses the host application's chat interface. Subscribe to `chat` or `agil:chat` for incoming messages. Send messages with `call.sendChat()` or `agil:chat-send`.
- Use `call.minimize()`, `call.restore()`, `call.isMinimized()`, and `call.requestPictureInPicture()` for the floating panel or Document Picture-in-Picture. Document PiP is supported in Chromium. Other browsers fall back to the floating panel.
- Use `call.requestFullscreen()`, `call.exitFullscreen()`, and `call.isFullscreen()` for fullscreen. The `fullscreen` control tracks exit through Escape.
- Use `call.getCallUrl()` and `call.openInNewTab()` to open the hosted embed. The widget displays a link if the browser blocks the new tab. `AGILCalls.createCallUrl()` and `AGILCalls.openCall()` are also available.
- `config.layout.chrome = 'none'` removes the header and surface background. Set `inheritHostStyles` to inherit host fonts and colors. [Messaging integration guide](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/messenger.md)

## Providers and fallback behavior

- With an external chat provider and no explicit `session.chat.ui`, the SDK uses the external chat interface. Setting the provider mode to `disabled` hides chat.
- An external background provider supplies presets through `GET /v1/tenants/:id/backgrounds`. Built-in presets use `session.virtualBackgrounds`. An empty background URL selects a built-in gradient.
- Core routes file, recording, and speech-to-text requests. If `/v1/stt/transcribe` returns `502`, the widget can fall back to the browser Web Speech API when available.
- The built-in features can run without third-party integrations. Some browser features still require a supported browser, network access, or a configured infrastructure service. [Extensibility guide](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/extensibility.md)

## Browser and media compatibility

Room capacity and media routing depend on the configured deployment profile. Background segmentation and liveness checks rely on MediaPipe assets, with degraded operation if assets cannot be loaded. Browser speech recognition and Document PiP depend on browser support. [Scaling guide](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/scaling.md)
