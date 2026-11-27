/**
 * Component chrome strings. Only the two locales supported by `embed.html`
 * are translated; everything else falls back to English.
 */
import type { AgilLanguage } from './types.js';

export interface EmbedStrings {
  iframeTitle: string;
  launcher: string;
  dialogTitle: string;
  close: string;
  connecting: string;
  errorTitle: string;
  retry: string;
  missingRoom: string;
  invalidConfig: string;
  loadTimeout: string;
  bridgeTimeout: string;
  destroyed: string;
}

const EN: EmbedStrings = {
  iframeTitle: 'AgilFrame video call',
  launcher: 'Start a video call',
  dialogTitle: 'Video call',
  close: 'Close',
  connecting: 'Connecting to the call…',
  errorTitle: 'Could not load the call',
  retry: 'Try again',
  missingRoom: 'The "room" attribute is required.',
  invalidConfig: 'The embed configuration is invalid.',
  loadTimeout: 'The call page did not load. Check the server URL, network and CSP settings.',
  bridgeTimeout: 'The call page loaded but did not answer. Check that /embed.html is served and allowed to be framed.',
  destroyed: 'This call element has been destroyed.',
};

const RU: EmbedStrings = {
  iframeTitle: 'Видеозвонок AgilFrame',
  launcher: 'Начать видеозвонок',
  dialogTitle: 'Видеозвонок',
  close: 'Закрыть',
  connecting: 'Подключение к звонку…',
  errorTitle: 'Не удалось загрузить звонок',
  retry: 'Повторить',
  missingRoom: 'Не указан обязательный атрибут "room".',
  invalidConfig: 'Некорректная конфигурация встраивания.',
  loadTimeout: 'Страница звонка не загрузилась. Проверьте server-url, сеть и CSP.',
  bridgeTimeout: 'Страница звонка загрузилась, но не ответила. Проверьте /embed.html и разрешение на встраивание.',
  destroyed: 'Этот элемент звонка уже уничтожен.',
};

/** Returns chrome strings for a language attribute or the browser locale. */
export function stringsFor(language: AgilLanguage | null | undefined): EmbedStrings {
  if (typeof language === 'string' && language.toLowerCase().startsWith('ru')) return RU;
  if (typeof language === 'string' && language.trim()) return EN;
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('ru')) {
    return RU;
  }
  return EN;
}
