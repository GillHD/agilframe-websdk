# AgilFrame Web SDK

Виджет, SDK, Web Component и веб-примеры.

[AgilFrame](https://github.com/users/GillHD/projects/1) · [Core и документация](https://github.com/GillHD/agilframe-core)

Исходная версия компонентов: [e49af79](https://github.com/GillHD/agilframe-core/commit/e49af79496ed8d4e200f520e2f7dd162bf789a7d). [Лицензия](LICENSE) · [Уведомления](NOTICE)

## Запуск

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run dev
```

В `agil/websdk/` находятся виджет, SDK, Web Component и демо. Для автономной сборки здесь также есть закреплённые общие контракты и модуль рендера Wiki. Vite запускает демо на порту 5173. Для звонков запустите [Core](https://github.com/GillHD/agilframe-core) и при необходимости задайте `AGIL_SERVER_URL`. По умолчанию демо использует `http://localhost:8787`.

[Интеграция SDK](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/sdk.md) · [Веб-пример](https://github.com/GillHD/agilframe-examples)
