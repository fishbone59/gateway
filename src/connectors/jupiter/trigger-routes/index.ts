import { Type, Static } from '@sinclair/typebox';
import { FastifyPluginAsync } from 'fastify';

import { getSolanaChainConfig } from '../../../chains/solana/solana.config';
import { Solana } from '../../../chains/solana/solana';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';

import { JupiterTriggerClient } from './trigger-client';

// Default wallet from Solana chain config (same pattern as unified swap routes)
let defaultWallet = '';
try {
  defaultWallet = getSolanaChainConfig().defaultWallet;
} catch {
  defaultWallet = '';
}

const NetworkField = Type.Optional(Type.String({ default: 'mainnet-beta' }));
const WalletField = Type.Optional(Type.String({ default: defaultWallet }));

const AuthStatusQuery = Type.Object({
  network: NetworkField,
  walletAddress: Type.String({ default: defaultWallet }),
});

const VaultQuery = Type.Object({
  network: NetworkField,
  walletAddress: Type.String({ default: defaultWallet }),
});

const VaultRegisterBody = Type.Object({
  network: NetworkField,
  walletAddress: WalletField,
});

const CreateOrderBody = Type.Object({
  network: NetworkField,
  walletAddress: WalletField,
  orderType: Type.Union([Type.Literal('single'), Type.Literal('oco'), Type.Literal('otoco')]),
  inputMint: Type.String(),
  outputMint: Type.String(),
  // Human-readable amount (needs token known to Gateway for decimals) OR raw smallest units
  inputAmount: Type.Optional(Type.Number()),
  inputAmountRaw: Type.Optional(Type.String()),
  triggerMint: Type.Optional(Type.String()),
  // Expiry: absolute ms timestamp or relative hours (default 168h = 7 days)
  expiresAt: Type.Optional(Type.Number()),
  expiresInHours: Type.Optional(Type.Number()),
  // single / otoco
  triggerCondition: Type.Optional(Type.Union([Type.Literal('above'), Type.Literal('below')])),
  triggerPriceUsd: Type.Optional(Type.Number()),
  trailingBps: Type.Optional(Type.Number()),
  slippageBps: Type.Optional(Type.Number()),
  // oco / otoco
  tpPriceUsd: Type.Optional(Type.Number()),
  slPriceUsd: Type.Optional(Type.Number()),
  tpSlippageBps: Type.Optional(Type.Number()),
  slSlippageBps: Type.Optional(Type.Number()),
});

const OrdersQuery = Type.Object({
  network: NetworkField,
  walletAddress: Type.String({ default: defaultWallet }),
  state: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('past')])),
  mint: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
  offset: Type.Optional(Type.Number()),
  sort: Type.Optional(Type.String()),
  dir: Type.Optional(Type.String()),
});

const UpdateOrderBody = Type.Object({
  network: NetworkField,
  walletAddress: WalletField,
  orderType: Type.Union([Type.Literal('single'), Type.Literal('oco'), Type.Literal('otoco')]),
  triggerPriceUsd: Type.Optional(Type.Number()),
  trailingBps: Type.Optional(Type.Number()),
  slippageBps: Type.Optional(Type.Number()),
  tpPriceUsd: Type.Optional(Type.Number()),
  slPriceUsd: Type.Optional(Type.Number()),
  tpSlippageBps: Type.Optional(Type.Number()),
  slSlippageBps: Type.Optional(Type.Number()),
});

const OrderIdParams = Type.Object({
  orderId: Type.String(),
});

const CancelOrderBody = Type.Object({
  network: NetworkField,
  walletAddress: WalletField,
});

type CreateOrderBodyType = Static<typeof CreateOrderBody>;

