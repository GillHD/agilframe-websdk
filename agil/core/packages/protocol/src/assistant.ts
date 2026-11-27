/**
 * In-call AI assistant with user-scoped tool calling and UI "spotlight" coach.
 *
 * The assistant acts *on behalf of the connected user*: every tool call is
 * checked against the user's effective permissions (`access.ts`), so an agent can
 * start recording only if that user may record, open chat only if chat is
 * allowed, etc. The server re-checks the same rules — the client check is UX only.
 *
 * Spotlight: the assistant can dim the call UI and highlight the exact control
 * the user must press ("нажмите сюда"), optionally as a multi-step tour.
 */
import { z } from 'zod';
import type { FeatureKey } from './config.js';
import type { Role } from './signaling.js';

export const assistantTools = [
  'start_recording',
  'stop_recording',
  'toggle_mic',
  'toggle_camera',
  'toggle_screen_share',
  'raise_hand',
  'send_chat',
  'open_chat',
  'open_files',
  'open_participants',
  'open_notes',
  'open_settings',
  'set_blur',
  'minimize',
  'restore',
  'request_fullscreen',
  'open_new_tab',
  'copy_invite_link',
] as const;

export type AssistantTool = (typeof assistantTools)[number];
export const assistantToolSchema = z.enum(assistantTools);

export interface AssistantAction {
  tool: AssistantTool;
  args?: Record<string, unknown>;
}

export const assistantActionSchema = z.object({
  tool: assistantToolSchema,
  args: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Spotlight target: either a logical control name (`mic`, `chat`, `recording`, …)
 * or a CSS selector inside the widget. The widget maps names to its controls.
 */
export interface AssistantSpotlight {
  target: string;
  text: string;
  /** Order for multi-step tours. */
  step?: number;
}

export const assistantSpotlightSchema = z.object({
  target: z.string().min(1).max(120),
  text: z.string().min(1).max(300),
  step: z.number().int().min(0).max(20).optional(),
});

export interface AssistantReply {
  id: string;
  text: string;
  actions: AssistantAction[];
  spotlight: AssistantSpotlight[];
  source: 'local' | 'external';
  securityPolicy?: { version: string; environment: 'production' | 'test' };
  ts: number;
}

export const assistantReplySchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().max(4000),
  actions: z.array(assistantActionSchema).max(10),
  spotlight: z.array(assistantSpotlightSchema).max(20),
  source: z.enum(['local', 'external']),
  securityPolicy: z.object({ version: z.string().min(1).max(48), environment: z.enum(['production', 'test']) }).optional(),
  ts: z.number(),
});

export interface AssistantToolRequirements {
  /** Feature permission required to execute the tool. */
  feature?: FeatureKey;
  /** Roles allowed to execute the tool (empty/undefined = any role). */
  roles?: Role[];
}

/** Maps an assistant tool to the permission it needs (shared by client and server). */
export function assistantToolRequirements(tool: AssistantTool): AssistantToolRequirements {
  switch (tool) {
    case 'start_recording':
    case 'stop_recording':
      return { feature: 'recording', roles: ['host', 'moderator'] };
    case 'toggle_screen_share':
      return { feature: 'screenShare' };
    case 'send_chat':
    case 'open_chat':
      return { feature: 'chat' };
    case 'open_files':
      return { feature: 'fileShare' };
    case 'open_participants':
      return { feature: 'participantList' };
    case 'open_notes':
      return { feature: 'meetingNotes' };
    case 'open_settings':
      return { feature: 'deviceSettings' };
    case 'set_blur':
      return { feature: 'backgroundBlur' };
    case 'request_fullscreen':
      return { feature: 'fullscreen' };
    case 'copy_invite_link':
      return { feature: 'inviteLink' };
    case 'raise_hand':
      return { feature: 'handRaise' };
    case 'minimize':
    case 'restore':
    case 'open_new_tab':
    case 'toggle_mic':
    case 'toggle_camera':
      return {};
    default:
      return {};
  }
}

