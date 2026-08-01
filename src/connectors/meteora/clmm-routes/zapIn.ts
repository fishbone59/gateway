import { Zap, estimateDlmmDirectSwap, DlmmSwapType } from '@meteora-ag/zap-sdk';
import { DecimalUtil } from '@orca-so/common-sdk';
import { Static, Type } from '@sinclair/typebox';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { BN } from 'bn.js';
import { Decimal } from 'decimal.js';
import { FastifyPluginAsync } from 'fastify';

import { Solana } from '../../../chains/solana/solana';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { Meteora } from '../meteora';
import { MeteoraConfig } from '../meteora.config';
import { MeteoraClmmZapInRequest } from '../schemas';
import {
  addNozomiTips,
  deliverNozomiGated,
  deliverPipelined,
  DeliveryOutcome,
  prepareSequence,
  STATIC_PRIORITY_FEE,
} from '../tx-delivery';

const POOL_NOT_FOUND_MESSAGE = (poolAddress: string) => `Pool not found: ${poolAddress}`;

// Short-TTL DLMM pool cache: repeated zap-ins on the same pool skip the SDK
// initialization; refetchStates() refreshes the active bin / bin arrays so range
// math always uses current state.
const dlmmPoolCache = new Map<string, { pool: any; ts: number }>();
const DLMM_POOL_CACHE_TTL_MS = 10_000;

async function getDlmmPoolCached(meteora: Meteora, poolAddress: string): Promise<any> {
  const hit = dlmmPoolCache.get(poolAddress);
  if (hit && Date.now() - hit.ts < DLMM_POOL_CACHE_TTL_MS) {
    try {
      await hit.pool.refetchStates();
      return hit.pool;
    } catch {
      // stale/broken entry — fall through to a fresh load
    }
  }
  const pool = await meteora.getDlmmPool(poolAddress);
  if (pool) {
    dlmmPoolCache.set(poolAddress, { pool, ts: Date.now() });
  }
  return pool;
}

// Response schema (kept local: multi-transaction flow does not fit the shared CLMM single-signature schema)
const ZapInResponse = Type.Object({
  signatures: Type.Array(Type.String(), { description: 'Transaction signatures in execution order' }),
  signature: Type.Optional(Type.String({ description: 'Signature of the zapIn (position creation) transaction' })),
  status: Type.Number({ description: '1 = all transactions confirmed' }),
  data: Type.Object({
    fee: Type.Number({ description: 'Total network fees across all transactions (SOL)' }),
    positionAddress: Type.Optional(Type.String()),
    baseTokenAmountAdded: Type.Optional(Type.Number({ description: 'Estimated token X (base) deposited, UI amount' })),
    quoteTokenAmountAdded: Type.Optional(
      Type.Number({ description: 'Estimated token Y (quote) deposited, UI amount' }),
    ),
    inputTokenMint: Type.String(),
    amountIn: Type.Number(),
    swapType: Type.String({ description: 'XToY | YToX | NoSwap' }),
    swapAmount: Type.String({ description: 'Raw lamports of input token to swap' }),
    expectedOutput: Type.String({ description: 'Raw lamports expected from the swap' }),
    postSwapX: Type.String({ description: 'Raw token X amount going into the position' }),
    postSwapY: Type.String({ description: 'Raw token Y amount going into the position' }),
    activeBinId: Type.Number(),
    minBinId: Type.Number(),
    maxBinId: Type.Number(),
    estimateOnly: Type.Boolean(),
  }),
});
type ZapInResponseType = Static<typeof ZapInResponse>;

