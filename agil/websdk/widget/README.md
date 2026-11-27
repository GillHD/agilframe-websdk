# @agil/calls-widget

Встраиваемый UI видеозвонков AgilFrame: WebRTC-mesh (до 8 участников) и
SFU-комнаты до 200 участников (25–36 плиток на страницу, видео только для
видимой страницы/пина/спикера, аудио — для всех), темы на дизайн-токенах, чат
(встроенный/внешний), блюр и замена фона, запись, субтитры, заметки,
знания-ассистент, мини-режим и работа без сети.

Один ES-бандл + CSS, без фреймворков. Публичный API соответствует `agil/core/docs/contract.md`
§6 (и §22 для мини-режима/внешнего чата).

## Сборка

```bash
npm run typecheck -w @agil/calls-widget
npm run build -w @agil/calls-widget
# dist/agil-calls-widget.js  (ES, self-contained: protocol + zod инлайн)
# dist/agil-calls-widget.css (все стили, только var(--agil-*))
```

Бандл ничего не требует, кроме DOM: тема и конфиг подтягиваются с сервера
(`GET /v1/tenants/:tenantId/config`), при недоступности — `defaultConfig()`.

## Быстрый старт

```ts
import { mountWidget } from '@agil/calls-widget';

const call = await mountWidget(document.querySelector('#call')!, {
  serverUrl: 'http://localhost:8787',
  tenantId: 'demo',
  room: 'team-sync',
  participantName: 'Анна',
  locale: 'ru',
});

call.on('chat', (message) => console.log('chat', message));
```

`mountWidget` не запрашивает камеру. Экран входа появляется сразу; доступ к
медиа запрашивается по кнопке «Войти» (или сразу, если передан `token` и
`resume:false` — embed-сценарий). Все ошибки сети/медиа показываются
пользователю, а не пробрасываются в консоль хоста.

## Опции (`AgilCallOptions`)

| Поле | Смысл |
|---|---|
| `serverUrl` | База REST/WS; по умолчанию `window.location.origin`. |
| `room` | id комнаты. |
| `token` | Join-token. Без него виджет сам делает `POST /v1/rooms/:id/join`. |
| `tenantId` | Тенант, по умолчанию `demo`. |
| `participantName` | Имя (по умолчанию «Гость»). |
| `role` | `host` / `moderator` / `guest`. |
| `locale` | `ru` / `en`. |
| `theme` | Локальный `ThemePatch` поверх серверной темы. |
| `config` | Локальный `TenantConfigPatch` поверх серверного конфига. |
| `embedded` | true — без внешней рамки, на весь контейнер. |
| `resume` | Восстановить сессию из `sessionStorage` (см. ниже). |
| `ui` | `'default'` (встроенный UI) или `'headless'` — без разметки, только контроллер. |
| `headless` | Алиас `ui: 'headless'`; `ui` имеет приоритет. |
| `iconUrls` | `Record<IconName, string>` — замена встроенных иконок по http(s)-URL (`<img>`). |
| `customCss` | CSS хоста, отскоупленный под корень виджета (см. `agil/core/docs/custom-ui.md`). |
| `onEvent`, `onChat` | Колбэки событий/чата. |

## API инстанса

```ts
call.join(); call.leave(); call.destroy();
call.updateTheme(patch); call.updateConfig(patch); call.setThemeScheme('auto');
call.sendChat('привет');
call.toggleMic(true); call.toggleCamera(); call.toggleScreenShare();
call.setBlurMode('blur' | 'image' | 'off', imageUrl?);
call.getStats(); call.getState(); call.subscribe((state) => {});
call.getLocalStream(); call.getRemoteStreams(); call.getScreenStream();
call.getSelf(); call.getParticipants();
call.raiseHand(); call.lowerHand(); call.sendReaction('👍');
await call.startRecording(); await call.stopRecording();
await call.listPolls(); await call.createPoll({ question, options });
call.on('joined' | 'chat' | 'state' | 'reaction' | 'poll' | 'toast' | ... , listener);
```

