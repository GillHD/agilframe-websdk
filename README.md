# AgilFrame Web SDK

**Русский** · [English](README.en.md)

Веб-компоненты AgilFrame для встраивания звонков в браузерное приложение. Выберите готовый интерфейс, подключите SDK к своему сценарию или вставьте веб-компонент в HTML.

[Общий проект](https://github.com/GillHD/agilframe) · [AgilFrame Core](https://github.com/GillHD/agilframe-core) · [Пример встраивания](https://github.com/GillHD/agilframe-examples)

## Компоненты

| Компонент | Назначение |
| --- | --- |
| [Виджет](agil/websdk/widget/README.md) | Интерфейс звонка, медиадвижок и управление устройствами |
| [SDK](agil/websdk/sdk/README.md) | JavaScript API `AGILCalls` и ESM-сборка для интеграции в веб-приложение |
| [Веб-компонент](agil/websdk/embed/README.md) | Элемент `<agil-call>` для встраивания звонка через iframe |
| [Демо](agil/websdk/demo/) | Страницы звонка, прямого эфира и примера собственного интерфейса |

Репозиторий включает версии общих контрактов и модуля отображения Wiki, необходимые для самостоятельной сборки. [Исходная версия компонентов](https://github.com/GillHD/agilframe-core/commit/e49af79496ed8d4e200f520e2f7dd162bf789a7d)

## Сборка и проверка

Установите Node.js 22 или новее. Выполните из корня репозитория:

```sh
npm ci
npm run build
npm run typecheck
npm test
```

Для интерактивной проверки запустите Core и выполните `npm run dev`. Демо откроется по адресу `http://localhost:5173`. Vite по умолчанию обращается к Core по адресу `http://localhost:8787`. Чтобы подключить другой экземпляр, перед запуском задайте `AGIL_SERVER_URL`. [Руководство по интеграции](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/sdk.md)

## Вклад и лицензия

[Правила участия](CONTRIBUTING.md) · [Безопасность](SECURITY.md) · [Лицензия](LICENSE) · [Уведомления](NOTICE)
