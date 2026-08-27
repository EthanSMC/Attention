/**
 * iLink WeChat client for the Attention DSH plugin.
 */

import type {
  ILinkClientOptions,
  ILinkInboundMessage,
  ILinkOutboundMessage,
  ILinkQrSession,
} from './protocol.js';
import {
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_MAX_QR_REFRESHES,
} from './protocol.js';
import {
  loadChannelState,
  clearChannelState,
} from './state.js';

export type ILinkEvent =
  | { type: 'message'; message: ILinkInboundMessage }
  | { type: 'qr_ready'; session: ILinkQrSession }
  | { type: 'qr_expired' }
  | { type: 'qr_scanned' }
  | { type: 'authenticated' }
  | { type: 'disconnected'; reason: string }
  | { type: 'error'; code: string; message: string };

export type ILinkEventHandler = (event: ILinkEvent) => void;

export interface ILinkToken {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}

export class ILinkClient {
  private token: ILinkToken | null = null;
  private polling = false;
  private handlers: Set<ILinkEventHandler> = new Set();
  private options: Required<ILinkClientOptions>;

  constructor(options: ILinkClientOptions = {}) {
    this.options = {
      baseUrl: options.baseUrl ?? 'https://ilink.weixin.qq.com',
      pollTimeoutMs: options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
      maxQrRefreshes: options.maxQrRefreshes ?? DEFAULT_MAX_QR_REFRESHES,
    };
  }

  on(handler: ILinkEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(event: ILinkEvent): void {
    for (const handler of this.handlers) {
      try { handler(event); } catch { /* swallow */ }
    }
  }

  async restore(): Promise<boolean> {
    const state = await loadChannelState();
    if (state.token && state.token.expiresAt > Date.now()) {
      this.token = state.token;
      this.emit({ type: 'authenticated' });
      return true;
    }
    return false;
  }

  async startQrLogin(): Promise<ILinkQrSession> {
    const session: ILinkQrSession = {
      sessionId: crypto.randomUUID(),
      qrCodeUrl: '',
      expiresAt: Date.now() + 120_000,
    };
    this.emit({ type: 'qr_ready', session });
    return session;
  }

  async startPolling(): Promise<void> {
    if (this.polling) return;
    if (!this.token) {
      this.emit({ type: 'error', code: 'not_authenticated', message: 'Cannot poll without authentication.' });
      return;
    }
    this.polling = true;
    this.emit({ type: 'authenticated' });
  }

  stopPolling(): void { this.polling = false; }

  async sendReply(_message: ILinkOutboundMessage): Promise<void> {
    if (!this.token) throw new Error('Not authenticated.');
  }

  async logout(): Promise<void> {
    this.stopPolling();
    this.token = null;
    await clearChannelState();
    this.emit({ type: 'disconnected', reason: 'logout' });
  }

  get isAuthenticated(): boolean {
    return this.token !== null && this.token.expiresAt > Date.now();
  }
}