Для своего UI: `ui: 'headless'` (см. `agil/core/docs/custom-ui.md`); доступны
`state`/`remote-stream`/`participant-*`/`media-state`/`chat`/`reaction`/`poll`/
`error`/`toast`, потоки и публичные действия без DOM-зависимостей.

Дополнения §22:

```ts
call.minimize();                 // свернуть в плавающее окно
call.restore();                  // развернуть
call.isMinimized();
await call.requestPictureInPicture(); // Document PiP (Chromium), false + fallback
call.persistSession(true);       // сохранить {room, token, tenant, name, theme} в sessionStorage
await call.resume();             // поднять звонок из сохранённой сессии
call.setChatMode('builtin' | 'external' | 'hidden');

// Большие комнаты (stage 1, 200 участников)
call.setGalleryPage(2);           // страница галереи (0-based, клампится)
call.setFollowSpeaker(false);     // автопереход к активному спикеру
call.setVideoQuality('auto' | 'high' | 'medium' | 'low');

// Мессенджер (agil/core/docs/messenger.md)
await call.requestFullscreen();  // Fullscreen API на корне виджета
await call.exitFullscreen();
call.isFullscreen();             // синхронизировано с Esc/fullscreenchange
call.getCallUrl();               // /embed.html?server&room&token&tenant&name&theme
call.openInNewTab();             // Window|null; при блокировке popup — toast со ссылкой
```

## Звонок в мессенджере

Сценарий «позвонить из корпоративного чата» (1:1 P2P или группа) описан в
[agil/core/docs/messenger.md](../../core/docs/messenger.md). Что даёт виджет:

- **Чат не нужен:** `session.chat.ui='hidden'` (или `providers.chat.mode='external'`)
  — встроенная панель и кнопка скрыты, чат остаётся мессенджерным;
  сообщения звонка при необходимости — через `onEvent('chat')`/`sendChat()`.
- **1:1:** `room.mode='direct'` + 2 участника → виджет сам предлагает spotlight
  (если `layout.mode` не задан явно); в шапке показывается `room.context.title`
  или имя собеседника.
- **Полный экран:** кнопка `data-agil-action="fullscreen"`, API
  `requestFullscreen()/exitFullscreen()/isFullscreen()`,
  `data-agil-fullscreen="true|false"` на корне; выход по Esc синхронизируется.
- **Новая вкладка:** кнопка `data-agil-action="newtab"` и `openInNewTab()`
  (ссылка `getCallUrl()`); при заблокированном popup — toast с URL для копирования.
- **Мини-окно и PiP:** `minimize()/restore()/requestPictureInPicture()` — звонок
  висит поверх мессенджера, пока пользователь листает чаты.
- **Без шапки:** `layout.chrome='none'` + `inheritHostStyles` — только видео и
  контролы (включая fullscreen/newtab), прозрачный фон.

> Токен в `getCallUrl()` короткоживущий и попадает в URL: не логируйте ссылку,
> используйте минимальный TTL и `lock/kick` при утечке.

## Ассистент в звонке

In-call AI-агент с правами пользователя и spotlight-подсказками
([agil/core/docs/in-call-agent.md](../../core/docs/in-call-agent.md)). Панель — обычный чат:

- видимость: `config.session.inCallAgent.enabled` (по умолчанию включён).
  Права не скрывают панель — они фильтруют **действия**: агент не сможет
  включить запись, если у пользователя нет `recording`, и т.п.;
- `mode`:
  - `local` — офлайн-движок `localAssistantReply` из `@agil/protocol`, без сети
    (понимает «включи микрофон», «открой чат», «где запись?»);
  - `external`/`hybrid` — `POST /v1/rooms/:id/assistant` (Bearer join-token);
    на 501/404/ошибке — локальный fallback (hybrid; для external — если сервер
    local-only);
- действия исполняются через публичные методы инстанса (запись, mic/camera/
  screen, панели, блюр, minimize/fullscreen/new tab, invite link) только после
  `isAssistantToolAllowed`; запрещённое — тост с `denyMessage`;
