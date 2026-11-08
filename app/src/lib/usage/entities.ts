/**
 * A live view of the Home Assistant entities the usage tracker watches.
 *
 * Uses the WebSocket `subscribe_entities` command, which sends the full state of
 * the named entities once and then only what changes, in HA's compressed format
 * (homeassistant/core.py `as_compressed_state`, websocket_api/messages.py
 * `_state_diff`):
 *
 *   {"a": {entity_id: {s, a, lc, lu?}}}               additions (the first snapshot)
 *   {"c": {entity_id: {"+": {s?, a?, lc?, lu?}, "-": {"a": [keys]}}}}   changes
 *   {"r": [entity_id, ...]}                           removals
 *
 * `lc`/`lu` are epoch seconds. A snapshot omits `lu` when it equals `lc`, and a
 * diff carries `lc` when the state value moved, otherwise `lu`.
 */
import WebSocket from 'ws';

export interface EntityState {
  state: string;
  attributes: Record<string, unknown>;
  /** When the state value last changed, epoch ms. */
  lastChanged: number;
  /** When the state or any attribute last changed, epoch ms. */
  lastUpdated: number;
}

export type EntityMap = Map<string, EntityState>;

interface Compressed { s?: string; a?: Record<string, unknown>; lc?: number; lu?: number }
export interface CompressedEvent {
  a?: Record<string, Compressed>;
  c?: Record<string, { '+'?: Compressed; '-'?: { a?: string[] } }>;
  r?: string[];
}

const ms = (seconds: number | undefined) =>
  typeof seconds === 'number' && Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;

/** Apply one `subscribe_entities` event to the map; returns the entity ids it touched. */
export function applyEvent(map: EntityMap, event: CompressedEvent, now = Date.now()): string[] {
  const touched: string[] = [];
  for (const [id, add] of Object.entries(event.a ?? {})) {
    const lastChanged = ms(add.lc) ?? now;
    map.set(id, { state: add.s ?? 'unknown', attributes: { ...add.a }, lastChanged, lastUpdated: ms(add.lu) ?? lastChanged });
    touched.push(id);
  }
  for (const [id, diff] of Object.entries(event.c ?? {})) {
    const prev = map.get(id) ?? { state: 'unknown', attributes: {}, lastChanged: now, lastUpdated: now };
    const plus = diff['+'] ?? {};
    const attributes = { ...prev.attributes };
    for (const key of diff['-']?.a ?? []) delete attributes[key];
    Object.assign(attributes, plus.a);
    const lastChanged = ms(plus.lc) ?? prev.lastChanged;
    map.set(id, {
      state: plus.s ?? prev.state,
      attributes,
      lastChanged,
      lastUpdated: ms(plus.lu) ?? (plus.lc !== undefined ? lastChanged : prev.lastUpdated),
    });
    touched.push(id);
  }
  for (const id of event.r ?? []) if (map.delete(id)) touched.push(id);
  return touched;
}

export interface SubscriptionOptions {
  /** Where to connect and with which token; resolved again for every connect. */
  connect: () => Promise<{ url: string; token: string } | null>;
  onChange: (touched: string[]) => void;
  onStatus: (connected: boolean, detail?: string) => void;
}

const PING_MS = 30_000;
const SILENCE_MS = 75_000;
const MAX_BACKOFF_MS = 60_000;
/**
 * Refusals of one token before it is no longer presented. HA counts failed
 * WebSocket logins towards its IP ban, which would lock the whole app out.
 */
const MAX_AUTH_FAILURES = 3;