export interface AssistantAccessContext {
  role: Role;
  permissions: readonly string[];
  tools?: readonly AssistantTool[];
}

/** True when the user may execute the tool (server must use the same check). */
export function isAssistantToolAllowed(tool: AssistantTool, context: AssistantAccessContext): boolean {
  if (context.tools && !context.tools.includes(tool)) return false;
  const requirements = assistantToolRequirements(tool);
  if (requirements.roles && requirements.roles.length > 0 && !requirements.roles.includes(context.role)) {
    return false;
  }
  if (requirements.feature && !context.permissions.includes(requirements.feature)) {
    return false;
  }
  return true;
}

/** Project external suggestions onto the arguments the widget actually consumes. */
export function sanitizeAssistantAction(action: AssistantAction): AssistantAction | null {
  if (action.tool === 'send_chat') {
    const text = typeof action.args?.text === 'string' ? action.args.text.trim().slice(0, 500) : '';
    return text ? { tool: action.tool, args: { text } } : null;
  }
  if (action.tool === 'set_blur') {
    const mode = action.args?.mode;
    if (mode !== undefined && mode !== 'off' && mode !== 'blur') return null;
    if (mode) return { tool: action.tool, args: { mode } };
  }
  return { tool: action.tool };
}

export function assistantActionNeedsConfirmation(tool: AssistantTool): boolean {
  return tool === 'start_recording' || tool === 'stop_recording' || tool === 'toggle_screen_share' ||
    tool === 'toggle_mic' || tool === 'toggle_camera' || tool === 'send_chat' || tool === 'copy_invite_link' ||
    tool === 'open_new_tab' || tool === 'raise_hand' || tool === 'set_blur';
}

const ASSISTANT_SPOTLIGHT_TOOLS: Record<string, AssistantTool> = {
  mic: 'toggle_mic', camera: 'toggle_camera', screen: 'toggle_screen_share', hand: 'raise_hand',
  recording: 'start_recording', chat: 'open_chat', files: 'open_files', participants: 'open_participants',
  notes: 'open_notes', settings: 'open_settings', blur: 'set_blur', minimize: 'minimize',
  fullscreen: 'request_fullscreen', newtab: 'open_new_tab', invite: 'copy_invite_link',
};

export function isAssistantSpotlightAllowed(target: string, context: AssistantAccessContext): boolean {
  const tool = Object.hasOwn(ASSISTANT_SPOTLIGHT_TOOLS, target) ? ASSISTANT_SPOTLIGHT_TOOLS[target] : undefined;
  return Boolean(tool && isAssistantToolAllowed(tool, context));
}

/** Filters model-proposed actions down to what the user can actually do. */
export function filterAssistantActions(
  actions: AssistantAction[],
  context: AssistantAccessContext,
): { allowed: AssistantAction[]; denied: AssistantAction[] } {
  const allowed: AssistantAction[] = [];
  const denied: AssistantAction[] = [];
  for (const action of actions.slice(0, 10)) {
    if (isAssistantToolAllowed(action.tool, context)) allowed.push(action);
    else denied.push(action);
  }
  return { allowed, denied };
}

/* ------------------------------------------------------------------ */
/* Wire format for an external in-call agent (any LLM behind a proxy)  */
/* ------------------------------------------------------------------ */