- **spotlight**: overlay с затемнением, подсветка элемента по target
  (`mic`, `camera`, `screen`, `chat`, `files`, `participants`, `notes`,
  `settings`, `blur`, `recording`, `minimize`, `fullscreen`, `newtab`,
  `invite` или CSS-селектор), подсказка с шагами Далее/Назад/Понятно, Esc
  закрывает, звонок не блокируется; на корне `data-agil-spotlight="true"`, на
  элементе `[data-agil-spotlight-target]`.

```js
const call = await AGILCalls.mount('#call', {
  serverUrl,
  room,
  token,
  tenantId: 'demo',
});
// Панель ассистента открывается кнопкой «ассистент» (data-agil-action="assistant").
// Примеры запросов в панели: «включи запись», «открой чат», «где микрофон?».
// Настройки — session.inCallAgent в конфиге тенанта.
```

E2E-хуки: `data-agil-assistant-ready="true"` на корне,
`[data-agil-assistant-panel]`, `[data-agil-assistant-input]`,
`[data-agil-assistant-send]`, `[data-agil-assistant-message]`,
`[data-agil-assistant-answer]`, `[data-agil-spotlight-target]`.
Подключение внешней LLM (endpoint, HMAC, формат ответа):
[agil/core/docs/llm-integrations.md](../../core/docs/llm-integrations.md).

## Темы

Смешанные комбинации пресет×схема безопасны: при явном `scheme` виджет
пересобирает семантическую палитру из пресета нужной схемы (перенося бренд-цвета,
типографику, форму и фон) и **доводит** `primary`/`accent`/`textSecondary`/
`textMuted` до WCAG AA (≥4.5) на фоне/панелях/приподнятых поверхностях. Поэтому
«minimal + dark», «night + dark» и т.п. не дают невидимых ссылок. Хелперы
`themeForScheme()`, `normalizeTheme()`, `ensureReadableTheme()` экспортируются
виджетом (и `AGILCalls.themeForScheme/ensureReadableTheme` в SDK); `auto`
по-прежнему идёт через `displayTheme()` с учётом `prefers-color-scheme`.

Любой цвет/радиус/типографика — токены `ThemeTokens` из `@agil/protocol`.
Виджет выставляет их как `--agil-*` на корне и только ими пользуется; в CSS
нет захардкоженных цветов. Схема (`light|dark|auto`) учитывает
`prefers-color-scheme`; `data-theme`, `data-density`, `data-layout`, `data-chrome`
и `data-inherit-host` — на корне.

```ts
call.updateTheme({ colors: { primary: '#0b5fff' } });
call.setThemeScheme('dark');
```

## Режимы отображения и внешний чат (§22)

- `config.layout.chrome = 'full' | 'compact' | 'none'`.
  `none` — только сетка и контролы, прозрачный фон, чтобы звонок был частью
  страницы компании.
- `config.layout.inheritHostStyles = true` — наследовать шрифт/цвет хоста.
- `config.session.chat.ui`:
  - `builtin` — панель чата внутри виджета;
  - `external` — своей панели нет: входящие сообщения отдаются через
    `onEvent('chat')`/`onChat`, исходящие — через `call.sendChat()`;
  - `hidden` — чат выключен.
  Текущий режим: `data-agil-chat-mode` на корне, переключение — `setChatMode()`.
- **Провайдеры (§23).** Если `config.providers.chat.mode = 'external'` и
  `session.chat.ui` не переопределён явно, виджет работает как `chat.ui='external'`
  (чат компании, свой не рисует); `providers.chat.mode='disabled'` скрывает чат.
  Явный `session.chat.ui` из серверного конфига или `options.config` всегда
  приоритетнее. `providers.chat.mode` — это маршрутизация/хранение, его
  обрабатывает сервер; виджету достаточно UI-режима.
- `config.layout.minimized` — плавающая панель/пузырь (`mode`, `position`,
  `showSelfView`, `keepControls`), кнопка «свернуть» в контролах и
  `data-agil-minimized="true|false"` на корне. Звонок продолжается.