/** Validate type-specific required fields; fail fast before any deposit is crafted. */
const validateOrderParams = (body: CreateOrderBodyType): void => {
  if (body.inputAmount === undefined && body.inputAmountRaw === undefined) {
    throw httpErrors.badRequest('Provide inputAmount (human units) or inputAmountRaw (smallest units)');
  }
  if (body.inputAmount !== undefined && body.inputAmountRaw !== undefined) {
    throw httpErrors.badRequest('Provide only one of inputAmount / inputAmountRaw');
  }
  if (body.orderType === 'single') {
    if (!body.triggerCondition) {
      throw httpErrors.badRequest('single orders require triggerCondition (above|below)');
    }
    if (body.triggerPriceUsd === undefined && body.trailingBps === undefined) {
      throw httpErrors.badRequest('single orders require triggerPriceUsd or trailingBps');
    }
    if (body.triggerPriceUsd !== undefined && body.trailingBps !== undefined) {
      throw httpErrors.badRequest('Set triggerPriceUsd or trailingBps, not both');
    }
  }
  if (body.orderType === 'oco') {
    if (body.tpPriceUsd === undefined || body.slPriceUsd === undefined) {
      throw httpErrors.badRequest('oco orders require tpPriceUsd and slPriceUsd');
    }
  }
  if (body.orderType === 'otoco') {
    if (!body.triggerCondition || body.triggerPriceUsd === undefined) {
      throw httpErrors.badRequest('otoco orders require triggerCondition and triggerPriceUsd');
    }
    if (body.tpPriceUsd === undefined || body.slPriceUsd === undefined) {
      throw httpErrors.badRequest('otoco orders require tpPriceUsd and slPriceUsd');
    }
  }
  if (body.trailingBps !== undefined && (body.trailingBps < 50 || body.trailingBps > 9000)) {
    throw httpErrors.badRequest('trailingBps must be between 50 and 9000');
  }
};

