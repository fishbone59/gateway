import { Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Agent, request as undiciRequest } from 'undici';

import { Solana } from '../../../chains/solana/solana';
import { httpErrors } from '../../../services/error-handler';
import { HttpClientError } from '../../../services/http-client';
import { logger } from '../../../services/logger';
import { JupiterConfig } from '../jupiter.config';

// Jupiter Trigger V2 API (limit orders / TP-SL / DCA). Requires a Jupiter API key.
const TRIGGER_API_BASE = 'https://api.jup.ag/trigger/v2';

// api.jup.ag /trigger/v2/* blackholes HTTP/1.1 requests (verified 2026-07-27:
// curl --http1.1 times out, h2 succeeds). Force HTTP/2 via undici Agent.
const triggerH2Agent = new Agent({ allowH2: true });

// JWT is valid 24h; refresh 30min before expiry to be safe.
const JWT_TTL_MS = 24 * 60 * 60 * 1000;
const JWT_REFRESH_MARGIN_MS = 30 * 60 * 1000;

interface JwtCacheEntry {
  token: string;
  expiresAt: number;
}

export interface VaultInfo {
  userPubkey: string;
  vaultPubkey: string;
  privyVaultId?: string;
  privyUserId?: string | null;
}

export interface CreateTriggerOrderParams {
  orderType: 'single' | 'oco' | 'otoco';
  inputMint: string;
  outputMint: string;
  inputAmountRaw: string; // smallest units
  triggerMint: string;
  expiresAt: number; // ms timestamp
  triggerCondition?: 'above' | 'below';
  triggerPriceUsd?: number;
  trailingBps?: number;
  slippageBps?: number;
  tpPriceUsd?: number;
  slPriceUsd?: number;
  tpSlippageBps?: number;
  slSlippageBps?: number;
}

export interface CreateTriggerOrderResult {
  id: string;
  txSignature: string;
  depositConfirmed: boolean;
  vaultPubkey: string;
  message?: string;
}

export interface CancelOrderResult {
  id: string;
  txSignature: string;
}

export class JupiterTriggerClient {
  private static _instances: { [network: string]: JupiterTriggerClient } = {};

  private solana: Solana;
  private apiKey: string;
  private jwtCache: Map<string, JwtCacheEntry> = new Map();

  private constructor() {
    const apiKey = JupiterConfig.config.apiKey;
    if (!apiKey || apiKey.length === 0) {
      throw httpErrors.badRequest(
        'Jupiter Trigger V2 requires a Jupiter API key. Set jupiter.apiKey in Gateway config (get one at https://portal.jup.ag).',
      );
    }
    this.apiKey = apiKey;
  }

  public static async getInstance(network: string): Promise<JupiterTriggerClient> {
    if (!JupiterTriggerClient._instances[network]) {
      const client = new JupiterTriggerClient();
      client.solana = await Solana.getInstance(network);
      JupiterTriggerClient._instances[network] = client;
    }
    return JupiterTriggerClient._instances[network];
  }

  /** Public view of JWT cache state (no token material exposed). */
  public getAuthStatus(walletAddress: string): { walletAddress: string; jwtCached: boolean; expiresAt: number | null } {
    const entry = this.jwtCache.get(walletAddress);
    const valid = !!entry && entry.expiresAt - Date.now() > JWT_REFRESH_MARGIN_MS;
    return { walletAddress, jwtCached: valid, expiresAt: valid ? entry!.expiresAt : null };
  }

  // ---------------------------------------------------------------------
  // Auth (challenge-response JWT, cached per wallet)
  // ---------------------------------------------------------------------

  private async getJwt(walletAddress: string, forceRefresh = false): Promise<string> {
    const cached = this.jwtCache.get(walletAddress);
    if (!forceRefresh && cached && cached.expiresAt - Date.now() > JWT_REFRESH_MARGIN_MS) {
      return cached.token;
    }

    logger.info(`Jupiter Trigger: authenticating wallet ${walletAddress} (challenge-response)`);
    const keypair = await this.solana.getWallet(walletAddress);

    const challengeResp = await this.request<{ challenge: string }>('POST', '/auth/challenge', undefined, {
      walletPubkey: walletAddress,
      type: 'message',
    });

    const signature = nacl.sign.detached(new TextEncoder().encode(challengeResp.challenge), keypair.secretKey);

    const verifyResp = await this.request<{ token: string }>('POST', '/auth/verify', undefined, {
      type: 'message',
      walletPubkey: walletAddress,
      signature: bs58.encode(signature),
    });

    this.jwtCache.set(walletAddress, { token: verifyResp.token, expiresAt: Date.now() + JWT_TTL_MS });
    return verifyResp.token;
  }

