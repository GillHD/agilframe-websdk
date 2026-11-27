/**
 * Security / authenticity badge in the header: room protection, E2EE flag,
 * media-integrity verdict of the local participant.
 */
import { h } from '../dom.js';
import type { I18n } from '../i18n.js';
import { icon } from '../icons.js';
import type { CallState } from '../types.js';

export class SecurityBadge {
  readonly element: HTMLButtonElement;
  private readonly i18n: I18n;
  private readonly label: HTMLSpanElement;

  constructor(i18n: I18n) {
    this.i18n = i18n;
    this.element = h('button', { class: 'agil-security-badge' });
    this.element.type = 'button';
    this.label = h('span', { class: 'agil-security-badge-label' });
    this.element.appendChild(icon('shield', 15));
    this.element.appendChild(this.label);
  }

  update(state: CallState): void {
    const parts: string[] = [];
    const encryption = state.security.e2ee ? state.e2ee?.status ?? 'disabled' : 'disabled';
    if (state.security.e2ee) {
      const status = encryption === 'enabled' ? this.i18n.t('e2eeEnabled') :
        encryption === 'failed' ? this.i18n.t('e2eeFailed') : this.i18n.t('e2eeUnconfirmed');
      parts.push(`E2EE · ${status}`);
    }
    if (state.security.passwordProtected) parts.push(this.i18n.t('passwordRequired'));
    if (state.security.integrityEnabled) parts.push(this.i18n.t('integrityBadge'));
    if (state.security.geoEnabled) parts.push('Geo');
    if (state.security.auditLog) parts.push(this.i18n.t('auditLog'));
    const title = parts.length > 0 ? parts.join(' · ') : this.i18n.t('appName');
    this.element.title = title;
    this.element.dataset.encryption = encryption;
    this.label.textContent = encryption === 'enabled' ? 'E2EE' : state.security.integrityEnabled ? this.i18n.t('integrityBadge') : this.i18n.t('appName');
    const selfIntegrity = state.self ? state.integrity[state.self.id] : undefined;
    this.element.dataset.integrity = selfIntegrity?.status ?? 'unknown';
    this.element.classList.toggle('is-suspicious', selfIntegrity?.status === 'suspicious');
    this.element.classList.toggle('is-verified', selfIntegrity?.status === 'verified');
  }
}
