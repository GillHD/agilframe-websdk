# @agil/calls-widget

[Русский](README.md) · **English**

The framework-independent AgilFrame call widget combines a browser interface with mesh WebRTC and SFU media support. It includes themes, chat, backgrounds, recording, captions, meeting notes, and a floating call panel. Available features depend on tenant policy, participant permissions, and browser support. [Integration contract](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/contract.md)

## Build

```sh
npm run typecheck -w @agil/calls-widget
npm run build -w @agil/calls-widget
```

The build produces `dist/agil-calls-widget.js` and `dist/agil-calls-widget.css`. The JavaScript bundle includes the shared protocol and Zod. The widget loads tenant configuration from `GET /v1/tenants/:tenantId/config` and falls back to `defaultConfig()` when unavailable.

## Quick start

```ts
import { mountWidget } from '@agil/calls-widget';

const call = await mountWidget(document.querySelector('#call')!, {
  serverUrl: 'http://localhost:8787',
  tenantId: 'demo',
  room: 'team-sync',
  participantName: 'Anna',
  locale: 'en',
});

call.on('chat', (message) => console.log('chat', message));
```

Mounting makes the join screen available. Media access is requested through the join flow. An embed that receives a participant token may begin that flow automatically.

## `AgilCallOptions`

| Option | Purpose |
| --- | --- |
| `serverUrl` | Base URL for REST and WebSocket connections. Defaults to `window.location.origin`. |
| `room` | Room ID. |
| `token` | Participant token. When omitted, the widget can request one through `POST /v1/rooms/:id/join`. |
| `tenantId` | Tenant ID. Defaults to `demo`. |
| `participantName` | Display name. |
| `role` | `host`, `moderator`, or `guest`. Server authorization controls effective permissions. |
| `locale` | `ru` or `en`. |
| `theme` | Local `ThemePatch` layered over the server theme. |
| `config` | Local `TenantConfigPatch` layered over the server configuration. |
| `embedded` | Fill the container and remove the outer frame when `true`. |
| `resume` | Restore a session from `sessionStorage`. |
| `ui` | `'default'` renders the built-in interface. `'headless'` exposes the controller. |
| `headless` | Legacy alias for `ui: 'headless'`. An explicit `ui` takes precedence. |
| `iconUrls` | `Record<IconName, string>` of HTTP or HTTPS icon URLs. |
| `customCss` | Host styles scoped to the widget root. |
| `onEvent`, `onChat` | Event and chat callbacks. |

## Instance API

`join()`, `leave()`, and `destroy()` control the call lifecycle. `getState()` and `subscribe()` expose state, `getStats()` reports media diagnostics, and `getSelf()` and `getParticipants()` expose participant records. Media stream accessors are `getLocalStream()`, `getRemoteStreams()`, and `getScreenStream()`.

Use `toggleMic()`, `toggleCamera()`, `toggleScreenShare()`, and `setBlurMode()` for media controls. Use `sendChat()`, `sendReaction()`, `raiseHand()`, and `lowerHand()` for communication. Recording uses `startRecording()` and `stopRecording()`. Polls use `listPolls()` and `createPoll()`.

Subscribe to events such as `joined`, `chat`, `state`, `reaction`, `poll`, and `toast` with `call.on(eventName, listener)`. A headless integration can use the same public actions, streams, and events, including `remote-stream`, `participant-*`, `media-state`, and `error`. [Custom UI guide](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/custom-ui.md)

### Display and session controls

- `minimize()`, `restore()`, and `isMinimized()` control the floating panel. `requestPictureInPicture()` requests Document PiP on Chromium, with the floating panel as a fallback.
- `requestFullscreen()`, `exitFullscreen()`, and `isFullscreen()` control fullscreen. The widget reflects `fullscreenchange`, including exit through Escape.
- `getCallUrl()` builds a hosted `/embed.html` link. `openInNewTab()` returns `Window | null` and offers a copyable link when the browser blocks the popup. Avoid logging links that contain a participant token.
- `persistSession(true)` saves the room, token, tenant, name, and theme in `sessionStorage`. `resume()` restores the call. Keep the mounted widget alive across route changes in single-page applications.
- `setGalleryPage()` uses a zero-based index. `setFollowSpeaker()` controls speaker-follow behavior. `setVideoQuality()` accepts `'auto'`, `'high'`, `'medium'`, or `'low'`.

## Calls in messaging applications

Set `session.chat.ui` to `'hidden'` to remove the built-in chat, or use `'external'` for a chat interface provided by the host. In a two-participant `direct` room, the widget suggests spotlight when `layout.mode` is unspecified. The header can use `room.context.title` or the other participant's name. Use a floating panel, fullscreen, or a new tab to keep call controls available while the user navigates the messenger. [Messaging integration guide](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/messenger.md)

## In-call assistant

`session.inCallAgent.enabled` controls the in-call assistant panel. The assistant uses the participant's permissions for actions such as recording, camera, microphone, screen sharing, and opening panels. A blocked action shows a notification.

| Mode | Behavior |
| --- | --- |
| `local` | Uses the local assistant in `@agil/protocol` for supported controls and guidance. |
| `external` | Uses `POST /v1/rooms/:id/assistant` with a participant token. A local-only server can trigger the local fallback. |
| `hybrid` | Uses the same endpoint and can fall back locally if it is unavailable. |

