# AgilFrame Web SDK packages

[Repository overview](../../README.en.md) · [Обзор на русском](../../README.md)

This directory contains the call widget, the script SDK, the
framework-independent Web Component, and demo pages for browser integrations.

```
websdk/
├─ widget   @agil/calls-widget        embeddable UI + WebRTC/SFU engine (ES module + CSS)
├─ sdk      @agil/calls-sdk           agil-calls.js — global AGILCalls, iframe mode
├─ embed    @agil/calls-embed         <agil-call> Web Component + postMessage bridge
└─ demo     @agil/demo                example pages, including /embed.html
```

## Consuming core contracts

All three packages import the shared contracts from `agil/core/packages/protocol`
(`@agil/protocol`) from source in Vite/TS, so the protocol package must be built
before a production bundle (`npm run build:protocol`).

Relative source aliases (see each `vite.config.ts` / `tsconfig.json`):

```
agil/websdk/widget  ->  ../../core/packages/protocol/src/index.ts
agil/websdk/sdk     ->  ../../core/packages/protocol, ../widget
agil/websdk/demo    ->  ../../core/packages/protocol, ../widget, ../sdk
```

## Commands (from the repository root)

```bash
npm run build:widget
npm run build:sdk
npm run build:embed
npm run build:demo
npm run dev                       # demo on http://localhost:5173
npm test -w @agil/calls-widget
npm test -w @agil/calls-embed
```

Build artifacts: `dist/` inside each package (gitignored). The server serves
`demo/dist` at `/`, `sdk/dist` at `/sdk/` and `widget/dist` at `/widget/` unless
overridden by `AGIL_STATIC_DIR` / `AGIL_SDK_DIR` / `AGIL_WIDGET_DIR`.
