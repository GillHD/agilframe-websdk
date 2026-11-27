/**
 * Speech-to-text / captions (contract §6, §14).
 *
 * Primary provider is the browser Web Speech API (Chrome/Edge): continuous
 * recognition, interim results for the live caption overlay. When it is not
 * available the widget falls back to server STT: MediaRecorder audio chunks
 * every ~8 s are posted to `POST /v1/stt/transcribe` (Bearer join token); a 501
 * answer means STT is not configured and the UI says so honestly.
 *
 * Final segments are broadcast over signaling as `{type:'caption'}` and stored in
 * the transcript panel.
 */
import type { TenantConfig, TranscriptSegment } from '@agil/protocol';
import type { ApiClient } from '../api.js';
import { ApiError } from '../api.js';
import { uid } from '../dom.js';
import type { SignalingClient } from './signaling-client.js';

interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionErrorEventLike {
  error: string;
  message?: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export type CaptionProvider = 'browser' | 'server' | 'off';

export interface CaptionsStatus {
  available: boolean;
  provider: CaptionProvider;
  listening: boolean;
  error?: 'unsupported' | 'stt_unavailable' | 'permission' | 'provider_failed' | 'unknown';
}

export interface CaptionsOptions {
  getConfig: () => TenantConfig;
  signaling: SignalingClient;
  api: ApiClient;
  language: 'ru' | 'en';
  getAudioTrack: () => MediaStreamTrack | null;
  onInterim: (text: string) => void;
  onFinal: (segment: TranscriptSegment) => void;
  onStatus: (status: CaptionsStatus) => void;
  /** Server-side machine translation target (`none` = disabled). */
  translateTo?: 'none' | 'ru' | 'en';
  getConsent: () => Promise<{ consentRequired: boolean; consented: boolean }>;
  /**
   * Called before capture when the participant has not consented. The host UI owns the
   * informed-consent prompt; returning `false` keeps captions off.
   */
  onConsentRequired?: (provider: 'browser' | 'server') => Promise<boolean>;
}

function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const scoped = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scoped.SpeechRecognition ?? scoped.webkitSpeechRecognition ?? null;
}

function serverRecordingMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
    .find((mime) => MediaRecorder.isTypeSupported(mime));
}

const MAX_CONSECUTIVE_STT_FAILURES = 3;

export class CaptionsController {
  private readonly options: CaptionsOptions;
  private recognition: SpeechRecognitionLike | null = null;
  private listening = false;
  private provider: CaptionProvider = 'off';
  private startedAt = 0;
  private interimId = '';
  private serverRecorder: MediaRecorder | null = null;
  private serverTimer: ReturnType<typeof setTimeout> | null = null;
  private serverDisabled = false;
  private serverFailures = 0;
  private captureGeneration = 0;
  private language: 'ru' | 'en';
  private translateTo: 'none' | 'ru' | 'en';
  private pendingStart: number | null = null;

  constructor(options: CaptionsOptions) {
    this.options = options;
    this.language = options.language;
    this.translateTo = options.translateTo ?? 'none';
  }

  get isListening(): boolean {
    return this.listening;
  }

  get currentProvider(): CaptionProvider {
    return this.provider;
  }

  /** Best available provider for this browser/config. */
  resolveProvider(): CaptionProvider {
    const { enabled, provider: configured } = this.options.getConfig().session.transcription;
    if (!enabled || configured === 'off') return 'off';
    if (configured === 'browser') return speechRecognitionCtor() ? 'browser' : 'off';
    if (configured === 'server') return serverRecordingMime() ? 'server' : 'off';
    return 'off';
  }

  setLanguage(language: 'ru' | 'en'): void {
    if (this.language === language) return;
    this.language = language;
    if (this.listening) {
      this.stop();
      void this.start();
    }
  }

  /** Follows `session.transcription.translateTo` changes (tenant config update). */
  setTranslateTo(translateTo: 'none' | 'ru' | 'en'): void {
    this.translateTo = translateTo;
  }