- `config.layout.persistAcrossPages` — handoff через `sessionStorage`
  (`{room, token, tenant, name, theme}`). В SPA виджет монтируется один раз и не
  разрушается; при полной навигации — `AGILCalls.resume()` / `mount(..., {resume:true})`.

### Фоны из внешнего провайдера

Если `config.providers.backgrounds.mode = 'external'`, виджет запрашивает список
у `GET /v1/tenants/:id/backgrounds` (`{backgrounds:[{id,name,url}], provider}`) и
показывает его в настройках. При недоступности провайдера или `mode:'builtin'`
используется `session.virtualBackgrounds`; пустой `url` по-прежнему означает
встроенный градиент из темы — звонок и фон работают автономно.

### Автономность

Всё работает без внешних сервисов: медиа/чат/файлы/запись/браузерный STT/
локальные заметки/темы/права/аудит — builtin. Интернет нужен только для TURN,
CDN MediaPipe (иначе degraded-блюр), AI/knowledge/integrity (по желанию) и CDN
статики. STT-провайдер компании может ответить 502 — тогда показывается
«сервис компании недоступен, используется встроенный» и включается браузерный
Web Speech.

## Права и безопасность

- `welcome.self.permissions` / `JoinRoomResponse.permissions` — единственный
  источник для UI: кнопки и панели без права скрываются (recording, fileShare,
  knowledgeAgent, screenShare, backgroundBlur/Replace, chat, translation, …).
  Серверное ограничение всё равно действует.
- Локация: страна/город показываются только модератору/хосту; GPS-координаты —
  только после явного согласия (чекбокс в настройках, `security.geo.gpsEnabled`),
  отправка `{type:'location', lat, lon, accuracyM, consent:true}`.
- Контент из сети (имена, чат, ответы ассистента) вставляется только через
  `textContent`; ссылки — только `http(s)` + `rel="noopener noreferrer"`.
- Ассистент: панель видна только при `permissions.includes('knowledgeAgent')` и
  включённом `session.knowledgeAgent`; запрос уходит по WS
  `{type:'assistant-query', id, question}`.

## Кастомизация лейаута (agil/core/docs/layout.md)

Контролы настраиваются в `TenantConfig.layout` и применяются на лету через
`updateConfig({layout})` (без перезагрузки):

| Поле | Значения | Смысл |
|---|---|---|
| `controlsStyle` | `bar` / `island` / `minimal` | классическая панель / плавающий «остров» / mic+camera+leave+«⋯» |
| `controlsAnchor` | `bottom-center` / `bottom-left` / `bottom-right` / `top-center` / `top-right` | позиция острова/панели |
| `hiddenControls` | `ControlId[]` | скрыть кнопки **визуально** (API и горячие клавиши работают) |
| `controlOrder` | `ControlId[]` | порядок; остальные — после в дефолтном порядке |
| `autoHideControls` | boolean | плавное автоскрытие по простою |
| `autoHideDelaySec` | 1..120 | задержка автоскрытия |

`ControlId`: `mic,camera,screen,blur,chat,hand,reactions,participants,notes,
transcript,assistant,recording,fullscreen,newtab,minimize,settings,leave`.

- **island** — полупрозрачная пилюля с blur/тенью: ключевые кнопки
  (mic, camera, screen, chat, leave) + «⋯» popover с остальными; anchor задаёт
  позицию, на мобильных сжимается.
- **minimal** — только mic, camera, leave + «⋯».
- **bar** — прежняя нижняя панель с учётом порядка/скрытия (кнопки панелей
  participants/notes/transcript остаются в шапке).
- **Плотность (call UI v3).** Панель адаптируется к размеру звонка: 1–2
  участника — mic/camera/screen/chat/leave; 3–4 — плюс hand/reactions; 5–8 —
  плюс captions; 9+ — плюс recording. Остальное — в одном «⋯». Панели
  participants/notes/transcript не дублируются (они в шапке), все кнопки
  44×44, `bar` на ≤640 px сворачивается в `island`. Геометрия и решения
  описаны в [call-ui-v3.md](../../core/docs/call-ui-v3.md); на корне —
  `data-agil-density="solo|duo|group|large"`.
