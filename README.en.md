# AgilFrame Web SDK

[Русский](README.md) · **English**

AgilFrame components for embedding calls in browser applications. Choose the ready-made call interface, integrate the SDK into your own workflow, or add the Web Component to your HTML.

[Project overview](https://github.com/GillHD/agilframe) · [AgilFrame Core](https://github.com/GillHD/agilframe-core) · [Embedding example](https://github.com/GillHD/agilframe-examples)

## Components

| Component | Purpose |
| --- | --- |
| [Call widget](agil/websdk/widget/README.en.md) | Call interface, media engine, and device controls |
| [SDK](agil/websdk/sdk/README.en.md) | The `AGILCalls` JavaScript API and an ESM build for web applications |
| [Web Component](agil/websdk/embed/README.md) | The `<agil-call>` element for embedding a call in an iframe |
| [Demo](agil/websdk/demo/) | Call, livestream, and custom-interface example pages |

This repository includes the versions of the shared contracts and Wiki renderer required for a standalone build. [Original component revision](https://github.com/GillHD/agilframe-core/commit/e49af79496ed8d4e200f520e2f7dd162bf789a7d)

## Build and test

Install Node.js 22 or later. Run these commands from the repository root.

```sh
npm ci
npm run build
npm run typecheck
npm test
```

For interactive testing, start Core and run `npm run dev`. The demo is available at `http://localhost:5173`. Vite uses `http://localhost:8787` for Core by default. To use another instance, set `AGIL_SERVER_URL` before starting the demo. [Integration guide](https://github.com/GillHD/agilframe-core/blob/main/agil/core/docs/sdk.md)

## Contributing and license

[Contributing](CONTRIBUTING.en.md) · [Security](SECURITY.en.md) · [License](LICENSE) · [Notices](NOTICE)