export const jupiterTriggerRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /auth/status — JWT cache state for a wallet (debug/monitoring)
  fastify.get(
    '/auth/status',
    { schema: { description: 'Jupiter Trigger JWT cache status', tags: ['/connector/jupiter'], querystring: AuthStatusQuery } },
    async (request) => {
      const { network, walletAddress } = request.query as Static<typeof AuthStatusQuery>;
      const client = await JupiterTriggerClient.getInstance(network);
      return { ...client.getAuthStatus(walletAddress), apiKeyConfigured: true };
    },
  );

  // GET /vault — vault info or {vaultPubkey: null}
  fastify.get(
    '/vault',
    { schema: { description: 'Get Jupiter Trigger vault for a wallet', tags: ['/connector/jupiter'], querystring: VaultQuery } },
    async (request) => {
      const { network, walletAddress } = request.query as Static<typeof VaultQuery>;
      const client = await JupiterTriggerClient.getInstance(network);
      const vault = await client.getVault(walletAddress);
      return vault ?? { vaultPubkey: null, userPubkey: walletAddress };
    },
  );

  // POST /vault/register — idempotent vault creation
  fastify.post(
    '/vault/register',
    { schema: { description: 'Register Jupiter Trigger vault', tags: ['/connector/jupiter'], body: VaultRegisterBody } },
    async (request) => {
      const { network, walletAddress } = request.body as Static<typeof VaultRegisterBody>;
      if (!walletAddress) throw httpErrors.badRequest('walletAddress is required (no default wallet configured)');
      const client = await JupiterTriggerClient.getInstance(network);
      return await client.registerVault(walletAddress);
    },
  );

  // POST /orders — create single/oco/otoco order (craft deposit + sign + submit)
  fastify.post(
    '/orders',
    {
      schema: {
        description: 'Create a Jupiter Trigger V2 price order (single/oco/otoco)',
        tags: ['/connector/jupiter'],
        body: CreateOrderBody,
      },
    },
    async (request) => {
      const body = request.body as CreateOrderBodyType;
      if (!body.walletAddress) throw httpErrors.badRequest('walletAddress is required (no default wallet configured)');
      validateOrderParams(body);

      const network = body.network ?? 'mainnet-beta';
      const solana = await Solana.getInstance(network);

      // Resolve raw amount from human units if needed
      let inputAmountRaw = body.inputAmountRaw;
      if (inputAmountRaw === undefined) {
        const token = await solana.getToken(body.inputMint);
        if (!token) {
          throw httpErrors.badRequest(
            `Token ${body.inputMint} not found in Gateway token list; register it first or pass inputAmountRaw`,
          );
        }
        inputAmountRaw = Math.floor(body.inputAmount! * 10 ** token.decimals).toString();
      }

      const expiresAt =
        body.expiresAt ?? Date.now() + Math.floor((body.expiresInHours ?? 24 * 7) * 60 * 60 * 1000);

      const client = await JupiterTriggerClient.getInstance(network);
      try {
        return await client.createOrder(body.walletAddress, {
          orderType: body.orderType,
          inputMint: body.inputMint,
          outputMint: body.outputMint,
          inputAmountRaw,
          triggerMint: body.triggerMint ?? body.inputMint,
          expiresAt,
          triggerCondition: body.triggerCondition,
          triggerPriceUsd: body.triggerPriceUsd,
          trailingBps: body.trailingBps,
          slippageBps: body.slippageBps,
          tpPriceUsd: body.tpPriceUsd,
          slPriceUsd: body.slPriceUsd,
          tpSlippageBps: body.tpSlippageBps,
          slSlippageBps: body.slSlippageBps,
        });
      } catch (e: any) {
        logger.error(`Jupiter Trigger create order failed: ${e.message}`);
        if (e.statusCode) throw e;
        throw httpErrors.internalServerError(e.message || 'Failed to create trigger order');
      }
    },
  );

  // GET /orders — order history/status (state=active|past)
  fastify.get(
    '/orders',
    { schema: { description: 'List Jupiter Trigger orders', tags: ['/connector/jupiter'], querystring: OrdersQuery } },
    async (request) => {
      const q = request.query as Static<typeof OrdersQuery>;
      const client = await JupiterTriggerClient.getInstance(q.network ?? 'mainnet-beta');
      return await client.getOrders(q.walletAddress, {
        state: q.state,
        mint: q.mint,
        limit: q.limit,
        offset: q.offset,
        sort: q.sort,
        dir: q.dir,
      });
    },
  );

  // PATCH /orders/{orderId} — update trigger/slippage in place
  fastify.patch(
    '/orders/:orderId',
    {
      schema: {
        description: 'Update a Jupiter Trigger order',
        tags: ['/connector/jupiter'],
        params: OrderIdParams,
        body: UpdateOrderBody,
      },
    },
    async (request) => {
      const { orderId } = request.params as Static<typeof OrderIdParams>;
      const body = request.body as Static<typeof UpdateOrderBody>;
      if (!body.walletAddress) throw httpErrors.badRequest('walletAddress is required (no default wallet configured)');
      const { network, walletAddress, ...fields } = body;
      const payload: Record<string, any> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) payload[k] = v;
      }
      const client = await JupiterTriggerClient.getInstance(network ?? 'mainnet-beta');
      return await client.updateOrder(walletAddress, orderId, payload);
    },
  );

  // POST /orders/{orderId}/cancel — two-step cancel done server-side
  fastify.post(
    '/orders/:orderId/cancel',
    {
      schema: {
        description: 'Cancel a Jupiter Trigger order (initiate + sign + confirm)',
        tags: ['/connector/jupiter'],
        params: OrderIdParams,
        body: CancelOrderBody,
      },
    },
    async (request) => {
      const { orderId } = request.params as Static<typeof OrderIdParams>;
      const body = request.body as Static<typeof CancelOrderBody>;
      if (!body.walletAddress) throw httpErrors.badRequest('walletAddress is required (no default wallet configured)');
      const client = await JupiterTriggerClient.getInstance(body.network ?? 'mainnet-beta');
      try {
        return await client.cancelOrder(body.walletAddress, orderId);
      } catch (e: any) {
        logger.error(`Jupiter Trigger cancel order ${orderId} failed: ${e.message}`);
        if (e.statusCode) throw e;
        throw httpErrors.internalServerError(e.message || 'Failed to cancel trigger order');
      }
    },
  );
};

export default jupiterTriggerRoutes;
