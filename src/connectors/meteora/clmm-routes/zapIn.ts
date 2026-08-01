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

const POOL_NOT_FOUND_MESSAGE = (poolAddress: string) => `Pool not found: ${poolAddress}`;

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
  broadcastMode: 'serial' | 'fast' = 'serial',
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
    dlmmPool = await meteora.getDlmmPool(poolAddress);
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

  const signatures: string[] = [];
  let totalFee = 0;
  let zapInSignature: string | undefined;

  if (broadcastMode === 'fast') {
    // Fast path (frontend-like): the zap SDK prebuilds the whole sequence, so sign every
    // transaction against one shared blockhash, broadcast them back-to-back without
    // per-transaction confirm waits (targeting a single slot), then confirm the batch
    // in one polling loop. Trade-off vs serial: an early on-chain failure also burns the
    // later transactions' fees; resumeOnly/cleanupOnly remain the recovery path.
    // CU overrides are pinned from observed mainnet consumption (serial mode measures
    // each transaction post-confirmation, which is impossible pre-broadcast here).
    const FAST_CU_OVERRIDES: Record<string, number> = {
      setup: 60_000, // observed ~24k
      ledger: 120_000, // observed ~27k
    };
    const SWAP_CU_OVERRIDE = 300_000; // observed 32k-105k depending on Jupiter route
    const {
      value: { blockhash, lastValidBlockHeight },
    } = await connection.getLatestBlockhashAndContext('confirmed');
    const priorityFee = await solana.estimateGasPrice();

    const prepared = txSequence.map(({ label, tx, signers, cuOverride }) => {
      const cu = cuOverride ?? FAST_CU_OVERRIDES[label] ?? (label.startsWith('swap') ? SWAP_CU_OVERRIDE : undefined);
      if (tx instanceof Transaction) {
        tx.feePayer = wallet.publicKey;
      }
      return { label, tx: solana.prepareForRapidBroadcast(tx, signers, blockhash, priorityFee, cu) };
    });

    // Pipelined broadcast: dispatch each send ~50ms apart WITHOUT awaiting the previous
    // RPC response, so the whole burst reaches the leader within ~250ms (one slot) while
    // preserving dispatch order. Awaiting each send serially costs ~1s/tx of RPC latency
    // and smears the burst across several slots.
    const sendPromises: Promise<string>[] = [];
    for (const { label, tx } of prepared) {
      sendPromises.push(solana.sendPreparedTransaction(tx));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const settled = await Promise.allSettled(sendPromises);
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') {
        const sig = s.value;
        logger.info(`Zap-in fast: broadcast ${prepared[i].label} -> ${sig}`);
        signatures.push(sig);
        if (prepared[i].label === 'zapIn') {
          zapInSignature = sig;
        }
      } else {
        logger.error(`Zap-in fast: broadcast ${prepared[i].label} failed at RPC: ${s.reason?.message ?? s.reason}`);
        signatures.push(''); // keep index alignment with prepared
      }
    });
    const unsent = prepared.filter((_, i) => settled[i].status === 'rejected').map((p) => p.label);
    if (unsent.length > 0) {
      throw httpErrors.internalServerError(
        `Zap-in fast broadcast failed at RPC for [${unsent.join(', ')}]; nothing after those was sent. ` +
          `Sent signatures: ${signatures.filter(Boolean).join(', ')}`,
      );
    }

    const results = await solana.confirmTransactionsBatch(signatures, lastValidBlockHeight);
    results.forEach((r, i) => {
      logger.info(
        `Zap-in fast: ${prepared[i].label} ${r.signature} -> ${r.confirmed ? 'confirmed' : `FAILED (${r.error ?? 'expired'})`}`,
      );
    });
    const failedLabels = prepared.filter((_, i) => !results[i].confirmed).map((p) => p.label);
    if (failedLabels.length > 0) {
      const confirmedLabels = prepared.filter((_, i) => results[i].confirmed).map((p) => p.label);
      throw httpErrors.internalServerError(
        `Zap-in fast broadcast incomplete: failed=[${failedLabels.join(', ')}], confirmed=[${confirmedLabels.join(', ')}]. ` +
          (confirmedLabels.includes('ledger') && !confirmedLabels.includes('zapIn')
            ? 'Ledger confirmed but position not opened — retry with resumeOnly=true. '
            : '') +
          (confirmedLabels.includes('zapIn') && !confirmedLabels.includes('cleanup')
            ? 'Position opened but cleanup failed — run cleanupOnly=true to recover rent. '
            : '') +
          `Signatures: ${signatures.join(', ')}`,
      );
    }
    totalFee = results.reduce((acc, r) => acc + (r.fee ?? 0), 0);
  } else {
    for (const { label, tx, signers, cuOverride } of txSequence) {
      tx.feePayer = wallet.publicKey;
      logger.info(`Zap-in sending ${label} transaction (${tx.instructions.length} instructions)...`);
      const { signature, fee } = await solana.sendAndConfirmTransaction(tx, signers, undefined, cuOverride);
      logger.info(`Zap-in ${label} confirmed: ${signature}`);
      if (label === 'zapIn') {
        zapInSignature = signature;
      }
      signatures.push(signature);
      totalFee += fee;
    }
  }

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
