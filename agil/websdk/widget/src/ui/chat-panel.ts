/** Chat panel: history, composer, attachments, file downloads. */
import type { ChatMessage } from '@agil/protocol';
import { formatClock, formatBytes, h } from '../dom.js';
import type { I18n } from '../i18n.js';
import { icon } from '../icons.js';
import { canSendChat } from '../permissions.js';
import type { CallState } from '../types.js';

export interface ChatPanelActions {
  onSend: (text: string) => Promise<void>;
  onAttach: (file: File) => void;
  onDownload: (url: string, name: string) => void;
  onClose: () => void;
  canFileShare: () => boolean;
}

export class ChatPanel {
  readonly element: HTMLElement;
  private readonly i18n: I18n;
  private readonly actions: ChatPanelActions;
  private readonly list: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly attachButton: HTMLButtonElement;
  private readonly emojiToggle: HTMLButtonElement;
  private readonly emojiOptions: HTMLDivElement;
  private readonly fileInput: HTMLInputElement;
  private readonly empty: HTMLDivElement;
  private readonly composer: HTMLDivElement;
  private readonly readOnlyNotice: HTMLParagraphElement;
  private readonly uploadStatus: HTMLDivElement;
  private lastMessages: CallState['chat'] | null = null;
  private lastSelfId: string | undefined;
  private sending = false;

