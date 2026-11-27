# @agil/calls-sdk

**Русский** · [English](README.en.md)

SDK-обёртка AgilFrame: глобальный `AGILCalls` (один самодостаточный скрипт) и
ESM-сборка. Внутрь IIFE встроены виджет, `@agil/protocol`, zod и CSS — достаточно
одного `<script>`.

## Сборка

```bash
npm run typecheck -w @agil/calls-sdk
npm run build -w @agil/calls-sdk
# dist/agil-calls.js      — IIFE, global AGILCalls (self-contained, CSS инжектится)
# dist/agil-calls-sdk.js  — ESM
# dist/agil-calls.css     — CSS виджета (на случай ручного подключения)
```

CSS инжектится автоматически при `mount()`/`resume()` (id
`agil-calls-widget-styles`), поэтому IIFE не требует отдельного `<link>`.

## Скрипт на странице

```html
<script src="http://localhost:8787/sdk/agil-calls.js"></script>
<div id="call" style="height:640px"></div>
<script type="module">
  const call = await AGILCalls.mount('#call', {
    serverUrl: 'http://localhost:8787',
    tenantId: 'demo',
    room: 'team-sync',
    token: '<jwt>',              // или без токена — виджет покажет экран входа
    participantName: 'Анна',
    theme: { scheme: 'auto' },
  });

  call.on('chat', (message) => console.log('chat', message));
  call.on('quality-changed', (event) => console.log('quality', event));
  call.on('joined', () => console.log('joined'));
</script>
```

`mount` принимает элемент или CSS-селектор, не требует user gesture и не
запрашивает камеру: медиа — по кнопке «Войти» (или сразу при наличии токена).
Если `window`/`document` недоступны, `mount` бросает понятную ошибку.

### Свой UI (headless)

```ts
const call = await AGILCalls.mount('#call', {
  ui: 'headless',              // или headless: true
  serverUrl: 'http://localhost:8787',
  room: 'team-sync',
  token: '<jwt>',
});
call.on('state', render);      // полный CallState
call.on('remote-stream', attachStream);
call.raiseHand(); call.sendReaction('👍'); await call.sendChat('привет');
```

В режиме `headless` контроллер входит в комнату, публикует медиа и передаёт
сообщения, состояние звонка и события опросов. Руководство содержит примеры для Vanilla JS,
React и Svelte и описывает `iconUrls`, `customCss` и правила безопасности. [Свой интерфейс](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/custom-ui.md)

ESM:

```ts
import { mount, createEmbed, themePresets } from '@agil/calls-sdk';
```

## iframe-режим

```ts
const { html, iframe, url } = AGILCalls.createEmbed({
  serverUrl: 'http://localhost:8787',
  room: 'team-sync',
  token: '<jwt>',
  tenantId: 'demo',
  locale: 'ru',
  theme: { scheme: 'auto' },
  width: '100%',
  height: 640,
});
document.body.append(iframe!);
```

`html` — готовый сниппет для вставки в шаблон/CRM. URL:
`/embed.html?server=&room=&token=&tenant=&lang=&theme=&name=&role=`.

### postMessage-контракт (`agil/core/docs/contract.md` §7, §22)

От родителя в iframe:

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
send({ type: 'agil:chat-send', text: 'Привет' });
send({ type: 'agil:ping' });
```

Из iframe родителю: `agil:ready` (capabilities), `agil:event` (все события
виджета, включая `action-denied`), `agil:chat`, `agil:state`, `agil:minimized`,
`agil:pong`.

**Origin-политика.** Обработчик принимает сообщения только от `window.parent` и
только с разрешённых origin: `integrations.allowedOrigins` из конфига тенанта.
Если список пуст — разрешён только same-origin (так безопаснее по умолчанию).
Встраивание iframe с чужого домена требует добавить origin компании в
`integrations.allowedOrigins` (редактор/`PATCH /v1/tenants/:id/config`).
Неизвестное/запрещённое действие не выполняется; родитель получает
`agil:event {event:'action-denied', payload:{action, reason}}`.

## Темы

```ts
AGILCalls.themePresets;      // light | dark | corporate | night | minimal
AGILCalls.presets;           // ['light','dark','corporate','night','minimal']
AGILCalls.resolveTheme(patch, 'auto');
AGILCalls.generatePalette('#0b5fff', 'dark');
AGILCalls.auditTheme(theme); // контраст/доступность
```

## Восстановление звонка между страницами (§22.2)
Если включить `layout.persistAcrossPages` (или `call.persistSession(true)`),
виджет сохраняет в `sessionStorage` `{room, token, tenant, name, theme}`.

```ts
// на новой странице
const call = await AGILCalls.resume('#call');
// либо
const call2 = await AGILCalls.mount('#call', { room: '', resume: true });
```

`resume` возвращает `null`, если сохранённой сессии нет. В SPA виджет
монтируется один раз и не разрушается при переходах — звонок не прерывается.

## Внешний чат и мини-режим

- `config.session.chat.ui = 'external'` — виджет не рисует свою панель:
  сообщения отдаются в `onEvent('chat')` / `agil:chat`, исходящие — через
  `call.sendChat()` / `agil:chat-send`.
- `call.minimize()/restore()/isMinimized()/requestPictureInPicture()` —
  плавающее окно и Document PiP (Chromium; иначе fallback на плавающую панель).
- `call.requestFullscreen()/exitFullscreen()/isFullscreen()` — Fullscreen API
  (кнопка `data-agil-action="fullscreen"`, Esc синхронизируется).
- `call.getCallUrl()` / `call.openInNewTab()` — deep link на `/embed.html` и
  открытие в новой вкладке (popup blocked → toast со ссылкой). Глобально:
  `AGILCalls.createCallUrl(options)` и `AGILCalls.openCall(options)`.
- `config.layout.chrome = 'none'` — рендер без шапки/фона, как часть страницы
  компании; `inheritHostStyles` — наследовать шрифт/цвета хоста.
- Мессенджер-сценарий (1:1/группы, отключённый встроенный чат, fullscreen,
  новая вкладка, мини-окно). [Интеграция с мессенджером](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/messenger.md)

## Внешний чат, фоны и провайдеры

- `config.providers.chat.mode = 'external'` + `session.chat.ui` не переопределён →
  виджет по умолчанию не рисует свой чат, отдаёт сообщения в
  `onEvent('chat')`/`agil:chat`, принимает исходящие через `sendChat()`/
  `agil:chat-send`. `providers.chat.mode='disabled'` → чат скрыт.
- `config.providers.backgrounds.mode = 'external'` → список фонов берётся из
  `GET /v1/tenants/:id/backgrounds`; иначе — `session.virtualBackgrounds`.
  Пустой `url` = встроенный градиент, поэтому фоны работают без провайдера.
- Файлы/запись/STT маршрутизируются сервером; виджет не меняется. При 502 от
  `/v1/stt/transcribe` показывается «сервис компании недоступен, используется
  встроенный» и включается браузерный Web Speech.
- **Автономность.** Без внешних сервисов доступны: медиа/чат/файлы/демонстрация/
  запись/браузерный STT/локальные заметки/темы/права/аудит. Внешние системы —
  опциональная замена (см. `agil/core/docs/extensibility.md`), не требование.

## Ограничения

- Вместимость комнаты зависит от режима передачи медиа и профиля развёртывания. [Масштабирование](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/scaling.md)
- Блюр/фон и liveness зависят от CDN MediaPipe; при недоступности — деградация
  с флагом `degraded`, без падения звонка.
- Web Speech API — Chrome/Edge; серверный STT — fallback.
- Document PiP — только Chromium.
