import { RawData, WebSocket } from 'ws';

import { logger } from '../../services/logger';

export interface WatchedAccountState {
  /** Raw account data (decoded from base64 notification or RPC getAccountInfo) */
  data: Buffer;
  /** Slot the state was produced in (0 for RPC resyncs) */
  slot: number;
  /** Date.now() of the last update (notification or resync) */
  updatedAt: number;
}

interface WatchEntry {
  state: WatchedAccountState | null;
  subId: number | null;
  lastAccess: number;
}

const PING_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 10_000;
const SANITY_INTERVAL_MS = 60_000;
const IDLE_TIMEOUT_MS = 10 * 60_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Watches Solana accounts (DLMM lbPair pool state) over a PubSub WebSocket so
 * hot read paths (position-info polling for auto-close triggers) can serve
 * fresh state without an RPC round-trip per tick.
 *
 * Liveness, three layers:
 *  1. protocol ping/pong — ws.ping() every 15s, terminate if no pong in 10s;
 *  2. reconnect with exponential backoff (1s → 30s cap), resubscribe everything
 *     and RPC-resync every watched pool on reconnect;
 *  3. 60s sanity RPC refetch per pool (guards silently missed notifications).
 *
 * Pools not accessed for 10 minutes are unsubscribed; when nothing is watched
 * the socket closes and the watcher sleeps until the next watch() call.
 *
 * NOTE: subscriptions MUST use commitment 'confirmed' — the Solana default is
 * 'finalized', which trails ~10-15s behind and would be slower than polling.
 */
export class PoolWatcher {
  private ws: WebSocket | null = null;
  private connected = false;
  private destroyed = false;
  private reconnectDelay = 1_000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private sanityTimer: NodeJS.Timeout | null = null;
  private reqId = 0;
  private readonly pendingSub = new Map<number, string>();
  private readonly subToPool = new Map<number, string>();
  private readonly pools = new Map<string, WatchEntry>();

  /**
   * @param wsUrl  PubSub endpoint (e.g. wss://rpc.ams.shyft.to?api_key=...)
   * @param resync RPC fallback: fetch raw account data for a pool (getAccountInfo)
   */
  constructor(
    private readonly wsUrl: string,
    private readonly resync: (poolAddress: string) => Promise<Buffer | null>,
  ) {}

  /** Start watching a pool (idempotent). First state fill happens via RPC resync
   * so callers get data before the first notification arrives. */
  public watch(poolAddress: string): void {
    const entry = this.pools.get(poolAddress);
    if (entry) {
      entry.lastAccess = Date.now();
      return;
    }
    this.pools.set(poolAddress, { state: null, subId: null, lastAccess: Date.now() });
    this.destroyed = false;
    void this.resyncPool(poolAddress);
    if (this.connected) {
      this.subscribe(poolAddress);
    } else {
      this.connect();
    }
    this.startSanityTimer();
  }

  /** Latest known state for a pool, or null if nothing received yet. */
  public getState(poolAddress: string): WatchedAccountState | null {
    const entry = this.pools.get(poolAddress);
    if (!entry) {
      return null;
    }
    entry.lastAccess = Date.now();
    return entry.state;
  }

  public watchedCount(): number {
    return this.pools.size;
  }

  public destroy(): void {
    this.destroyed = true;
    this.stopTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    this.pools.clear();
    this.subToPool.clear();
    this.pendingSub.clear();
  }

  // ------------------------------------------------------------------ internals

