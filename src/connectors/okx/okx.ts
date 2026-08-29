import * as crypto from 'crypto';

import { VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

import { Solana } from '../../chains/solana/solana';
import { createHttpClient, HttpClient, HttpClientError } from '../../services/http-client';
import { logger } from '../../services/logger';

import { OkxConfig } from './okx.config';

// OKX DEX aggregator API (https://web3.okx.com/build/dev-docs)
const OKX_API_BASE = 'https://web3.okx.com';
const OKX_AGGREGATOR_PATH = '/api/v6/dex/aggregator';

// OKX chainIndex for Solana
const SOLANA_CHAIN_INDEX = '501';

// Fallback approve spenders per chainIndex (refreshed from /supported/chain at runtime)
const FALLBACK_APPROVE_SPENDER: Record<string, string> = {
  '4663': '0x42170295F1173c9e5874ea9d00c6d137E1a4f53d',
};

export interface OkxEvmTx {
  to: string;
  data: string;
  value?: string;
  gas?: string;
  gasPrice?: string;
}

// Type definitions for OKX API responses
export interface OkxRouterResult {
  fromTokenAmount: string;
  toTokenAmount: string;
  priceImpactPercent?: string;
  priceImpactPercentage?: string;
  dexRouterList?: any[];
  estimateGasFee?: string;
  [key: string]: any;
}

export interface OkxSwapResult {
  routerResult: OkxRouterResult;
  tx: {
    data: string;
    from?: string;
    minReceiveAmount?: string;
    [key: string]: any;
  };
}

interface OkxEnvelope<T> {
  code: string;
  msg: string;
  data: T[];
}

export class Okx {
  private static _instances: { [name: string]: Okx };
  private solana: Solana;
  private chainIndex: string = SOLANA_CHAIN_INDEX;
  public config: OkxConfig.RootConfig;
  private httpClient: HttpClient;
  private approveSpenderCache?: string;

  private constructor() {
    this.config = OkxConfig.config;
    this.solana = null;

    if (!this.config.apiKey || !this.config.secretKey || !this.config.passphrase) {
      throw new Error(
        'OKX DEX API credentials are not configured. Set okx.apiKey, okx.secretKey and okx.passphrase ' +
          'in conf/connectors/okx.yml (create them at https://web3.okx.com/build/dev-portal).',
      );
    }

    this.httpClient = createHttpClient({
      baseURL: OKX_API_BASE,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Gets or creates a singleton instance of Okx for the specified network
   */
  public static async getInstance(network: string): Promise<Okx> {
    if (!Okx._instances) {
      Okx._instances = {};
    }
    if (!Okx._instances[network]) {
      const instance = new Okx();
      await instance.init(network);
      Okx._instances[network] = instance;
    }
    return Okx._instances[network];
  }

  private async init(network: string): Promise<void> {
    try {
      if (OkxConfig.EVM_NETWORKS.includes(network)) {
        this.chainIndex = OkxConfig.CHAIN_INDEX[network];
        this.solana = null;
        logger.info(`Initialized OKX DEX aggregator for EVM network: ${network} (chainIndex ${this.chainIndex})`);
        return;
      }
      this.chainIndex = SOLANA_CHAIN_INDEX;
      this.solana = await Solana.getInstance(network);
      logger.info('Initialized OKX DEX aggregator for network:', network);
    } catch (error) {
      logger.error('Failed to initialize OKX DEX aggregator:', error);
      throw error;
    }
  }

  /**
   * Builds the OKX authentication headers for a request.
   * OK-ACCESS-SIGN = base64(HMAC-SHA256(timestamp + method + requestPathWithQuery, secretKey))
   * The signed string must match the request path + query EXACTLY as sent.
   */
  public signedHeaders(
    method: 'GET' | 'POST',
    requestPathWithQuery: string,
    timestamp?: string,
  ): Record<string, string> {
    const ts = timestamp ?? new Date().toISOString();
    const sign = crypto
      .createHmac('sha256', this.config.secretKey)
      .update(ts + method + requestPathWithQuery)
      .digest('base64');
    return {
      'OK-ACCESS-KEY': this.config.apiKey,
      'OK-ACCESS-SIGN': sign,
      'OK-ACCESS-PASSPHRASE': this.config.passphrase,
      'OK-ACCESS-TIMESTAMP': ts,
    };
  }

  /**
   * Performs a signed GET request. The query string is serialized here (never via the
   * HttpClient params option) so the signed string is byte-identical to the request path.
   * Unwraps the OKX `{code, msg, data[]}` envelope and throws on non-zero codes.
   */
  private async signedGet<T>(path: string, params: Record<string, string>): Promise<T> {
    const queryString = new URLSearchParams(params).toString();
    const pathWithQuery = `${path}?${queryString}`;
    const headers = this.signedHeaders('GET', pathWithQuery);

    let envelope: OkxEnvelope<T>;
    try {
      const response = await this.httpClient.get<OkxEnvelope<T>>(pathWithQuery, { headers });
      envelope = response.data;
    } catch (error) {
      if (error instanceof HttpClientError) {
        logger.error('OKX API error:', error.message);
        const data = error.response?.data;
        if (data) {
          logger.error('OKX API error response:', data);
          const apiMessage = typeof data === 'string' ? data : data.msg || data.error || JSON.stringify(data);
          throw new Error(`OKX API error: ${apiMessage}`);
        }
      }
      throw error;
    }

    if (!envelope || envelope.code !== '0') {
      throw new Error(`OKX API error (code ${envelope?.code}): ${envelope?.msg || 'unknown error'}`);
    }
    if (!envelope.data || envelope.data.length === 0) {
      throw new Error('OKX API returned an empty data array');
    }
    return envelope.data[0];
  }

  /**
   * Gets a wallet-free quote from the OKX DEX aggregator
   * @param fromMint Input token mint address
   * @param toMint Output token mint address
   * @param amountRaw Amount in smallest units (input for exactIn, output for exactOut)
   * @param swapMode 'exactIn' (default) or 'exactOut'
   */
  async getQuote(
    fromMint: string,
    toMint: string,
    amountRaw: string,
    swapMode: 'exactIn' | 'exactOut' = 'exactIn',
  ): Promise<OkxRouterResult> {
    logger.info(`OKX quote: ${fromMint} -> ${toMint}, amountRaw=${amountRaw}, swapMode=${swapMode}`);
    return await this.signedGet<OkxRouterResult>(`${OKX_AGGREGATOR_PATH}/quote`, {
      chainIndex: this.chainIndex,
      fromTokenAddress: fromMint,
      toTokenAddress: toMint,
      amount: amountRaw,
      swapMode,
    });
  }

  /**
   * Gets an executable swap (route + serialized transaction) bound to a wallet
   */
  async getSwapTransaction(
    walletAddress: string,
    fromMint: string,
    toMint: string,
    amountRaw: string,
    swapMode: 'exactIn' | 'exactOut',
    slippagePct: number,
  ): Promise<{ routerResult: OkxRouterResult; transaction: VersionedTransaction }> {
    const params: Record<string, string> = {
      chainIndex: this.chainIndex,
      fromTokenAddress: fromMint,
      toTokenAddress: toMint,
      amount: amountRaw,
      swapMode,
      slippagePercent: slippagePct.toString(),
      userWalletAddress: walletAddress,
    };
    if (this.config.computeUnitPrice > 0) {
      params.computeUnitPrice = Math.floor(this.config.computeUnitPrice).toString();
    }

    logger.info(`OKX swap: ${fromMint} -> ${toMint}, amountRaw=${amountRaw}, wallet=${walletAddress}`);
    const swapResult = await this.signedGet<OkxSwapResult>(`${OKX_AGGREGATOR_PATH}/swap`, params);

    if (!swapResult.tx?.data) {
      throw new Error('OKX swap response did not include transaction data');
    }

    return {
      routerResult: swapResult.routerResult,
      transaction: this.deserializeTransaction(swapResult.tx.data),
    };
  }

  /**
   * Gets an executable EVM swap (route + unsigned tx fields) bound to a wallet.
   * Returned tx fields ({to,data,value,gas,gasPrice}) are signed + broadcast by the caller.
   */
  async getEvmSwapTransaction(
    walletAddress: string,
    fromToken: string,
    toToken: string,
    amountRaw: string,
    swapMode: 'exactIn' | 'exactOut',
    slippagePct: number,
  ): Promise<{ routerResult: OkxRouterResult; tx: OkxEvmTx }> {
    const params: Record<string, string> = {
      chainIndex: this.chainIndex,
      fromTokenAddress: fromToken,
      toTokenAddress: toToken,
      amount: amountRaw,
      swapMode,
      slippagePercent: slippagePct.toString(),
      userWalletAddress: walletAddress,
    };
    logger.info(`OKX EVM swap: ${fromToken} -> ${toToken}, amountRaw=${amountRaw}, wallet=${walletAddress}`);
    const swapResult = await this.signedGet<OkxSwapResult>(`${OKX_AGGREGATOR_PATH}/swap`, params);
    const tx = (swapResult as any).tx;
    if (!tx?.to || !tx?.data) {
      throw new Error('OKX EVM swap response did not include transaction fields (to/data)');
    }
    return { routerResult: swapResult.routerResult, tx };
  }

  /**
   * OKX DEX approve spender for this chainIndex (cached per instance).
   * Source: GET /supported/chain; falls back to hardcoded table on any failure.
   */
  async getApproveSpender(): Promise<string> {
    if (this.approveSpenderCache) return this.approveSpenderCache;
    try {
      const queryString = new URLSearchParams({}).toString();
      const path = `${OKX_AGGREGATOR_PATH}/supported/chain${queryString ? '?' + queryString : ''}`;
      const headers = this.signedHeaders('GET', path);
      const response = await this.httpClient.get<OkxEnvelope<any>>(path, { headers });
      const chains = response.data?.data || [];
      const mine = chains.find((c: any) => String(c.chainIndex) === this.chainIndex);
      if (mine?.dexTokenApproveAddress) {
        this.approveSpenderCache = mine.dexTokenApproveAddress;
      }
    } catch (error) {
      logger.warn(`OKX /supported/chain failed, using fallback spender: ${error.message}`);
    }
    if (!this.approveSpenderCache) {
      this.approveSpenderCache = FALLBACK_APPROVE_SPENDER[this.chainIndex];
    }
    if (!this.approveSpenderCache) {
      throw new Error(`No OKX approve spender known for chainIndex ${this.chainIndex}`);
    }
    return this.approveSpenderCache;
  }

  /**
   * Deserializes OKX Solana transaction data. OKX has served both base58- and
   * base64-encoded serialized transactions across API versions, so both encodings
   * are attempted before failing with a clear error.
   */
  private deserializeTransaction(txData: string): VersionedTransaction {
    const errors: string[] = [];
    for (const [encoding, decode] of [
      ['base58', () => bs58.decode(txData)],
      ['base64', () => Buffer.from(txData, 'base64')],
    ] as const) {
      try {
        return VersionedTransaction.deserialize(new Uint8Array(decode()));
      } catch (error) {
        errors.push(`${encoding}: ${error.message}`);
      }
    }
    throw new Error(`Unable to deserialize OKX transaction data (${errors.join('; ')})`);
  }
}