export async function zapIn(
  network: string,
  walletAddress: string,
  poolAddress: string,
  inputTokenMint: string | undefined,
  amountIn: number,
  minDeltaId: number | undefined,
  maxDeltaId: number | undefined,
  slippagePct: number = MeteoraConfig.config.slippagePct,
  strategyType?: number,
  maxActiveBinSlippage: number = 50,
  favorXInActiveId: boolean = false,
  maxAccounts: number = 50,
  maxTransferAmountExtendPercentage: number = 0,
  estimateOnly: boolean = false,
  resumeOnly: boolean = false,
  cleanupOnly: boolean = false,
  lowerPrice?: number,
  upperPrice?: number,
  broadcastMode: 'serial' | 'fast' | 'temporal' = 'serial',
): Promise<ZapInResponseType> {
  const solana = await Solana.getInstance(network);
  const meteora = await Meteora.getInstance(network);

  // Validate addresses
  try {
    new PublicKey(poolAddress);
  } catch {
    throw httpErrors.badRequest(`Invalid pool address: ${poolAddress}`);
  }
  try {
    new PublicKey(walletAddress);
  } catch {
    throw httpErrors.badRequest(`Invalid wallet address: ${walletAddress}`);
  }
  if (amountIn <= 0) {
    throw httpErrors.badRequest('amountIn must be positive');
  }

  const wallet = await solana.getWallet(walletAddress);
  const lbPair = new PublicKey(poolAddress);

  let dlmmPool;
  try {
    dlmmPool = await getDlmmPoolCached(meteora, poolAddress);
    if (!dlmmPool) {
      throw httpErrors.notFound(POOL_NOT_FOUND_MESSAGE(poolAddress));
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Invalid account discriminator')) {
      throw httpErrors.notFound(POOL_NOT_FOUND_MESSAGE(poolAddress));
    }
    throw error;
  }

  const tokenXMint = dlmmPool.tokenX.publicKey;
  const tokenYMint = dlmmPool.tokenY.publicKey;

  // Resolve input mint: default to token X (base)
  let inputMint: PublicKey;
  if (inputTokenMint) {
    try {
      inputMint = new PublicKey(inputTokenMint);
    } catch {
      throw httpErrors.badRequest(`Invalid input token mint: ${inputTokenMint}`);
    }
    if (!inputMint.equals(tokenXMint) && !inputMint.equals(tokenYMint)) {
      throw httpErrors.badRequest(
        `Input token mint ${inputTokenMint} is neither token X (${tokenXMint.toBase58()}) nor token Y (${tokenYMint.toBase58()}) of this pool`,
      );
    }
  } else {
    inputMint = tokenXMint;
  }
  const inputDecimals = inputMint.equals(tokenXMint) ? dlmmPool.tokenX.mint.decimals : dlmmPool.tokenY.mint.decimals;
  const amountInLamports = new BN(DecimalUtil.toBN(new Decimal(amountIn), inputDecimals));

  const activeBin = await dlmmPool.getActiveBin();

  // Resolve bin deltas: either given directly, or derived from price bounds via the DLMM SDK
  // (same conversion as open-position, keeping all price->bin math on the Gateway side)
  let effMinDelta = minDeltaId;
  let effMaxDelta = maxDeltaId;
  if (
    (effMinDelta === undefined || effMaxDelta === undefined) &&
    lowerPrice !== undefined &&
    upperPrice !== undefined
  ) {
    const lowerPricePerLamport = dlmmPool.toPricePerLamport(lowerPrice);
    const upperPricePerLamport = dlmmPool.toPricePerLamport(upperPrice);
    effMinDelta = dlmmPool.getBinIdFromPrice(Number(lowerPricePerLamport), true) - activeBin.binId;
    effMaxDelta = dlmmPool.getBinIdFromPrice(Number(upperPricePerLamport), false) - activeBin.binId;
  }
  if (effMinDelta === undefined || effMaxDelta === undefined) {
    throw httpErrors.badRequest('Provide either minDeltaId/maxDeltaId or lowerPrice/upperPrice');
  }
  if (effMinDelta > effMaxDelta) {
    throw httpErrors.badRequest('minDeltaId must be <= maxDeltaId (check lowerPrice <= upperPrice)');
  }
  const positionWidth = effMaxDelta - effMinDelta + 1;
  if (positionWidth > 69) {
    throw httpErrors.badRequest(
      `Position width ${positionWidth} bins exceeds the DLMM limit of 69. ` +
        `Narrow the price range (deltas [${effMinDelta}, ${effMaxDelta}])`,
    );
  }

  const minBinId = activeBin.binId + effMinDelta;
  const maxBinId = activeBin.binId + effMaxDelta;
  logger.info(
    `Zap-in pool ${poolAddress}: active bin ${activeBin.binId} (price ${activeBin.pricePerToken}), ` +
      `range deltas [${effMinDelta}, ${effMaxDelta}] -> bins [${minBinId}, ${maxBinId}]`,
  );

  const swapSlippageBps = Math.round(slippagePct * 100);
  const strategy = (strategyType ?? MeteoraConfig.config.strategyType) as any;

  const connection = solana.connection;
  const zap = new Zap(connection);

  // 1. Estimate how much of the input needs swapping to match the DLMM distribution
  const estimate = await estimateDlmmDirectSwap({
    amountIn: amountInLamports as any,
    inputTokenMint: inputMint,
    lbPair,
    connection,
    swapSlippageBps,
    minDeltaId: effMinDelta,
    maxDeltaId: effMaxDelta,
    strategy,
    config: {},
  });

  const swapTypeName = DlmmSwapType[estimate.result.swapType] ?? String(estimate.result.swapType);
  const baseUiAdded = new Decimal(estimate.result.postSwapX.toString())
    .div(new Decimal(10).pow(dlmmPool.tokenX.mint.decimals))
    .toNumber();
  const quoteUiAdded = new Decimal(estimate.result.postSwapY.toString())
    .div(new Decimal(10).pow(dlmmPool.tokenY.mint.decimals))
    .toNumber();
  logger.info(
    `Zap-in estimate: swapType=${swapTypeName}, swapAmount=${estimate.result.swapAmount.toString()}, ` +
      `expectedOutput=${estimate.result.expectedOutput.toString()}, ` +
      `postSwapX=${estimate.result.postSwapX.toString()}, postSwapY=${estimate.result.postSwapY.toString()}`,
  );

  const baseResponseData = {
    inputTokenMint: inputMint.toBase58(),
    amountIn,
    swapType: swapTypeName,
    swapAmount: estimate.result.swapAmount.toString(),
    expectedOutput: estimate.result.expectedOutput.toString(),
    postSwapX: estimate.result.postSwapX.toString(),
    postSwapY: estimate.result.postSwapY.toString(),
    activeBinId: activeBin.binId,
    minBinId,
    maxBinId,
    baseTokenAmountAdded: baseUiAdded,
    quoteTokenAmountAdded: quoteUiAdded,
  };

  if (estimateOnly) {
    return {
      signatures: [],
      status: 1,
      data: { fee: 0, ...baseResponseData, estimateOnly: true },
    };
  }

  // 2. Prepare zap-in params and build the full transaction sequence
  const params = await zap.getZapInDlmmDirectParams({
    user: wallet.publicKey,
    directSwapEstimate: estimate.result,
    maxActiveBinSlippage,
    favorXInActiveId,
    maxAccounts,
    maxTransferAmountExtendPercentage,
    ...estimate.context,
  });

  const position = new Keypair();
  const result = await zap.buildZapInDlmmTransaction({
    ...params,
    position: position.publicKey,
  });

  // 3. Submit transactions strictly in order: setup -> swaps -> ledger -> zapIn -> cleanup
  // resumeOnly: a previous attempt already confirmed setup/swap/ledger; only finish zapIn + cleanup
  const txSequence: { label: string; tx: Transaction; signers: Keypair[]; cuOverride?: number }[] = [];
  if (!resumeOnly && !cleanupOnly) {
    if (result.setupTransaction) {
      txSequence.push({ label: 'setup', tx: result.setupTransaction, signers: [wallet] });
    }
    result.swapTransactions.forEach((tx, i) => {
      txSequence.push({ label: `swap-${i}`, tx, signers: [wallet] });
    });
    txSequence.push({ label: 'ledger', tx: result.ledgerTransaction, signers: [wallet] });
  }
  // zapIn creates the position via initialize_position2 + rebalance_liquidity CPI.
  // Simulation underestimates its CU usage (observed on-chain failure: exceeded CUs meter
  // at 220k while simulation reported ~200k), so pin an explicit higher limit.
  if (!cleanupOnly) {
    txSequence.push({
      label: 'zapIn',
      tx: result.zapInTransaction,
      signers: [wallet, position],
      cuOverride: 1_000_000,
    });
  }
  // cleanup also runs CPI-heavy paths (close ledger + unwrap); pin a higher limit as well
  txSequence.push({ label: 'cleanup', tx: result.cleanUpTransaction, signers: [wallet], cuOverride: 400_000 });

  // 4. Deliver the sequence in the requested broadcast mode.
  // serial:   per-tx sendAndConfirmTransaction (slowest, step-precise errors)
  // fast:     shared blockhash + pipelined broadcast + batch confirm (~4s, order best-effort)
  // temporal: shared blockhash + Nozomi confirm-gated sequential delivery (~5-8s, deterministic)
  const recoveryHint = (_failed: string, confirmed: string[]): string =>
    confirmed.includes('ledger') && !confirmed.includes('zapIn')
      ? 'Ledger confirmed but position not opened — retry with resumeOnly=true.'
      : confirmed.includes('zapIn') && !confirmed.includes('cleanup')
        ? 'Position opened but cleanup failed — run cleanupOnly=true to recover rent.'
        : 'Early step failed — wallet state unchanged apart from any confirmed setup ATAs.';

  let delivery: DeliveryOutcome;
  if (broadcastMode === 'serial') {
    delivery = { signatures: [], results: [], totalFee: 0 };
    for (const { label, tx, signers, cuOverride } of txSequence) {
      tx.feePayer = wallet.publicKey;
      logger.info(`Zap-in sending ${label} transaction (${(tx as Transaction).instructions?.length ?? '?'} instructions)...`);
      const { signature, fee } = await solana.sendAndConfirmTransaction(tx, signers, undefined, cuOverride);
      logger.info(`Zap-in ${label} confirmed: ${signature}`);
      delivery.signatures.push(signature);
      delivery.results.push({ signature, confirmed: true, fee });
      delivery.totalFee += fee;
      if (label === 'zapIn') {
        delivery.keySignature = signature;
      }
    }
  } else {
    // Kick off blockhash (+ gas estimate for fast) BEFORE tip injection — the versioned-tx
    // ALT fetches in addNozomiTips overlap with these RPCs. temporal uses a static priority
    // fee: on Nozomi paths the tip is the lever, priority fee is ignored.
    const blockhashPromise = connection.getLatestBlockhashAndContext('confirmed');
    const gasPromise = broadcastMode === 'fast' ? solana.estimateGasPrice() : Promise.resolve(STATIC_PRIORITY_FEE);
    if (broadcastMode === 'temporal') {
      await addNozomiTips(connection, wallet.publicKey, txSequence);
    }
    const [
      {
        value: { blockhash, lastValidBlockHeight },
      },
      priorityFee,
    ] = await Promise.all([blockhashPromise, gasPromise]);
    const prepared = prepareSequence(solana, wallet.publicKey, txSequence, blockhash, priorityFee);
    delivery =
      broadcastMode === 'temporal'
        ? await deliverNozomiGated(solana, prepared, lastValidBlockHeight, MeteoraConfig.config.temporalApiKey, {
            flowName: 'Zap-in',
            keyLabel: 'zapIn',
            recoveryHint,
          })
        : await deliverPipelined(solana, prepared, lastValidBlockHeight, {
            flowName: 'Zap-in',
            keyLabel: 'zapIn',
            recoveryHint,
          });

    // Post-execution semantic verification: a same-slot reorder (e.g. the ledger executing
    // before the swap) leaves every transaction "confirmed" yet deposits only one side of
    // the range. Confirmations alone cannot detect that — compare the position's actual
    // deposited amounts against the estimate.
    if (!cleanupOnly) {
      const posInfo = await (dlmmPool as any).getPosition(position.publicKey).catch(() => null);
      const depX = new Decimal(posInfo?.positionData?.totalXAmount?.toString() ?? '0');
      const depY = new Decimal(posInfo?.positionData?.totalYAmount?.toString() ?? '0');
      const expX = new Decimal(estimate.result.postSwapX.toString());
      const expY = new Decimal(estimate.result.postSwapY.toString());
      const short = (dep: Decimal, exp: Decimal) => exp.gt(0) && dep.lt(exp.mul(new Decimal('0.95')));
      if (!posInfo || short(depX, expX) || short(depY, expY)) {
        throw httpErrors.internalServerError(
          `Zap-in ${broadcastMode} verification failed for position ${position.publicKey.toBase58()}: ` +
            `deposited X=${depX.toString()} Y=${depY.toString()}, expected ~X=${expX.toString()} Y=${expY.toString()}. ` +
            'Likely intra-slot reorder (ledger executed before the swap). Any unswapped tokens remain ' +
            'in the wallet and the position holds only one side — close it and retry.',
        );
      }
      logger.info(`Zap-in ${broadcastMode}: position verified (deposited X=${depX.toString()} Y=${depY.toString()})`);
    }
  }

  const signatures = delivery.signatures;
  const totalFee = delivery.totalFee;
  const zapInSignature = delivery.keySignature;

  logger.info(`Zap-in complete. Position: ${position.publicKey.toBase58()}, total fees: ${totalFee.toFixed(6)} SOL`);

  return {
    signatures,
    ...(zapInSignature ? { signature: zapInSignature } : {}),
    status: 1,
    data: {
      fee: totalFee,
      // position keypair is only meaningful when the zapIn transaction was actually sent
      ...(cleanupOnly ? {} : { positionAddress: position.publicKey.toBase58() }),
      ...baseResponseData,
      estimateOnly: false,
    },
  };
}