- `hiddenControls` не отключает функцию: `toggleMic()`/шорткаты продолжают
  работать; для полного отключения — `features.*`/`accessPolicy`.
- data-атрибуты: `data-agil-controls-style`, `data-agil-controls-anchor`,
  `data-agil-control="mic|..."`, `[data-agil-more]`; контейнер контролов
  получает те же атрибуты стиля/позиции.
- В `chrome:'none'` контролы остаются (без шапки/фона виджета).
- Лейаут — только визуальный слой: состояние звонка при `updateConfig` не
  теряется.

## Вебинары и стримы (broadcast)

UI-часть масштабирования ([agil/core/docs/scaling.md](../../core/docs/scaling.md)):

- эффективный режим: `welcome.room.mediaMode` (`mesh|sfu|broadcast`), иначе
  `config.scale.mediaMode` + `scale.webinar` (enabled + mediaMode != mesh →
  broadcast). На корне: `data-agil-media-mode`, `data-agil-viewer`;
- для гостя в broadcast/host-only-publish виджет становится **receive-only**:
  mic/camera/screen/blur скрыты, локальные треки выключаются, в шапке бейдж
  «broadcast» и счётчик «N зрителей», в футере — «Вы зритель» + подсказка
  «Поднимите руку, чтобы задать вопрос» (если `webinar.raiseHandQueue`);
  чат, рука и реакции остаются (реакции — по `webinar.reactions`);
- host/moderator публикуют как обычно; в mesh-звонке ничего не меняется;
- **виртуализация**: рендерится не более 50 плиток, остальные — плитка
  «+N зрителей» (клик открывает участников), чтобы тысячи участников не
  вешали DOM. Число плиток/счётчик не влияют на медиа-плейн;
- moderated chat: при `webinar.chatMode='moderated'` зрителю после отправки
  показывается «Сообщение отправлено на модерацию» (и при ошибке/статусе от
  сервера про модерацию).

Серверный receive-only и SFU/broadcast-медиаплейн — отдельный этап (в MVP
реально работает mesh до 8; UI готов к broadcast заранее).

## Ограничения (честно)

- **Mesh**: до 8 пиров (константа движка). Для большего числа нужен SFU.
- **Блюр/замена фона**: сегментация грузится с CDN
  (`@mediapipe/tasks-vision@0.10.14` + модель selfie_segmenter). Если CDN
  недоступен — включается упрощённое размытие/фон с флагом `degraded`
  (`getStats().blurDegraded`) и предупреждением.
- **Субтитры**: браузерный Web Speech API — только Chrome/Edge. Серверный STT
  (`POST /v1/stt/transcribe`) — fallback, только Chromium; если сервер отвечает
  501, показывается «STT недоступен».
- **Liveness/anti-deepfake**: браузерная проверка вероятностная; провал
  liveness не обвиняет участника (статус `unknown`), «suspicious» ставится
  только по аномалиям таймингов кадров.
- **Запись**: canvas-микс (сетка) + AudioContext; формат webm/mp4 по
  возможностям браузера; при `storeOnServer` — `POST /v1/recordings`.
- **Document PiP**: только Chromium; иначе fallback на плавающее окно.

## Стабильные e2e-хуки

```
[data-agil-root][data-state][data-agil-scheme][data-agil-quality][data-agil-chat-mode][data-agil-minimized]
[data-agil-tile][data-participant-id][data-self]
[data-agil-chat-input], [data-agil-chat-send], [data-agil-chat-message][data-message-id]
[data-agil-participants-count], [data-agil-connection]
[data-agil-action="mic|camera|screen|blur|chat|hand|leave|settings|recording|assistant|captions|minimize|restore|pip"]
```

## Скрипты

```bash
npm run typecheck -w @agil/calls-widget
npm run build -w @agil/calls-widget
npm run dev -w @agil/calls-widget   # vite build --watch
```
