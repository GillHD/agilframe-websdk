/**
 * Shadow-DOM stylesheet.
 *
 * No external CSS is required; all colors are local custom properties and the
 * chrome follows the `theme` attribute (`light`/`dark`/`auto`). The iframe is
 * always the only interactive surface during a call.
 */
export const EMBED_CSS = /* css */ `
:host {
  --agil-embed-accent: #2563eb;
  --agil-embed-accent-hover: #1d4ed8;
  --agil-embed-surface: #ffffff;
  --agil-embed-surface-soft: #f3f6fb;
  --agil-embed-text: #0f172a;
  --agil-embed-muted: #5b6577;
  --agil-embed-border: rgba(15, 23, 42, 0.14);
  --agil-embed-shadow: 0 28px 80px rgba(15, 23, 42, 0.32);
  --agil-embed-radius: 16px;
  --agil-embed-height: 640px;
  display: block;
  position: relative;
  box-sizing: border-box;
  color: var(--agil-embed-text);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  line-height: 1.4;
  color-scheme: light;
}
:host([hidden]) { display: none !important; }
*, *::before, *::after { box-sizing: border-box; }

.root {
  --agil-embed-surface: #ffffff;
  --agil-embed-surface-soft: #f3f6fb;
  --agil-embed-text: #0f172a;
  --agil-embed-muted: #5b6577;
  --agil-embed-border: rgba(15, 23, 42, 0.14);
  color-scheme: light;
  position: relative;
  color: var(--agil-embed-text);
}
.root[data-theme="dark"] {
  --agil-embed-surface: #0f172a;
  --agil-embed-surface-soft: #16213a;
  --agil-embed-text: #f8fafc;
  --agil-embed-muted: #a7b3c9;
  --agil-embed-border: rgba(248, 250, 252, 0.16);
  color-scheme: dark;
}
@media (prefers-color-scheme: dark) {
  .root:not([data-theme="light"]) {
    --agil-embed-surface: #0f172a;
    --agil-embed-surface-soft: #16213a;
    --agil-embed-text: #f8fafc;
    --agil-embed-muted: #a7b3c9;
    --agil-embed-border: rgba(248, 250, 252, 0.16);
    color-scheme: dark;
  }
}

.stage {
  position: relative;
  width: 100%;
  height: var(--agil-embed-height, 640px);
  overflow: hidden;
  border-radius: var(--agil-embed-radius);
  background: #0b1220;
  isolation: isolate;
}
.stage.inline-stage { max-width: 100%; }
.stage.dialog-stage { height: 100%; border-radius: 0; }

.frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
}

.status {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
  text-align: center;
  background: var(--agil-embed-surface);
  color: var(--agil-embed-muted);
  font-size: 14px;
}
.status[hidden] { display: none; }
.spinner {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid var(--agil-embed-border);
  border-top-color: var(--agil-embed-accent);
  animation: agil-spin 0.8s linear infinite;
}
@keyframes agil-spin { to { transform: rotate(360deg); } }

.error {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--agil-embed-surface);
  color: var(--agil-embed-text);
}
.error[hidden] { display: none; }
.error-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 420px;
  text-align: center;
}
.error-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--agil-embed-surface-soft);
  color: var(--agil-embed-accent);
}
.error-title { margin: 2px 0 0; font-size: 17px; font-weight: 650; }
.error-message { margin: 0; color: var(--agil-embed-muted); font-size: 13.5px; overflow-wrap: anywhere; }
.retry {
  margin-top: 8px;
  min-height: 40px;
  padding: 0 18px;
  border: 0;
  border-radius: 10px;
  background: var(--agil-embed-accent);
  color: #ffffff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.retry:hover { background: var(--agil-embed-accent-hover); }

button:focus-visible {
  outline: 2px solid var(--agil-embed-accent);
  outline-offset: 2px;
}

.launcher {
  position: fixed;
  right: max(20px, env(safe-area-inset-right));
  bottom: max(20px, env(safe-area-inset-bottom));
  z-index: 2147483000;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 50%;
  background: var(--agil-embed-accent);
  color: #ffffff;
  box-shadow: 0 14px 36px rgba(15, 23, 42, 0.36);
  cursor: pointer;
  transition: transform 0.15s ease, background 0.15s ease;
}
.launcher:hover { background: var(--agil-embed-accent-hover); transform: translateY(-1px); }
.launcher:active { transform: translateY(0); }
.launcher svg { width: 24px; height: 24px; }
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

.dialog {
  margin: auto;
  padding: 0;
  width: min(1000px, calc(100vw - 40px));
  height: min(760px, calc(100dvh - 40px));
  max-width: none;
  max-height: none;
  overflow: hidden;
  border: 1px solid var(--agil-embed-border);
  border-radius: 18px;
  background: var(--agil-embed-surface);
  color: var(--agil-embed-text);
  box-shadow: var(--agil-embed-shadow);
}
.dialog[open] { display: flex; flex-direction: column; }
.dialog::backdrop { background: rgba(4, 8, 18, 0.62); backdrop-filter: blur(6px); }
.dialog-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 52px;
  padding: 0 8px 0 16px;
  border-bottom: 1px solid var(--agil-embed-border);
}
.dialog-title { font-size: 14px; font-weight: 600; letter-spacing: 0.01em; }
.close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--agil-embed-muted);
  cursor: pointer;
}
.close:hover { background: var(--agil-embed-surface-soft); color: var(--agil-embed-text); }
.close svg { width: 20px; height: 20px; }

@media (max-width: 640px) {
  .dialog {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100dvh;
    max-width: none;
    max-height: none;
    margin: 0;
    border: 0;
    border-radius: 0;
  }
  .dialog-header {
    min-height: calc(52px + env(safe-area-inset-top));
    padding-top: env(safe-area-inset-top);
  }
  .dialog-stage { padding-bottom: env(safe-area-inset-bottom); }
  .launcher {
    right: max(16px, env(safe-area-inset-right));
    bottom: max(16px, env(safe-area-inset-bottom));
  }
  .error { padding: 20px; }
}

@media (prefers-reduced-motion: reduce) {
  .spinner { animation: none; border-top-color: var(--agil-embed-accent); }
  .launcher, .launcher:hover { transition: none; transform: none; }
}
`;