export const inCallAssistantRequestSchema = z.object({
  requestId: z.string().min(1).max(128),
  tenantId: z.string().min(1),
  roomId: z.string().min(1),
  participant: z.object({
    id: z.string(),
    name: z.string().max(120),
    role: z.enum(['host', 'moderator', 'guest']),
    permissions: z.array(z.string()).max(60),
  }),
  text: z.string().min(1).max(2000),
  locale: z.enum(['ru', 'en']).optional(),
  model: z.string().max(120).optional(),
  contextCompression: z.object({ enabled: z.boolean(), preserveSystemPrompt: z.literal(true) }).optional(),
  tools: z.array(assistantToolSchema).max(40),
  /** Compact, non-sensitive call state (no media, no chat history by default). */
  state: z
    .object({
      participants: z.number().int().min(0).max(200).optional(),
      recording: z.boolean().optional(),
      mic: z.enum(['on', 'off']).optional(),
      camera: z.enum(['on', 'off']).optional(),
      screenSharing: z.boolean().optional(),
      chatOpen: z.boolean().optional(),
      layoutMode: z.string().max(40).optional(),
      qualityTier: z.string().max(40).optional(),
    })
    .optional(),
  systemPrompt: z.string().max(16000).optional(),
});

export type InCallAssistantRequest = z.infer<typeof inCallAssistantRequestSchema>;

export const inCallAssistantResponseSchema = z.object({
  requestId: z.string().min(1).max(128),
  text: z.string().max(4000),
  actions: z.array(assistantActionSchema).max(10).default([]),
  spotlight: z.array(assistantSpotlightSchema).max(20).default([]),
  model: z.string().max(120).optional(),
  provider: z.string().max(120).optional(),
});

export type InCallAssistantResponse = z.infer<typeof inCallAssistantResponseSchema>;

