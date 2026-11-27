import { h } from '../dom.js';
import type { I18n, I18nKey } from '../i18n.js';
import type { CallState } from '../types.js';

const storageKey = 'agil.camera.custom-background.v1';
const maxFileBytes = 12 * 1024 * 1024;
let customImage: string | undefined;
let hasStoredImage = false;

const lakeUrl = new URL('../assets/backgrounds/camera-mountain-lake.jpg?no-inline', import.meta.url).href;
const presets = new Map<string, { url: string; defaultName: string; label: I18nKey }>([
  ['office', {
    url: new URL('../assets/backgrounds/camera-office.jpg?no-inline', import.meta.url).href,
    defaultName: 'Офис',
    label: 'videoBackgroundOffice',
  }],
  ['gradient', { url: lakeUrl, defaultName: 'Градиент', label: 'videoBackgroundLake' }],
  ['brand', {
    url: new URL('../assets/backgrounds/camera-blue-studio.jpg?no-inline', import.meta.url).href,
    defaultName: 'Бренд',
    label: 'videoBackgroundStudio',
  }],
]);

function readImage(): string {
  if (customImage === undefined) {
    try {
      customImage = localStorage.getItem(storageKey) ?? '';
      hasStoredImage = Boolean(customImage);
    } catch {
      customImage = '';
    }
  }
  return customImage;
}

export class BackgroundPicker {
  readonly element = h('div', { class: 'agil-background-picker' });
  private readonly gallery: HTMLDivElement;
  private readonly apply: HTMLButtonElement;
  private readonly remove: HTMLButtonElement;
  private readonly status: HTMLElement;
  private backgrounds: CallState['backgrounds'] | undefined;
  private savedImage = '';
  private selected = '';
  private appliedImage = '';
  private choices = new Map<string, string>();

  constructor(private readonly i18n: I18n, onApply: (url: string | null) => void, onResize?: () => void) {
    this.gallery = h('div', { class: 'agil-background-gallery', attrs: { role: 'group', 'aria-label': i18n.t('videoBackgroundChoose') } });
    this.apply = h('button', { class: 'agil-video-chip', text: i18n.t('videoBackgroundApply'), attrs: { type: 'button' } });
    this.apply.disabled = true;
    this.apply.addEventListener('click', () => {
      const url = this.choices.get(this.selected);
      if (url) onApply(url);
    });

    const upload = h('button', { class: 'agil-video-chip', text: i18n.t('videoBackgroundUpload'), attrs: { type: 'button' } });
    const input = h('input', { attrs: { type: 'file', accept: 'image/png,image/jpeg,image/webp' } });
    input.hidden = true;
    this.status = h('p', { class: 'agil-background-status', attrs: { role: 'status' } });
    this.status.hidden = true;
    const message = (key?: I18nKey): void => {
      this.status.hidden = !key;
      this.status.textContent = key ? i18n.t(key) : '';
      onResize?.();
    };
    this.remove = h('button', { class: 'agil-video-chip', text: i18n.t('videoBackgroundRemove'), attrs: { type: 'button' } });
    this.remove.hidden = true;
    this.remove.addEventListener('click', () => {
      const active = Boolean(this.appliedImage) && this.appliedImage === readImage();
      if (hasStoredImage) {
        try {
          localStorage.removeItem(storageKey);
          hasStoredImage = false;
        } catch {
          // The current call can still discard the image from memory.
        }
      }
      customImage = '';
      this.update(this.backgrounds ?? [], active ? '' : this.appliedImage);
      if (active) onApply(null);
      if (upload.getClientRects().length) upload.focus();
      message(hasStoredImage ? 'videoBackgroundRemoveFailed' : 'videoBackgroundRemoved');
    });
    upload.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      const doc = upload.ownerDocument;
      const wasFocused = doc.activeElement === upload;
      upload.disabled = true;
      this.remove.disabled = true;
      message();
      try {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > maxFileBytes) {
          throw new Error('Unsupported background image');
        }
        const bitmap = await createImageBitmap(file);
        try {
          const scale = Math.min(1, 960 / Math.max(bitmap.width, bitmap.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(bitmap.width * scale));
          canvas.height = Math.max(1, Math.round(bitmap.height * scale));
          const context = canvas.getContext('2d', { alpha: false });
          if (!context) throw new Error('Canvas unavailable');
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          customImage = canvas.toDataURL('image/jpeg', 0.8);
        } finally {
          bitmap.close();
        }
        try {
          localStorage.setItem(storageKey, customImage);
          hasStoredImage = true;
          message('videoBackgroundSaved');
        } catch {
          message('videoBackgroundSessionOnly');
        }
        this.update(this.backgrounds ?? [], customImage);
        onApply(customImage);
      } catch {
        message('videoBackgroundInvalid');
      } finally {
        upload.disabled = false;
        this.remove.disabled = false;
        // Disabling a focused button can move focus to the document body.
        if (wasFocused && doc.activeElement === doc.body && upload.getClientRects().length) upload.focus();
      }
    });
    this.element.append(this.gallery, this.apply, upload, this.remove, input, this.status);
  }

  private select(id: string): void {
    this.selected = this.choices.has(id) ? id : '';
    this.apply.disabled = !this.selected;
    for (const button of this.gallery.querySelectorAll<HTMLButtonElement>('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.background === this.selected));
    }
  }

  update(backgrounds: CallState['backgrounds'], current: string): void {
    const saved = readImage();
    const previous = this.selected;
    const changed = this.appliedImage !== current;
    const needsOptions = this.backgrounds !== backgrounds || this.savedImage !== saved;
    this.appliedImage = current;
    if (needsOptions) {
      this.backgrounds = backgrounds;
      this.savedImage = saved;
      this.gallery.replaceChildren();
      this.choices.clear();
      const add = (id: string, name: string, url: string): void => {
        if (!url) return;
        this.choices.set(id, url);
        const image = h('img', { attrs: { src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' } });
        const thumbnail = h('button', { class: 'agil-background-thumbnail', attrs: { type: 'button' }, dataset: { background: id } }, image, h('span', { text: name }));
        thumbnail.addEventListener('click', () => this.select(id));
        this.gallery.appendChild(thumbnail);
      };
      backgrounds.forEach((background, index) => {
        const preset = presets.get(background.id);
        const name = !background.url && preset?.defaultName === background.name
          ? this.i18n.t(preset.label)
          : background.name;
        add(String(index), name, background.url || preset?.url || lakeUrl);
      });
      if (saved) add('custom', this.i18n.t('videoBackgroundCustom'), saved);
      this.remove.hidden = !saved;
    }
    if (needsOptions || changed) {
      const currentId = [...this.choices].find(([, url]) => url === current)?.[0];
      this.select(currentId ?? (changed ? '' : previous || (saved ? 'custom' : '')));
    }
  }
}