The assistant can highlight call controls with a spotlight overlay. The target is marked with `[data-agil-spotlight-target]`. For test automation, the widget exposes `data-agil-assistant-ready` and attributes for the panel, text input, send button, messages, and answers. [In-call assistant](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/in-call-agent.md) · [External LLM integration](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/llm-integrations.md)

## Themes and layout

The widget uses `ThemeTokens` from `@agil/protocol` and exposes token values as `--agil-*` custom properties. A specified `light` or `dark` scheme derives a palette for that scheme while carrying over brand settings. The `auto` scheme follows `prefers-color-scheme`. Theme helpers include `themeForScheme()`, `normalizeTheme()`, and `ensureReadableTheme()`.

```ts
call.updateTheme({ colors: { primary: '#0b5fff' } });
call.setThemeScheme('dark');
```

Update layout with `updateConfig({ layout })`.

| Option | Purpose |
| --- | --- |
| `layout.chrome` | `full`, `compact`, or `none`. `none` removes the header and surface background while retaining call controls. |
| `layout.inheritHostStyles` | Inherit the host application's type and color styles. |
| `layout.controlsStyle` | `bar`, `island`, or `minimal`. |
| `layout.controlsAnchor` | `bottom-center`, `bottom-left`, `bottom-right`, `top-center`, or `top-right`. |
| `layout.hiddenControls` | Hide selected controls. Use `features` or `accessPolicy` to disable their actions. |
| `layout.controlOrder` | Set the order of selected controls. The remaining controls follow their default order. |
| `layout.autoHideControls` | Hide controls after inactivity. |
| `layout.autoHideDelaySec` | Delay before controls hide, in seconds, from 1 to 120. |
| `layout.minimized` | Configure the floating panel's mode, position, self view, and controls. |
| `layout.persistAcrossPages` | Enable session restoration after full-page navigation. |

The island layout groups frequently used controls and places additional actions in the overflow menu. The minimal layout keeps the microphone, camera, leave, and overflow controls. The bar layout uses a lower toolbar and can adapt to an island layout on narrow screens. [Layout guide](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/layout.md) · [Call interface design](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/call-ui-v3.md)

## Chat and background providers

Set `config.session.chat.ui` to `builtin`, `external`, or `hidden`. Read the active mode on `data-agil-chat-mode` and change it with `setChatMode()`. In external mode, receive messages through `onEvent` or `onChat` and send them through `call.sendChat()`.

When there is no explicit chat UI setting, `config.providers.chat.mode = 'external'` selects external chat, and `'disabled'` hides chat. The provider setting controls routing and storage on Core. The UI setting controls rendering in the widget.

An external backgrounds provider supplies presets through `GET /v1/tenants/:id/backgrounds`. The widget falls back to `session.virtualBackgrounds` if the provider is unavailable. An empty background URL selects a theme gradient.

Core handles file and recording services. Browser speech recognition depends on browser support. If a configured speech-to-text provider is unavailable, the widget can fall back to browser speech recognition when supported.

## Permissions and privacy

- The widget uses permissions returned in `welcome.self.permissions` and `JoinRoomResponse.permissions` to show available controls. Core enforces those permissions.
- Location visibility depends on role and tenant policy. Precise GPS data requires explicit consent and `security.geo.gpsEnabled`.
- The widget renders user-controlled text as text. Links are limited to HTTP and HTTPS and use `rel="noopener noreferrer"`.
- The knowledge assistant is a separate feature governed by `knowledgeAgent` permission and `session.knowledgeAgent`. It uses the `assistant-query` WebSocket message.

## Webinars and livestreams

The widget applies the room media mode returned by Core (`mesh`, `sfu`, or `broadcast`). If it is absent, the widget uses the deployment and webinar configuration. The widget exposes `data-agil-media-mode` and `data-agil-viewer` on its root.

In a configured broadcast room with host-only publishing, the viewer interface hides local media controls. Chat, hand raising, and reactions depend on webinar policy. Moderated chat shows submission status to the viewer. The participant list and bounded gallery UI are independent of media-plane capacity. [Scaling and media modes](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/scaling.md)

## Browser and media compatibility

- Use SFU for rooms beyond the mesh profile. Room capacity depends on the deployment and enabled features.
- Background segmentation uses MediaPipe assets. If those assets are unavailable, the widget can fall back to degraded background processing. `getStats().blurDegraded` reports that state.
- Captions depend on browser speech recognition or the configured speech-to-text service.
- Liveness results provide advisory signals. An inconclusive check yields `unknown`.
- Browser recording uses canvas composition and Web Audio. Container format depends on browser support. If server storage is enabled, the widget uploads recordings through `POST /v1/recordings`.

## End-to-end test selectors

```text
[data-agil-root][data-state][data-agil-scheme][data-agil-quality][data-agil-chat-mode][data-agil-minimized]
[data-agil-tile][data-participant-id][data-self]
[data-agil-chat-input], [data-agil-chat-send], [data-agil-chat-message][data-message-id]
[data-agil-participants-count], [data-agil-connection]
```

Use `data-agil-action` for controls such as `mic`, `camera`, `screen`, `blur`, `chat`, `hand`, `leave`, `settings`, `recording`, `assistant`, `captions`, `minimize`, `restore`, and `pip`.

## Development

```sh
npm run typecheck -w @agil/calls-widget
npm run build -w @agil/calls-widget
npm test -w @agil/calls-widget
npm run dev -w @agil/calls-widget
```
