import { z } from 'zod';
import { installationInquiries, installationSignets, kingdomUrl, signetProof } from './client';
import { installationSnapshotSchema, installationSocketAction } from './contracts';

export type InstallationSnapshot = z.infer<typeof installationSnapshotSchema>;

export type InstallationSocketOptions = {
  url: string;
  keyFile: string;
  onSnapshot: (snapshot: InstallationSnapshot) => void | Promise<void>;
  /** Kingdom revoked this installation; the socket has stopped for good. */
  onRevoked?: () => void;
  onError?: (error: unknown) => void;
  /** Where Kingdom can reach this installation's viewer (Foundry's tunnel); re-advertised on every connect. */
  viewerUrl?: string | null;
  pingMs?: number;
  pollMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  WebSocket?: typeof WebSocket;
};

const frameSchema = z.object({ type: z.string() }).loose();

/**
 * Kingdom's live line to an Installation. It proves the installation's key, then receives a
 * snapshot of its inquiries and Signets on connect and again whenever one changes. While the
 * socket is down it polls the same reads, so nothing waits on the socket coming back.
 */
export class InstallationSocket {
  private socket: WebSocket | null = null;
  private stopped = false;
  private attempts = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private authenticated = false;
  private polling = false;
  private pollGeneration = 0;
  private viewerUrl: string | null;

  constructor(private readonly options: InstallationSocketOptions) {
    this.viewerUrl = options.viewerUrl ?? null;
  }

  get connected() {
    return this.authenticated;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  /** Tell Kingdom this installation is restarting (presence shows it as such), then close. */
  restarting() {
    this.send({ action: 'restarting' });
    this.close();
  }

  advertise(viewerUrl: string | null) {
    this.viewerUrl = viewerUrl;
    if (this.authenticated) this.send({ action: 'advertise', viewerUrl });
  }

  close() {
    this.stopped = true;
    this.clearTimers();
    this.socket?.close(1000, 'closed');
    this.socket = null;
    this.authenticated = false;
  }

  private connect() {
    if (this.stopped) return;
    const Socket = this.options.WebSocket ?? WebSocket;
    const socket = new Socket(kingdomUrl(this.options.url).replace(/^http/, 'ws'));
    this.socket = socket;
    socket.onmessage = (event) => void this.receive(socket, String(event.data));
    socket.onclose = () => this.disconnected(socket);
    socket.onerror = () => socket.close();
  }

  private async receive(socket: WebSocket, raw: string) {
    let parsed: ReturnType<typeof frameSchema.safeParse>;
    try {
      parsed = frameSchema.safeParse(JSON.parse(raw));
    } catch {
      return;
    }
    if (!parsed.success || socket !== this.socket) return;
    const frame = parsed.data;
    try {
      switch (frame.type) {
        case 'connected':
          this.send({
            action: 'authenticateInstallation',
            proof: await signetProof(
              this.options.url,
              installationSocketAction,
              this.options.keyFile,
            ),
          });
          return;
        case 'installation':
          this.authenticated = true;
          this.attempts = 0;
          this.stopPolling();
          this.pingTimer ??= setInterval(
            () => this.send({ action: 'ping' }),
            this.options.pingMs ?? 20_000,
          );
          if (this.viewerUrl) this.send({ action: 'advertise', viewerUrl: this.viewerUrl });
          return;
        case 'installation.snapshot':
          await this.options.onSnapshot(installationSnapshotSchema.parse(frame));
          return;
        case 'installationRejected':
          socket.close();
          return;
        case 'installationRevoked':
          this.close();
          this.options.onRevoked?.();
          return;
        case 'reconnect':
          socket.close();
          return;
        case 'advertiseRejected':
          this.options.onError?.(Error(`Kingdom refused viewer URL ${this.viewerUrl}`));
          return;
      }
    } catch (error) {
      this.options.onError?.(error);
      if (frame.type === 'connected') socket.close();
    }
  }

  private send(frame: Record<string, unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private disconnected(socket: WebSocket) {
    if (socket !== this.socket) return;
    this.socket = null;
    this.authenticated = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.stopped) return;
    if (!this.polling) void this.poll();
    const base = this.options.retryBaseMs ?? 1_000;
    const delay = Math.min(base * 2 ** this.attempts++, this.options.retryMaxMs ?? 30_000);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private async poll(generation = ++this.pollGeneration) {
    if (this.stopped || this.authenticated || generation !== this.pollGeneration) return;
    this.polling = true;
    try {
      const [inquiries, signets] = await Promise.all([
        installationInquiries(this.options.url, this.options.keyFile),
        installationSignets(this.options.url, this.options.keyFile),
      ]);
      if (!this.authenticated) await this.options.onSnapshot({ ...inquiries, ...signets });
    } catch (error) {
      this.options.onError?.(error);
    }
    if (this.stopped || this.authenticated || generation !== this.pollGeneration) return;
    this.pollTimer = setTimeout(() => void this.poll(generation), this.options.pollMs ?? 60_000);
  }

  private stopPolling() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.polling = false;
    this.pollGeneration++;
  }

  private clearTimers() {
    this.stopPolling();
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pingTimer = null;
    this.retryTimer = null;
  }
}