export class EntitySubscription {
  readonly states: EntityMap = new Map();
  private socket: WebSocket | null = null;
  private wanted: string[] = [];
  private authed = false;
  private subscriptionId: number | null = null;
  private nextId = 1;
  private backoff = 1_000;
  private timers: NodeJS.Timeout[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** Counts connects and stops, so a connect that a newer one or stop() overtook gives up. */
  private attempt = 0;
  private refusedToken: string | null = null;
  private refusals = 0;
  private stopped = true;

  constructor(private readonly opts: SubscriptionOptions) {}

  get connected(): boolean {
    return this.authed && this.socket?.readyState === WebSocket.OPEN;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.attempt++;
    this.teardown();
    // Forgotten as well as cleared: reconnect() takes a timer that is still set
    // for a retry already on its way, so after a reconnect from Settings the
    // next dropped connection (HA restarting) was never retried.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** Watch exactly these entities, resubscribing on the open connection if the set changed. */
  watch(entityIds: string[]): void {
    const next = [...new Set(entityIds)].sort();
    if (next.join('\n') === this.wanted.join('\n')) return;
    this.wanted = next;
    for (const id of this.states.keys()) if (!next.includes(id)) this.states.delete(id);
    if (this.socket && this.connected) this.subscribe(this.socket);
  }

  private teardown(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const socket = this.socket;
    this.socket = null;
    this.authed = false;
    this.subscriptionId = null;
    if (socket) {
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.terminate();
    }
  }

  private reconnect(detail: string): void {
    this.teardown();
    if (this.stopped || this.reconnectTimer) return;
    this.opts.onStatus(false, detail);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  private send(socket: WebSocket, message: Record<string, unknown>): number {
    const id = this.nextId++;
    socket.send(JSON.stringify({ id, ...message }));
    return id;
  }

  private subscribe(socket: WebSocket): void {
    if (this.subscriptionId !== null) this.send(socket, { type: 'unsubscribe_events', subscription: this.subscriptionId });
    // Never with an empty list: HA reads that as "every entity".
    this.subscriptionId = this.wanted.length > 0
      ? this.send(socket, { type: 'subscribe_entities', entity_ids: this.wanted })
      : null;
  }

  private async connect(): Promise<void> {
    const attempt = ++this.attempt;
    let target: { url: string; token: string } | null = null;
    try {
      target = await this.opts.connect();
    } catch (err) {
      if (attempt !== this.attempt) return;
      return this.reconnect(`cannot reach Home Assistant: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Stopped, or restarted (a reconnect from Settings) while this one waited:
    // going on would open a second socket next to the newer one's.
    if (this.stopped || attempt !== this.attempt) return;
    if (!target) return this.reconnect('Home Assistant is not connected yet');
    if (target.token === this.refusedToken && this.refusals >= MAX_AUTH_FAILURES) {
      return this.reconnect('Home Assistant refused the access token; reconnect Home Assistant in Settings');
    }
    const token = target.token;

    let socket: WebSocket;
    try {
      socket = new WebSocket(`${target.url.replace(/^http/, 'ws').replace(/\/+$/, '')}/api/websocket`, { handshakeTimeout: 15_000 });
    } catch (err) {
      return this.reconnect(`bad Home Assistant address: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.socket = socket;
    let lastHeard = Date.now();
    const heard = () => { lastHeard = Date.now(); };

    socket.on('ping', heard);
    socket.on('pong', heard);
    socket.on('error', err => this.reconnect(err.message));
    socket.on('close', () => this.reconnect('connection closed'));
    socket.on('message', data => {
      heard();
      let msg: { type?: string; id?: number; event?: CompressedEvent; message?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'auth_required') {
        socket.send(JSON.stringify({ type: 'auth', access_token: token }));
      } else if (msg.type === 'auth_invalid') {
        this.refusals = this.refusedToken === token ? this.refusals + 1 : 1;
        this.refusedToken = token;
        this.backoff = MAX_BACKOFF_MS;
        this.reconnect(`Home Assistant refused the access token${msg.message ? `: ${msg.message}` : ''}`);
      } else if (msg.type === 'auth_ok') {
        this.backoff = 1_000;
        this.refusals = 0;
        this.authed = true;
        this.states.clear();
        this.subscribe(socket);
        this.timers.push(setInterval(() => {
          if (Date.now() - lastHeard > SILENCE_MS) this.reconnect('Home Assistant stopped responding');
          else if (socket.readyState === WebSocket.OPEN) this.send(socket, { type: 'ping' });
        }, PING_MS));
        this.opts.onStatus(true);
      } else if (msg.type === 'event' && msg.id === this.subscriptionId && msg.event) {
        const touched = applyEvent(this.states, msg.event);
        if (touched.length > 0) this.opts.onChange(touched);
      }
    });
    // A handshake nobody answers produces no event at all; the ws timeout covers it.
  }
}