export const zapInRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: Static<typeof MeteoraClmmZapInRequest>;
    Reply: ZapInResponseType;
  }>(
    '/zap-in',
    {
      schema: {
        description:
          'Open a new Meteora DLMM position from a single input token via the Meteora Zap program (bundled swap + add liquidity)',
        tags: ['/connector/meteora'],
        body: MeteoraClmmZapInRequest,
        response: {
          200: ZapInResponse,
        },
      },
    },
    async (request) => {
      try {
        const {
          network,
          walletAddress,
          poolAddress,
          inputTokenMint,
          amountIn,
          minDeltaId,
          maxDeltaId,
          slippagePct,
          strategyType,
          maxActiveBinSlippage,
          favorXInActiveId,
          maxAccounts,
          maxTransferAmountExtendPercentage,
          estimateOnly,
          resumeOnly,
          cleanupOnly,
          lowerPrice,
          upperPrice,
          broadcastMode,
        } = request.body;

        return await zapIn(
          network,
          walletAddress,
          poolAddress,
          inputTokenMint,
          amountIn,
          minDeltaId,
          maxDeltaId,
          slippagePct,
          strategyType,
          maxActiveBinSlippage,
          favorXInActiveId,
          maxAccounts,
          maxTransferAmountExtendPercentage,
          estimateOnly,
          resumeOnly,
          cleanupOnly,
          lowerPrice,
          upperPrice,
          broadcastMode,
        );
      } catch (e) {
        logger.error(e);
        if (e.statusCode) {
          throw e;
        }
        throw httpErrors.internalServerError(e.message || 'Internal server error');
      }
    },
  );
};

export default zapInRoute;