  constructor(i18n: I18n, actions: ChatPanelActions) {
    this.i18n = i18n;
    this.actions = actions;
    this.list = h('div', { class: 'agil-chat-list', attrs: { role: 'log', 'aria-live': 'polite' } });
    this.empty = h('div', { class: 'agil-panel-empty', text: i18n.t('chatEmpty') });
    this.input = h('input', { class: 'agil-chat-input', attrs: { maxlength: '4000', placeholder: i18n.t('chatPlaceholder') } });
    this.input.dataset.agilChatInput = '';
    this.input.setAttribute('aria-label', i18n.t('chatPlaceholder'));
    this.sendButton = h('button', { class: 'agil-icon-btn agil-chat-send', title: i18n.t('chatSend') });
    this.sendButton.type = 'button';
    this.sendButton.dataset.agilChatSend = '';
    this.sendButton.setAttribute('aria-label', i18n.t('chatSend'));
    this.sendButton.appendChild(icon('send', 18));
    this.sendButton.disabled = true;
    this.attachButton = h('button', { class: 'agil-icon-btn', title: i18n.t('attachFile') });
    this.attachButton.type = 'button';
    this.attachButton.setAttribute('aria-label', i18n.t('attachFile'));
    this.attachButton.appendChild(icon('paperclip', 18));
    const emojiToggle = this.emojiToggle = h('button', { class: 'agil-icon-btn', text: '🙂', attrs: {
      type: 'button', title: i18n.t('chatChooseEmoji'), 'aria-label': i18n.t('chatChooseEmoji'), 'aria-expanded': 'false',
    } });
    const emojiOptions = this.emojiOptions = h('div', { class: 'agil-chat-emoji-options', attrs: { role: 'group', 'aria-label': i18n.t('chatChooseEmoji') } });
    const toggleEmoji = (open: boolean): void => {
      emojiOptions.hidden = !open;
      emojiToggle.setAttribute('aria-expanded', String(open));
      if (open) emojiOptions.querySelector('button')?.focus();
    };
    toggleEmoji(false);
    const emoji = [
      ['🙂', 'Улыбка', 'Smile'], ['😂', 'Смех', 'Laughter'], ['❤️', 'Сердце', 'Heart'], ['👍', 'Палец вверх', 'Thumbs up'],
      ['👏', 'Аплодисменты', 'Applause'], ['🎉', 'Праздник', 'Celebration'], ['🤔', 'Задумался', 'Thinking'], ['👋', 'Приветствие', 'Wave'],
    ] as const;
    for (const [value, ru, en] of emoji) {
      const option = h('button', { class: 'agil-icon-btn', text: value, attrs: { type: 'button', 'aria-label': i18n.current === 'ru' ? ru : en } });
      option.addEventListener('click', () => {
        const start = this.input.selectionStart ?? this.input.value.length;
        const end = this.input.selectionEnd ?? start;
        if (this.input.value.length - (end - start) + value.length <= this.input.maxLength) this.input.setRangeText(value, start, end, 'end');
        toggleEmoji(false);
        this.updateSendState();
        this.input.focus();
      });
      emojiOptions.append(option);
    }
    emojiToggle.addEventListener('click', () => toggleEmoji(emojiOptions.hidden));
    emojiOptions.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); toggleEmoji(false); emojiToggle.focus(); }
    });
    this.fileInput = h('input', { attrs: { type: 'file' } });
    this.fileInput.type = 'file';
    this.fileInput.hidden = true;
    this.uploadStatus = h('div', { class: 'agil-visually-hidden', attrs: { role: 'status' } });

    const submit = async (): Promise<void> => {
      const draft = this.input.value;
      const value = draft.trim();
      if (this.composer.hidden || !value || this.sending) return;
      this.sending = true;
      this.updateSendState();
      try {
        await this.actions.onSend(value);
        if (this.input.value === draft) this.input.value = '';
        this.scrollToBottom();
      } catch {
        // The action reports the error. Keep the draft for another attempt.
      } finally {
        this.sending = false;
        this.updateSendState();
      }
    };
    this.sendButton.addEventListener('click', submit);
    this.input.addEventListener('input', () => this.updateSendState());
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    });
    this.attachButton.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (file) this.actions.onAttach(file);
      this.fileInput.value = '';
    });

    const header = h(
      'div',
      { class: 'agil-panel-header' },
      h('h2', { class: 'agil-panel-title', text: i18n.t('chatTitle') }),
      this.closeButton(),
    );
    this.composer = h('div', { class: 'agil-chat-composer' }, this.attachButton, emojiToggle, this.input, this.sendButton, this.fileInput, emojiOptions);
    this.readOnlyNotice = h('p', { class: 'agil-panel-empty', text: i18n.t('chatGuestReadOnly'), attrs: { role: 'status', tabindex: '-1' } });
    this.readOnlyNotice.hidden = true;
    this.element = h(
      'section',
      { class: 'agil-panel agil-chat-panel', attrs: { 'aria-label': i18n.t('chatTitle') } },
      header,
      this.list,
      this.empty,
      this.composer,
      this.readOnlyNotice,
      this.uploadStatus,
    );
  }

  private closeButton(): HTMLButtonElement {
    const button = h('button', { class: 'agil-icon-btn', title: this.i18n.t('close') });
    button.type = 'button';
    button.setAttribute('aria-label', this.i18n.t('close'));
    button.appendChild(icon('close', 18));
    button.addEventListener('click', () => this.actions.onClose());
    return button;
  }

  focusInput(): void {
    (this.composer.hidden ? this.readOnlyNotice : this.input).focus();
  }

  closeEmojiPicker(restoreFocus = false): boolean {
    if (this.emojiOptions.hidden) return false;
    this.emojiOptions.hidden = true;
    this.emojiToggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) this.emojiToggle.focus();
    return true;
  }

  setUploading(uploading: boolean): void {
    this.attachButton.disabled = uploading;
    this.attachButton.setAttribute('aria-busy', String(uploading));
    this.uploadStatus.textContent = uploading ? this.i18n.t('chatUploading') : '';
  }

  private updateSendState(): void {
    this.sendButton.disabled = this.sending || this.input.value.trim().length === 0;
    this.sendButton.setAttribute('aria-busy', String(this.sending));
  }

  update(state: CallState): void {
    const messages = state.chat;
    const readOnly = !canSendChat(state);
    if (this.composer.hidden !== readOnly) {
      const active = this.element.ownerDocument.activeElement;
      const restoreFocus = this.composer.contains(active) || active === this.readOnlyNotice;
      if (readOnly) this.closeEmojiPicker();
      this.composer.hidden = readOnly;
      this.readOnlyNotice.hidden = !readOnly;
      if (restoreFocus) this.focusInput();
    }
    const canFile = !readOnly && state.config.features.fileShare && state.config.session.fileShare.enabled && this.actions.canFileShare();
    this.attachButton.style.display = canFile ? '' : 'none';
    this.fileInput.disabled = !canFile;
    const selfId = state.self?.id;
    if (messages === this.lastMessages && selfId === this.lastSelfId) return;
    const scrollTop = this.list.scrollTop;
    const followsLatest = this.list.scrollHeight - scrollTop - this.list.clientHeight < 80;
    this.lastMessages = messages;
    this.lastSelfId = selfId;
    this.list.hidden = messages.length === 0;
    this.empty.style.display = messages.length === 0 ? '' : 'none';
    this.list.replaceChildren();
    for (const message of messages) this.list.appendChild(this.renderMessage(message, state));
    if (followsLatest) this.scrollToBottom();
    else this.list.scrollTop = scrollTop;
  }

  private scrollToBottom(): void {
    this.list.scrollTop = this.list.scrollHeight;
  }

  private renderMessage(message: ChatMessage, state: CallState): HTMLElement {
    const isSelf = message.from.id === state.self?.id;
    const isSystem = message.kind === 'system';
    const bubble = h('div', {
      class: `agil-chat-message${isSelf ? ' is-self' : ''}${isSystem ? ' is-system' : ''}`,
      dataset: { agilChatMessage: '', messageId: message.id },
    });
    const meta = h(
      'div',
      { class: 'agil-chat-meta' },
      h('span', { class: 'agil-chat-author', text: isSystem ? this.i18n.t('chatSystem') : message.from.name }),
      h('span', { class: 'agil-chat-time', text: formatClock(message.ts) }),
    );
    bubble.appendChild(meta);
    const text = h('div', { class: 'agil-chat-text' });
    if (message.attachment) {
      const attachment = message.attachment;
      const link = h(
        'button',
        {
          class: 'agil-chat-attachment',
          title: attachment.name,
          attrs: { 'aria-label': `${this.i18n.t('fileDownload')} ${attachment.name}` },
        },
        icon('download', 16),
      );
      link.type = 'button';
      link.appendChild(h('span', { class: 'agil-chat-attachment-name', text: attachment.name }));
      link.appendChild(h('span', { class: 'agil-chat-attachment-size', text: formatBytes(attachment.size, this.i18n.current) }));
      link.addEventListener('click', () => this.actions.onDownload(attachment.url, attachment.name));
      text.appendChild(link);
      if (message.text && message.text !== attachment.name) text.appendChild(h('div', { text: message.text }));
    } else {
      text.textContent = message.text;
    }
    bubble.appendChild(text);
    return bubble;
  }

  destroy(): void {
    this.element.remove();
  }
}
