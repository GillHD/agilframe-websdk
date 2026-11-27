import { currentLocale } from './i18n.js';

const dateTimeOptions: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
};
const dateTimeFormatters = {
  ru: new Intl.DateTimeFormat('ru-RU', dateTimeOptions),
  en: new Intl.DateTimeFormat('en-GB', dateTimeOptions),
};

const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const shortDateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const numberFormatters = { ru: new Intl.NumberFormat('ru-RU'), en: new Intl.NumberFormat('en-GB') };
const englishRelativeTime = new Intl.RelativeTimeFormat('en-GB', { style: 'short' });

export function formatDateTime(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  try {
    return dateTimeFormatters[currentLocale()].format(new Date(ts));
  } catch {
    return '—';
  }
}

export function formatTime(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  try {
    return timeFormatter.format(new Date(ts));
  } catch {
    return '—';
  }
}

export function formatShortDate(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  try {
    return shortDateFormatter.format(new Date(ts));
  } catch {
    return '—';
  }
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return numberFormatters[currentLocale()].format(value);
}

export function pad2(value: number): string {
  return String(Math.max(0, Math.floor(value))).padStart(2, '0');
}

/** Seconds → mm:ss or h:mm:ss (call/recording timeline). */
export function formatClock(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) return '—';
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return hrs > 0 ? `${hrs}:${pad2(mins)}:${pad2(secs)}` : `${pad2(mins)}:${pad2(secs)}`;
}

/** Human duration: «12 мин 5 с» / «2 ч 13 мин». */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) return '—';
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  const restSec = seconds % 60;
  if (minutes < 60) return restSec > 0 ? `${minutes} мин ${restSec} с` : `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const restMin = minutes % 60;
  return restMin > 0 ? `${hours} ч ${restMin} мин` : `${hours} ч`;
}

export function formatUptime(totalSeconds: number | null | undefined): string {
  return formatDuration(totalSeconds);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  const [baseUnit, ...units] = currentLocale() === 'en' ? ['B', 'KB', 'MB', 'GB', 'TB'] : ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  if (bytes < 1024) return `${bytes} ${baseUnit}`;
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[index] ?? baseUnit}`;
}

/** Short relative time in the dashboard language. */
export function relativeTime(ts: number | null | undefined, now = Date.now()): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const diffSec = Math.round((now - ts) / 1000);
  if (diffSec < 0) return formatDateTime(ts);
  if (currentLocale() === 'en') {
    if (diffSec < 10) return 'just now';
    if (diffSec < 60) return englishRelativeTime.format(-diffSec, 'second');
    if (diffSec < 3600) return englishRelativeTime.format(-Math.floor(diffSec / 60), 'minute');
    if (diffSec < 86_400) return englishRelativeTime.format(-Math.floor(diffSec / 3600), 'hour');
    if (diffSec < 604_800) return englishRelativeTime.format(-Math.floor(diffSec / 86_400), 'day');
    return formatDateTime(ts);
  }
  if (diffSec < 10) return 'только что';
  if (diffSec < 60) return `${diffSec} с назад`;
  const minutes = Math.floor(diffSec / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} дн назад`;
  return formatShortDate(ts);
}

/** ISO-3166 alpha-2 → regional-indicator flag emoji. */
export function flagEmoji(country: string | null | undefined): string {
  if (!country || !/^[a-z]{2}$/i.test(country)) return '🏳️';
  const code = country.toUpperCase();
  return String.fromCodePoint(...[...code].map((char) => 0x1f1e6 + char.charCodeAt(0) - 65));
}

/** ISO-3166 alpha-2 → readable Russian region name, without flag emoji duplication. */
export function countryLabel(country: string | null | undefined): string {
  if (!country) return 'Не определена';
  const code = country.toUpperCase();
  try {
    const name = new Intl.DisplayNames(['ru'], { type: 'region' }).of(code);
    if (typeof name === 'string' && name && name !== code) return `${name} (${code})`;
  } catch {
    /* old browsers without Intl.DisplayNames */
  }
  return code;
}

export function plural(count: number, one: string, few: string, many: string): string {
  const abs = Math.abs(count) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '?').slice(0, 2);
  return `${(parts[0] ?? '?').slice(0, 1)}${(parts[1] ?? '?').slice(0, 1)}`;
}

/** Local origin without a trailing slash (safe when location is unavailable). */
export function currentOrigin(): string {
  try {
    return window.location.origin;
  } catch {
    return 'http://localhost:8787';
  }
}