  // ---------------------------------------------------------------------
  // HTTP plumbing
  // ---------------------------------------------------------------------

  /** Low-level HTTP via undici request() with the H2 agent (fetch+dispatcher interop is broken across undici majors). */
  private async rawRequest<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    headers?: Record<string, string>,
    body?: any,
    params?: Record<string, string | number>,
  ): Promise<T> {
    const url = new URL(`${TRIGGER_API_BASE}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.append(k, String(v));
      }
    }
    // H2 streams to api.jup.ag are flaky (~40% stall rate from this host, 2026-07-27).
    // Retry idempotent calls aggressively. Money-moving POSTs (orders/price,
    // confirm-cancel) are NOT retried here — re-invoke the endpoint instead.
    const RETRYABLE_POSTS = ['/auth/challenge', '/auth/verify', '/deposit/craft'];
    const maxAttempts = method === 'GET' ? 5 : RETRYABLE_POSTS.includes(path) ? 3 : 1;
    let lastError: HttpClientError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let resp;
      try {
        resp = await undiciRequest(url.toString(), {
          method,
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            ...headers,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          dispatcher: triggerH2Agent,
          headersTimeout: 30000,
          bodyTimeout: 30000,
        });
      } catch (error: any) {
        lastError = new HttpClientError(error.message || 'network error', { code: 'ENETWORK' });
        logger.warn(`Jupiter Trigger: ${method} ${path} attempt ${attempt}/${maxAttempts} failed: ${error.message}`);
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        continue;
      }
      const text = await resp.body.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      if (resp.statusCode >= 400) {
        throw new HttpClientError(`Request failed with status ${resp.statusCode}`, {
          status: resp.statusCode,
          data,
        });
      }
      return data as T;
    }
    throw lastError ?? new HttpClientError('network error', { code: 'ENETWORK' });
  }

  /** Unauthenticated request (challenge/verify). */
  private async request<T>(method: 'GET' | 'POST', path: string, token?: string, body?: any): Promise<T> {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    try {
      return await this.rawRequest<T>(method, path, headers, body);
    } catch (error) {
      throw this.mapApiError(error);
    }
  }

  /** Authenticated request with one JWT-refresh retry on 401. */
  private async authed<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    walletAddress: string,
    body?: any,
    params?: Record<string, string | number>,
  ): Promise<T> {
    let token = await this.getJwt(walletAddress);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const headers = { Authorization: `Bearer ${token}` };
        return await this.rawRequest<T>(method, path, headers, body, params);
      } catch (error) {
        if (error instanceof HttpClientError && error.status === 401 && attempt === 0) {
          logger.warn('Jupiter Trigger: 401 received, refreshing JWT and retrying once');
          token = await this.getJwt(walletAddress, true);
          continue;
        }
        throw this.mapApiError(error);
      }
    }
    throw httpErrors.internalServerError('Jupiter Trigger: unexpected auth retry exhaustion');
  }

  private mapApiError(error: any): Error {
    if (error instanceof HttpClientError) {
      const detail =
        error.data && typeof error.data === 'object'
          ? (error.data.error ?? JSON.stringify(error.data))
          : (error.data ?? error.message);
      const msg = `Jupiter Trigger API error (${error.status}): ${detail}`;
      if (error.status === 400) return httpErrors.badRequest(msg);
      if (error.status === 401 || error.status === 403) return httpErrors.forbidden(msg);
      if (error.status === 404) return httpErrors.notFound(msg);
      return httpErrors.internalServerError(msg);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private signBase64Transaction(base64Tx: string, keypair: Keypair): string {
    const tx = VersionedTransaction.deserialize(new Uint8Array(Buffer.from(base64Tx, 'base64')));
    tx.sign([keypair]);
    return Buffer.from(tx.serialize()).toString('base64');
  }

  // ---------------------------------------------------------------------
  // Vault
  // ---------------------------------------------------------------------

  /** Returns vault info, or null when the wallet has no vault yet. */
  public async getVault(walletAddress: string): Promise<VaultInfo | null> {
    try {
      return await this.authed<VaultInfo>('GET', '/vault', walletAddress);
    } catch (error: any) {
      if (error.statusCode === 404) return null;
      throw error;
    }
  }

  public async registerVault(walletAddress: string): Promise<VaultInfo> {
    return await this.authed<VaultInfo>('GET', '/vault/register', walletAddress);
  }

  private async ensureVault(walletAddress: string): Promise<VaultInfo> {
    const existing = await this.getVault(walletAddress);
    if (existing) return existing;
    logger.info(`Jupiter Trigger: no vault for ${walletAddress}, registering one`);
    return await this.registerVault(walletAddress);
  }

  // ---------------------------------------------------------------------
  // Orders
  // ---------------------------------------------------------------------

  /**
   * Full create flow: ensure vault -> craft deposit -> sign deposit -> submit order.
   * The deposit transaction is broadcast by Jupiter as part of order creation.
   */
  public async createOrder(walletAddress: string, params: CreateTriggerOrderParams): Promise<CreateTriggerOrderResult> {
    const vault = await this.ensureVault(walletAddress);

    const orderSubType = params.orderType; // single | oco | otoco (price orders)
    const deposit = await this.authed<{ requestId: string; transaction: string }>(
      'POST',
      '/deposit/craft',
      walletAddress,
      {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        userAddress: walletAddress,
        amount: params.inputAmountRaw,
        orderType: 'price',
        orderSubType,
      },
    );

    const keypair = await this.solana.getWallet(walletAddress);
    const depositSignedTx = this.signBase64Transaction(deposit.transaction, keypair);

    const body: Record<string, any> = {
      orderType: params.orderType,
      depositRequestId: deposit.requestId,
      depositSignedTx,
      userPubkey: walletAddress,
      inputMint: params.inputMint,
      inputAmount: params.inputAmountRaw,
      outputMint: params.outputMint,
      triggerMint: params.triggerMint,
      expiresAt: params.expiresAt,
    };
    if (params.triggerCondition !== undefined) body.triggerCondition = params.triggerCondition;
    if (params.triggerPriceUsd !== undefined) body.triggerPriceUsd = params.triggerPriceUsd;
    if (params.trailingBps !== undefined) body.trailingBps = params.trailingBps;
    if (params.slippageBps !== undefined) body.slippageBps = params.slippageBps;
    if (params.tpPriceUsd !== undefined) body.tpPriceUsd = params.tpPriceUsd;
    if (params.slPriceUsd !== undefined) body.slPriceUsd = params.slPriceUsd;
    if (params.tpSlippageBps !== undefined) body.tpSlippageBps = params.tpSlippageBps;
    if (params.slSlippageBps !== undefined) body.slSlippageBps = params.slSlippageBps;

    logger.info(
      `Jupiter Trigger: creating ${params.orderType} order for ${walletAddress}, ` +
        `${params.inputAmountRaw} of ${params.inputMint} -> ${params.outputMint}`,
    );

    const result = await this.authed<{ id: string; txSignature: string; depositConfirmed: boolean; message?: string }>(
      'POST',
      '/orders/price',
      walletAddress,
      body,
    );

    return { ...result, vaultPubkey: vault.vaultPubkey };
  }

  /** Order history (also serves as per-order status: filter client-side by id). */
  public async getOrders(
    walletAddress: string,
    filters: { state?: 'active' | 'past'; mint?: string; limit?: number; offset?: number; sort?: string; dir?: string },
  ): Promise<any> {
    const params: Record<string, string | number> = {};
    if (filters.state) params.state = filters.state;
    if (filters.mint) params.mint = filters.mint;
    if (filters.limit !== undefined) params.limit = filters.limit;
    if (filters.offset !== undefined) params.offset = filters.offset;
    if (filters.sort) params.sort = filters.sort;
    if (filters.dir) params.dir = filters.dir;
    return await this.authed<any>('GET', '/orders/history', walletAddress, undefined, params);
  }

  public async updateOrder(walletAddress: string, orderId: string, body: Record<string, any>): Promise<{ id: string }> {
    return await this.authed<{ id: string }>('PATCH', `/orders/price/${orderId}`, walletAddress, body);
  }

  /**
   * Two-step cancel done server-side: initiate (get unsigned withdrawal tx) ->
   * sign -> confirm-cancel. Funds return to the wallet.
   */
  public async cancelOrder(walletAddress: string, orderId: string): Promise<CancelOrderResult> {
    const initiate = await this.authed<{ id: string; transaction: string; requestId: string }>(
      'POST',
      `/orders/price/cancel/${orderId}`,
      walletAddress,
      {},
    );

    const keypair = await this.solana.getWallet(walletAddress);
    const signedTransaction = this.signBase64Transaction(initiate.transaction, keypair);

    const confirmed = await this.authed<{ id: string; txSignature: string }>(
      'POST',
      `/orders/price/confirm-cancel/${orderId}`,
      walletAddress,
      { signedTransaction, cancelRequestId: initiate.requestId },
    );

    return confirmed;
  }
}