/** Validates untrusted LLM output. Returns null when unusable. */
export function parseInCallAssistantResponse(raw: unknown): InCallAssistantResponse | null {
  const result = inCallAssistantResponseSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/* ------------------------------------------------------------------ */
/* Builtin (offline) assistant: deterministic intent matching          */
/* ------------------------------------------------------------------ */

export interface LocalAssistantContext {
  locale: 'ru' | 'en';
  role: Role;
  permissions: readonly string[];
  /** Tools enabled by the tenant config (`session.inCallAgent.allowedTools`). */
  tools: readonly AssistantTool[];
  /** Whether the tenant allows the UI spotlight. */
  spotlight: boolean;
  /** Compact state used to answer "what is already on". */
  state?: {
    recording?: boolean;
    mic?: 'on' | 'off';
    camera?: 'on' | 'off';
    screenSharing?: boolean;
    chatOpen?: boolean;
  };
}

interface IntentRule {
  tool: AssistantTool;
  /** Lower-case keywords (ru/en). */
  keywords: string[];
  /** Logical spotlight target for the control that performs the action. */
  spotlightTarget: string;
  ru: { action: string; help: string };
  en: { action: string; help: string };
}

const INTENT_RULES: IntentRule[] = [
  {
    tool: 'start_recording',
    keywords: ['запиши', 'запись', 'записать', 'record', 'recording', 'start recording'],
    spotlightTarget: 'recording',
    ru: { action: 'Начинаю запись звонка.', help: 'Кнопка записи находится в панели управления внизу.' },
    en: { action: 'Starting the call recording.', help: 'The recording button is in the bottom control bar.' },
  },
  {
    tool: 'toggle_screen_share',
    keywords: ['экран', 'демонстрац', 'покажи экран', 'screen', 'share screen', 'present'],
    spotlightTarget: 'screen',
    ru: { action: 'Включаю демонстрацию экрана.', help: 'Нажмите «Показать экран» в панели управления.' },
    en: { action: 'Starting screen sharing.', help: 'Press “Share screen” in the control bar.' },
  },
  {
    tool: 'raise_hand',
    keywords: ['опусти руку', 'опустить руку', 'lower hand', 'hand down'],
    spotlightTarget: 'hand',
    ru: { action: 'Опускаю руку.', help: 'Кнопка «Поднять руку» находится в панели управления.' },
    en: { action: 'Lowering your hand.', help: 'The “Raise hand” button is in the control bar.' },
  },
  {
    tool: 'raise_hand',
    keywords: ['подними руку', 'поднять руку', 'поднят руку', 'руку', 'raise hand', 'hand up'],
    spotlightTarget: 'hand',
    ru: { action: 'Поднимаю руку.', help: 'Кнопка «Поднять руку» находится в панели управления.' },
    en: { action: 'Raising your hand.', help: 'The “Raise hand” button is in the control bar.' },
  },
  {
    tool: 'toggle_mic',
    keywords: ['микрофон', 'микро', 'mute', 'unmute', 'microphone', 'mic', 'звук'],
    spotlightTarget: 'mic',
    ru: { action: 'Переключаю микрофон.', help: 'Микрофон — первая кнопка в панели управления.' },
    en: { action: 'Toggling the microphone.', help: 'The microphone is the first control in the bar.' },
  },
  {
    tool: 'toggle_camera',
    keywords: ['камер', 'видео', 'camera', 'video on'],
    spotlightTarget: 'camera',
    ru: { action: 'Переключаю камеру.', help: 'Камера — вторая кнопка в панели управления.' },
    en: { action: 'Toggling the camera.', help: 'The camera is the second control in the bar.' },
  },
  {
    tool: 'open_chat',
    keywords: ['чат', 'chat', 'сообщени', 'messages'],
    spotlightTarget: 'chat',
    ru: { action: 'Открываю чат звонка.', help: 'Чат открывается кнопкой с иконкой сообщения.' },
    en: { action: 'Opening the in-call chat.', help: 'Use the message icon button to open chat.' },
  },
  {
    tool: 'open_files',
    keywords: ['файл', 'file', 'вложени', 'attachment'],
    spotlightTarget: 'files',
    ru: { action: 'Открываю передачу файлов.', help: 'Файлы отправляются из чата или панели вложений.' },
    en: { action: 'Opening file sharing.', help: 'Files are sent from chat or the attachments panel.' },
  },
  {
    tool: 'open_participants',
    keywords: ['участник', 'participants', 'кто в звонке', 'люди'],
    spotlightTarget: 'participants',
    ru: { action: 'Открываю список участников.', help: 'Список участников — кнопка с иконкой людей.' },
    en: { action: 'Opening the participants list.', help: 'Use the people icon to open participants.' },
  },
  {
    tool: 'open_notes',
    keywords: ['заметк', 'notes', 'транскрипт', 'transcript', 'итог', 'summary'],
    spotlightTarget: 'notes',
    ru: { action: 'Открываю заметки и транскрипт.', help: 'Заметки и выдержки — в панели «Заметки».' },
    en: { action: 'Opening notes and transcript.', help: 'Notes and excerpts live in the Notes panel.' },
  },
  {
    tool: 'open_settings',
    keywords: ['настройк', 'settings', 'устройств', 'devices', 'камера выбрать'],
    spotlightTarget: 'settings',
    ru: { action: 'Открываю настройки.', help: 'Настройки устройств — шестерёнка в панели управления.' },
    en: { action: 'Opening settings.', help: 'Device settings live behind the gear button.' },
  },
  {
    tool: 'set_blur',
    keywords: ['блюр', 'фон', 'blur', 'background'],
    spotlightTarget: 'blur',
    ru: { action: 'Включаю размытие фона.', help: 'Размытие/замена фона — кнопка с иконкой фона.' },
    en: { action: 'Enabling background blur.', help: 'Background blur/replace is the background icon button.' },
  },
  {
    tool: 'minimize',
    keywords: ['сверни', 'мини', 'minimize', 'маленькое окно'],
    spotlightTarget: 'minimize',
    ru: { action: 'Сворачиваю звонок в мини-окно.', help: 'Свернуть звонок можно кнопкой минимизации.' },
    en: { action: 'Minimizing the call.', help: 'Use the minimize button to shrink the call.' },
  },
  {
    tool: 'request_fullscreen',
    keywords: ['полный экран', 'fullscreen', 'на весь экран'],
    spotlightTarget: 'fullscreen',
    ru: { action: 'Открываю звонок на весь экран.', help: 'Полный экран — кнопка в панели управления.' },
    en: { action: 'Opening the call fullscreen.', help: 'Fullscreen is available in the control bar.' },
  },
  {
    tool: 'open_new_tab',
    keywords: ['новой вкладк', 'новая вкладка', 'new tab', 'открой вкладку'],
    spotlightTarget: 'newtab',
    ru: { action: 'Открываю звонок в новой вкладке.', help: 'Новая вкладка — кнопка рядом с полным экраном.' },
    en: { action: 'Opening the call in a new tab.', help: 'New tab is next to the fullscreen button.' },
  },
  {
    tool: 'copy_invite_link',
    keywords: ['ссылк', 'пригласи', 'invite', 'link'],
    spotlightTarget: 'invite',
    ru: { action: 'Копирую ссылку-приглашение.', help: 'Ссылка-приглашение — в меню комнаты.' },
    en: { action: 'Copying the invite link.', help: 'The invite link is in the room menu.' },
  },
];

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Word-boundary stem match so short keywords do not match inside other words
 * ("фон" must not match "микрофон") while still accepting word forms
 * ("фона", "камерой"). Cyrillic/Latin endings up to 4 letters are allowed.
 */
function matchesKeyword(text: string, keyword: string): boolean {
  const normalised = normalise(keyword);
  if (!normalised) return false;
  const escaped = normalised.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}[\\p{L}]{0,4}(?![\\p{L}\\p{N}])`, 'u').test(text);
  } catch {
    return text.includes(normalised);
  }
}

const HELP_MARKERS = ['как ', 'где ', 'помоги', 'подскажи', 'how do', 'where is', 'help', 'не могу найти', 'не знаю'];
const RECORDING_STOP = ['останови запись', 'стоп запись', 'stop recording', 'выключи запись'];

/**
 * Offline assistant: matches a user utterance to at most `maxActions` tools the
 * user is allowed to use, and (in "how/where" mode) returns a spotlight tour.
 * No network, no LLM, deterministic.
 */
export function localAssistantReply(
  utterance: string,
  context: LocalAssistantContext,
  options: { id?: string; now?: number; maxActions?: number; denyMessage?: string } = {},
): AssistantReply {
  const text = normalise(utterance);
  const locale = context.locale;
  const maxActions = Math.max(1, Math.min(options.maxActions ?? 3, 10));
  const denyMessage =
    options.denyMessage ?? (locale === 'ru' ? 'Это действие недоступно с вашими правами' : 'You are not allowed to do this');
  const allowedTools = new Set(context.tools);
  const isHelp = HELP_MARKERS.some((marker) => text.includes(marker));
  const stopRecording = RECORDING_STOP.some((marker) => text.includes(marker));

  const matched: IntentRule[] = [];
  for (const rule of INTENT_RULES) {
    if (rule.keywords.some((keyword) => matchesKeyword(text, keyword))) matched.push(rule);
  }

  // "Stop recording" is the inverse of start_recording: emit an explicit
  // stop_recording action instead.
  if (stopRecording) {
    const filtered = matched.filter((rule) => rule.tool !== 'start_recording');
    matched.length = 0;
    matched.push(...filtered);
    if (!matched.some((rule) => rule.tool === 'stop_recording')) {
      matched.unshift({
        tool: 'stop_recording',
        keywords: RECORDING_STOP,
        spotlightTarget: 'recording',
        ru: { action: 'Останавливаю запись звонка.', help: 'Кнопка записи находится в панели управления внизу.' },
        en: { action: 'Stopping the call recording.', help: 'The recording button is in the bottom control bar.' },
      });
    }
  }

  // "Fullscreen" phrasing also contains the word "screen" — do not let the
  // screen-sharing intent win over the fullscreen intent.
  if (/полн\w*\s*экран|на весь экран|fullscreen|full screen/i.test(text)) {
    const filtered = matched.filter((rule) => rule.tool !== 'toggle_screen_share');
    matched.length = 0;
    matched.push(...filtered);
  }

  if (isHelp) {
    const spotlight: AssistantSpotlight[] = [];
    const primary = matched[0];
    if (primary && context.spotlight && allowedTools.has(primary.tool)) {
      spotlight.push({
        target: primary.spotlightTarget,
        text: locale === 'ru' ? primary.ru.help : primary.en.help,
        step: 0,
      });
    }
    if (context.spotlight && matched.length === 0) {
      const tourGuides: Array<{ target: string; ru: string; en: string }> = [
        { target: 'mic', ru: 'Микрофон: включить/выключить звук.', en: 'Microphone: mute/unmute yourself.' },
        { target: 'camera', ru: 'Камера: включить/выключить видео.', en: 'Camera: turn your video on/off.' },
        { target: 'screen', ru: 'Демонстрация экрана.', en: 'Share your screen.' },
        { target: 'chat', ru: 'Чат звонка и передача файлов.', en: 'Call chat and file transfer.' },
        { target: 'notes', ru: 'Транскрипт, заметки и выдержки.', en: 'Transcript, notes and excerpts.' },
        { target: 'settings', ru: 'Настройки устройств и темы.', en: 'Devices and theme settings.' },
      ];
      tourGuides.forEach((guide, index) => spotlight.push({ target: guide.target, text: locale === 'ru' ? guide.ru : guide.en, step: index }));
    }
    const helpText = primary
      ? locale === 'ru' ? primary.ru.help : primary.en.help
      : spotlight.length > 0
        ? locale === 'ru' ? 'Подсветил кнопки на панели звонка.' : 'I highlighted controls in the call toolbar.'
        : locale === 'ru' ? 'Уточните, какая кнопка или функция вам нужна.' : 'Which call control or feature do you need help with?';
    return {
      id: options.id ?? `local-${Math.random().toString(36).slice(2, 10)}`,
      text: helpText,
      actions: [],
      spotlight,
      source: 'local',
      ts: options.now ?? Date.now(),
    };
  }

  const actions: AssistantAction[] = [];
  for (const rule of matched) {
    if (actions.length >= maxActions) break;
    const tool = rule.tool;
    if (!allowedTools.has(tool)) continue;
    const requirements = assistantToolRequirements(tool);
    if (requirements.roles && !requirements.roles.includes(context.role)) continue;
    if (requirements.feature && !context.permissions.includes(requirements.feature)) continue;
    actions.push({ tool });
  }
  const { allowed } = filterAssistantActions(actions, { role: context.role, permissions: context.permissions });

  if (allowed.length === 0) {
    const hasIntent = matched.length > 0;
    return {
      id: options.id ?? `local-${Math.random().toString(36).slice(2, 10)}`,
      text: hasIntent ? denyMessage : locale === 'ru' ? 'Не понял команду. Спросите: «включи запись», «открой чат», «как включить микрофон?».' : 'I did not understand. Try “start recording”, “open chat”, “how do I unmute?”.',
      actions: [],
      spotlight: [],
      source: 'local',
      ts: options.now ?? Date.now(),
    };
  }

  const summary = allowed
    .map((action) => {
      const rule = INTENT_RULES.find((candidate) => candidate.tool === action.tool);
      if (!rule) return '';
      return locale === 'ru' ? rule.ru.action : rule.en.action;
    })
    .filter(Boolean)
    .join(' ');
  const spotlight: AssistantSpotlight[] = [];
  if (context.spotlight) {
    const firstRule = INTENT_RULES.find((candidate) => candidate.tool === allowed[0]?.tool);
    if (firstRule) spotlight.push({ target: firstRule.spotlightTarget, text: locale === 'ru' ? firstRule.ru.help : firstRule.en.help, step: 0 });
  }
  return {
    id: options.id ?? `local-${Math.random().toString(36).slice(2, 10)}`,
    text: summary || (locale === 'ru' ? 'Готово.' : 'Done.'),
    actions: allowed,
    spotlight,
    source: 'local',
    ts: options.now ?? Date.now(),
  };
}