  async start(): Promise<boolean> {
    if (this.listening) return true;
    if (this.pendingStart !== null) return false;
    const provider = this.resolveProvider();
    if (provider === 'off') {
      this.options.onStatus({ available: false, provider, listening: false, error: 'unsupported' });
      return false;
    }
    const generation = ++this.captureGeneration;
    this.pendingStart = generation;
    try {
      const { consentRequired, consented } = await this.options.getConsent();
      if (generation !== this.captureGeneration) return false;
      if (consentRequired && !consented && !(await this.requestConsent(provider))) {
        if (generation === this.captureGeneration) this.options.onStatus({ available: false, provider, listening: false, error: 'permission' });
        return false;
      }
      if (generation !== this.captureGeneration || provider !== this.resolveProvider()) return false;
      if (this.startedAt === 0) this.startedAt = Date.now();
      this.provider = provider;
      return provider === 'browser' ? this.startBrowser() : this.startServer();
    } catch {
      if (generation === this.captureGeneration) {
        this.options.onStatus({ available: false, provider, listening: false, error: 'permission' });
      }
      return false;
    } finally {
      if (this.pendingStart === generation) this.pendingStart = null;
    }
  }

  private startBrowser(): boolean {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return false;
    const recognition = new Ctor();
    recognition.lang = this.language === 'ru' ? 'ru-RU' : 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result) continue;
        const alternative = result[0];
        if (!alternative) continue;
        const text = alternative.transcript.trim();
        if (!text) continue;
        if (result.isFinal) {
          this.emitFinal(text);
        } else {
          interim += `${text} `;
        }
      }
      if (interim.trim()) {
        if (!this.interimId) this.interimId = uid('interim');
        this.options.onInterim(interim.trim());
      }
    };
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.options.onStatus({ available: false, provider: 'browser', listening: false, error: 'permission' });
        this.listening = false;
      }
    };
    recognition.onend = () => {
      if (!this.listening) return;
      // Chrome stops recognition after silence: restart to stay continuous.
      setTimeout(() => {
        if (!this.listening || this.recognition !== recognition) return;
        try {
          recognition.start();
        } catch {
          /* already started */
        }
      }, 300);
    };

    try {
      recognition.start();
    } catch (error) {
      console.warn('[agil] speech recognition failed to start', error);
      this.options.onStatus({ available: false, provider: 'browser', listening: false, error: 'unknown' });
      return false;
    }
    this.recognition = recognition;
    this.listening = true;
    this.options.onStatus({ available: true, provider: 'browser', listening: true });
    return true;
  }

  private startServer(): boolean {
    if (this.serverDisabled) {
      this.options.onStatus({ available: false, provider: 'server', listening: false, error: 'stt_unavailable' });
      return false;
    }
    const track = this.options.getAudioTrack();
    if (!track) {
      this.options.onStatus({ available: false, provider: 'server', listening: false, error: 'permission' });
      return false;
    }
    const mimeType = serverRecordingMime();
    if (!mimeType) {
      this.options.onStatus({ available: false, provider: 'server', listening: false, error: 'unsupported' });
      return false;
    }
    this.listening = true;
    this.options.onStatus({ available: true, provider: 'server', listening: true });
    this.scheduleServerChunk(mimeType);
    return this.listening;
  }

  private scheduleServerChunk(mimeType: string): void {
    if (!this.listening) return;
    const generation = this.captureGeneration;
    const track = this.options.getAudioTrack();
    if (!track?.enabled || track.readyState !== 'live') {
      this.serverTimer = setTimeout(() => this.scheduleServerChunk(mimeType), 2000);
      return;
    }
    const stream = new MediaStream([track]);
    let recorder: MediaRecorder;
    const chunks: Blob[] = [];
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch (error) {
      console.warn('[agil] server STT recorder failed', error);
      this.options.onStatus({ available: false, provider: 'server', listening: false, error: 'unsupported' });
      this.listening = false;
      return;
    }
    this.serverRecorder = recorder;
    let chunkStartedAt = Date.now();
    recorder.addEventListener('dataavailable', (event: BlobEvent) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      if (!this.listening || generation !== this.captureGeneration) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
      if (blob.size > 0) void this.transcribeChunk(blob, chunkStartedAt, generation);
      this.serverTimer = setTimeout(() => this.scheduleServerChunk(mimeType), 200);
    });
    try {
      recorder.start();
    } catch (error) {
      console.warn('[agil] server STT recorder start failed', error);
      this.listening = false;
      this.serverRecorder = null;
      this.options.onStatus({ available: false, provider: 'server', listening: false, error: 'unsupported' });
      return;
    }
    chunkStartedAt = Date.now();
    this.serverTimer = setTimeout(() => {
      if (recorder.state === 'recording') {
        try {
          recorder.stop();
        } catch {
          /* ignore */
        }
      }
    }, 8000);
  }

  private async transcribeChunk(blob: Blob, chunkStartedAt: number, generation: number): Promise<void> {
    try {
      const response = await this.options.api.transcribe(blob, this.language, this.translateTo);
      if (generation !== this.captureGeneration) return;
      this.serverFailures = 0;
      const chunkOffset = Math.max(0, (chunkStartedAt - this.startedAt) / 1000);
      const segments = response.segments ?? [];
      if (segments.length > 0) {
        for (const segment of segments) {
          const text = (segment.text ?? '').trim();
          if (!text) continue;
          const start = chunkOffset + Math.max(0, segment.start || 0);
          const end = chunkOffset + Math.max(segment.start || 0, segment.end || 0);
          this.emitFinal(text, {
            start,
            end,
            ...(segment.lang === 'ru' || segment.lang === 'en' ? { lang: segment.lang } : {}),
            ...(segment.translation ? { translation: segment.translation } : {}),
          });
        }
        return;
      }
      const text = (response.text ?? '').trim();
      if (text) this.emitFinal(text, { start: chunkOffset, end: chunkOffset });
    } catch (error) {
      if (generation !== this.captureGeneration) return;
      if (error instanceof ApiError && error.code === 'consent_required') {
        this.stop();
        await this.start();
        return;
      }
      if (error instanceof ApiError && (error.status === 501 || error.code === 'stt_not_configured')) {
        this.serverDisabled = true;
        this.stop();
        this.options.onStatus({ available: false, provider: 'server', listening: false, error: 'stt_unavailable' });
        return;
      }
      if (error instanceof ApiError && (error.status === 502 || error.status === 503 || error.code === 'provider_failed')) {
        this.serverFailures += 1;
        if (this.serverFailures < MAX_CONSECUTIVE_STT_FAILURES) return;
        this.stop();
        this.options.onStatus({ available: false, provider: 'server', listening: false, error: 'provider_failed' });
      }
    }
  }

  private async requestConsent(provider: 'browser' | 'server'): Promise<boolean> {
    if (!this.options.onConsentRequired) return false;
    try {
      return await this.options.onConsentRequired(provider);
    } catch {
      return false;
    }
  }

  private emitFinal(
    text: string,
    meta: {
      start?: number;
      end?: number;
      lang?: 'ru' | 'en';
      translation?: TranscriptSegment['translation'];
    } = {},
  ): void {
    const cleaned = text.trim();
    if (!cleaned) return;
    const start = meta.start ?? Math.max(0, (Date.now() - this.startedAt) / 1000);
    const end = Math.max(start, meta.end ?? start);
    const segment: TranscriptSegment = {
      id: uid('stt'),
      participantId: 'self',
      participantName: '',
      text: cleaned.slice(0, 2000),
      start,
      end,
      isFinal: true,
      lang: meta.lang ?? this.language,
      ts: Date.now(),
      ...(meta.translation ? { translation: meta.translation } : {}),
    };
    this.interimId = '';
    this.options.onFinal(segment);
    this.options.signaling.send({ type: 'caption', text: segment.text, isFinal: true, lang: this.language });
  }

  stop(): void {
    this.listening = false;
    this.serverFailures = 0;
    this.pendingStart = null;
    this.captureGeneration += 1;
    if (this.recognition) {
      this.recognition.onend = null;
      this.recognition.onresult = null;
      this.recognition.onerror = null;
      try {
        this.recognition.stop();
      } catch {
        /* ignore */
      }
      this.recognition = null;
    }
    if (this.serverTimer) {
      clearTimeout(this.serverTimer);
      this.serverTimer = null;
    }
    if (this.serverRecorder?.state === 'recording') {
      try {
        this.serverRecorder.stop();
      } catch {
        /* ignore */
      }
    }
    this.serverRecorder = null;
    this.options.onStatus({ available: this.provider !== 'off', provider: this.provider, listening: false });
  }
}
