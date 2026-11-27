import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assistantToolRequirements,
  filterAssistantActions,
  isAssistantToolAllowed,
  localAssistantReply,
  parseInCallAssistantResponse,
} from '../src/assistant.js';
import type { LocalAssistantContext } from '../src/assistant.js';

const baseContext: LocalAssistantContext = {
  locale: 'ru',
  role: 'host',
  permissions: [
    'recording',
    'screenShare',
    'chat',
    'fileShare',
    'participantList',
    'notes',
    'meetingNotes',
    'deviceSettings',
    'backgroundBlur',
    'fullscreen',
  ],
  tools: [
    'start_recording',
    'stop_recording',
    'toggle_mic',
    'toggle_camera',
    'toggle_screen_share',
    'open_chat',
    'open_files',
    'open_participants',
    'open_notes',
    'open_settings',
    'set_blur',
    'minimize',
    'request_fullscreen',
    'open_new_tab',
  ],
  spotlight: true,
};

test('local assistant starts recording for host', () => {
  const reply = localAssistantReply('включи запись, пожалуйста', baseContext);
  assert.equal(reply.source, 'local');
  assert.deepEqual(reply.actions.map((action) => action.tool), ['start_recording']);
  assert.ok(reply.text.includes('запись'));
  assert.equal(reply.spotlight[0]?.target, 'recording');
});

test('guest cannot start recording', () => {
  const guest: LocalAssistantContext = { ...baseContext, role: 'guest', permissions: ['chat'] };
  const reply = localAssistantReply('включи запись', guest);
  assert.equal(reply.actions.length, 0);
  assert.ok(reply.text.toLowerCase().includes('недоступ'));
});

test('chat intent opens chat and respects disabled feature', () => {
  const reply = localAssistantReply('открой чат', baseContext);
  assert.deepEqual(reply.actions.map((action) => action.tool), ['open_chat']);
  const noChat: LocalAssistantContext = { ...baseContext, permissions: baseContext.permissions.filter((p) => p !== 'chat') };
  const denied = localAssistantReply('открой чат', noChat);
  assert.equal(denied.actions.length, 0);
});

test('help request returns a spotlight tour without actions', () => {
  const reply = localAssistantReply('как включить микрофон?', { ...baseContext, permissions: [] });
  assert.equal(reply.actions.length, 0);
  assert.ok(reply.spotlight.length > 0);
  assert.ok(reply.spotlight.every((spot) => spot.target.length > 0 && spot.text.length > 0));
});

test('english is supported', () => {
  const reply = localAssistantReply('please start recording', { ...baseContext, locale: 'en' });
  assert.deepEqual(reply.actions.map((action) => action.tool), ['start_recording']);
  assert.ok(reply.text.toLowerCase().includes('recording'));
});

test('unknown command gives a hint', () => {
  const reply = localAssistantReply('абракадабра', baseContext);
  assert.equal(reply.actions.length, 0);
  assert.ok(reply.text.length > 0);
});

test('a disabled stop-recording command is denied without starting a recording', () => {
  const reply = localAssistantReply('stop recording', { ...baseContext, locale: 'en', tools: ['start_recording'] }, {
    denyMessage: 'Recording controls are restricted.',
  });
  assert.deepEqual(reply.actions, []);
  assert.equal(reply.text, 'Recording controls are restricted.');
});

test('maxActions caps the number of actions', () => {
  const reply = localAssistantReply('включи запись и покажи экран и открой чат', baseContext, { maxActions: 2 });
  assert.ok(reply.actions.length <= 2);
});

test('tool requirements map to permissions', () => {
  assert.equal(assistantToolRequirements('start_recording').feature, 'recording');
  assert.deepEqual(assistantToolRequirements('start_recording').roles, ['host', 'moderator']);
  assert.equal(assistantToolRequirements('open_chat').feature, 'chat');
  assert.equal(assistantToolRequirements('toggle_mic').feature, undefined);
});

test('filterAssistantActions splits allowed and denied', () => {
  const { allowed, denied } = filterAssistantActions(
    [{ tool: 'open_chat' }, { tool: 'start_recording' }, { tool: 'toggle_mic' }],
    { role: 'guest', permissions: ['chat'] },
  );
  assert.deepEqual(allowed.map((action) => action.tool), ['open_chat', 'toggle_mic']);
  assert.deepEqual(denied.map((action) => action.tool), ['start_recording']);
});

test('isAssistantToolAllowed honours role restrictions', () => {
  assert.equal(isAssistantToolAllowed('start_recording', { role: 'guest', permissions: ['recording'] }), false);
  assert.equal(isAssistantToolAllowed('start_recording', { role: 'host', permissions: ['recording'] }), true);
});

test('microphone phrase does not trigger background blur (word boundaries)', () => {
  const reply = localAssistantReply('включи микрофон', baseContext);
  assert.deepEqual(reply.actions.map((action) => action.tool), ['toggle_mic']);
});

test('background phrase still triggers blur', () => {
  const reply = localAssistantReply('включи размытие фона', baseContext);
  assert.deepEqual(reply.actions.map((action) => action.tool), ['set_blur']);
});

test('parseInCallAssistantResponse validates untrusted LLM output', () => {
  const good = parseInCallAssistantResponse({
    requestId: 'r1',
    text: 'Готово',
    actions: [{ tool: 'open_chat' }],
    spotlight: [{ target: 'chat', text: 'Нажмите сюда' }],
  });
  assert.ok(good);
  assert.equal(good?.actions.length, 1);
  assert.equal(parseInCallAssistantResponse({ text: 'x' }), null);
  assert.equal(
    parseInCallAssistantResponse({ requestId: 'r', text: 'x', actions: [{ tool: 'delete_everything' }] }),
    null,
  );
});