  private connect(): void {
    if (this.destroyed || this.ws) {
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl);
    } catch (e) {
      logger.warn(`PoolWatcher: connect failed: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.reconnectDelay = 1_000;
      logger.info(`PoolWatcher: connected, resubscribing ${this.pools.size} pool(s)`);
      for (const pool of this.pools.keys()) {
        this.subscribe(pool);
        void this.resyncPool(pool);
      }
      this.startPing();
    });
    ws.on('message', (raw: RawData) => this.onMessage(raw));
    ws.on('pong', () => {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
    });
    ws.on('error', (e: Error) => {
      logger.warn(`PoolWatcher: socket error: ${e.message}`);
      ws.terminate(); // triggers 'close'
    });
    ws.on('close', () => this.handleDrop());
  }

  private handleDrop(): void {
    if (this.ws === null && !this.connected) {
      return;
    }
    this.ws = null;
    this.connected = false;
    this.stopPing();
    for (const entry of this.pools.values()) {
      entry.subId = null;
    }
    this.subToPool.clear();
    this.pendingSub.clear();
    if (!this.destroyed && this.pools.size > 0) {
      logger.warn('PoolWatcher: connection dropped, scheduling reconnect');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.destroyed) {
      return;
    }
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private subscribe(poolAddress: string): void {
    if (!this.ws || !this.connected) {
      return;
    }
    const id = ++this.reqId;
    this.pendingSub.set(id, poolAddress);
    this.ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'accountSubscribe',
        // commitment MUST be explicit: the default 'finalized' trails ~10-15s
        params: [poolAddress, { encoding: 'base64', commitment: 'confirmed' }],
      }),
    );
  }

  private unsubscribe(subId: number | null): void {
    if (this.ws && this.connected && subId !== null) {
      const id = ++this.reqId;
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'accountUnsubscribe', params: [subId] }));
    }
  }

  private onMessage(raw: RawData): void {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // subscription ack
    if (msg.id !== undefined && this.pendingSub.has(msg.id)) {
      const pool = this.pendingSub.get(msg.id)!;
      this.pendingSub.delete(msg.id);
      if (msg.error) {
        logger.warn(`PoolWatcher: subscribe rejected for ${pool}: ${JSON.stringify(msg.error)}`);
        return;
      }
      const entry = this.pools.get(pool);
      if (entry) {
        entry.subId = msg.result;
        this.subToPool.set(msg.result, pool);
      }
      return;
    }
    if (msg.method !== 'accountNotification') {
      return;
    }
    const subId = msg.params?.subscription;
    const pool = this.subToPool.get(subId);
    if (!pool) {
      return;
    }
    const entry = this.pools.get(pool);
    if (!entry) {
      return;
    }
    try {
      const value = msg.params.result.value;
      // accountNotification shape: params.result = { context: { slot }, value }
      const slot = msg.params.result.context?.slot ?? 0;
      const b64 = Array.isArray(value.data) ? value.data[0] : value.data;
      entry.state = { data: Buffer.from(b64, 'base64'), slot, updatedAt: Date.now() };
    } catch (e) {
      logger.warn(`PoolWatcher: bad notification for ${pool}: ${(e as Error).message}`);
    }
  }

  private async resyncPool(poolAddress: string): Promise<void> {
    try {
      const data = await this.resync(poolAddress);
      const entry = this.pools.get(poolAddress);
      if (entry && data) {
        entry.state = { data, slot: 0, updatedAt: Date.now() };
      }
    } catch (e) {
      logger.warn(`PoolWatcher: resync failed for ${poolAddress}: ${(e as Error).message}`);
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.ws || !this.connected) {
        return;
      }
      try {
        this.ws.ping();
        this.pongTimer = setTimeout(() => {
          logger.warn('PoolWatcher: pong timeout, terminating socket');
          this.ws?.terminate();
        }, PONG_TIMEOUT_MS);
      } catch {
        this.ws?.terminate();
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private startSanityTimer(): void {
    if (this.sanityTimer) {
      return;
    }
    this.sanityTimer = setInterval(() => {
      const now = Date.now();
      for (const [pool, entry] of this.pools) {
        if (now - entry.lastAccess > IDLE_TIMEOUT_MS) {
          logger.info(`PoolWatcher: ${pool} idle >10min, unsubscribing`);
          this.unsubscribe(entry.subId);
          this.subToPool.delete(entry.subId ?? -1);
          this.pools.delete(pool);
          continue;
        }
        void this.resyncPool(pool);
      }
      if (this.pools.size === 0) {
        logger.info('PoolWatcher: nothing watched, closing socket');
        this.stopTimers();
        this.ws?.close();
        this.ws = null;
        this.connected = false;
      }
    }, SANITY_INTERVAL_MS);
  }

  private stopTimers(): void {
    this.stopPing();
    if (this.sanityTimer) {
      clearInterval(this.sanityTimer);
      this.sanityTimer = null;
    }
  }
}
