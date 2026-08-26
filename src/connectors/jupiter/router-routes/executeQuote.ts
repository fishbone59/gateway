import { FastifyPluginAsync } from 'fastify';

import { Solana } from '../../../chains/solana/solana';
import { ExecuteQuoteRequestType, SwapExecuteResponseType, SwapExecuteResponse } from '../../../schemas/router-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { quoteCache } from '../../../services/quote-cache';
import { Jupiter } from '../jupiter';
import { JupiterExecuteQuoteRequest } from '../schemas';

export async function executeQuote(
  walletAddress: string,
  network: string,
  quoteId: string,
  priorityLevel?: string,
  maxLamports?: number,
  waitConfirm = true,
): Promise<SwapExecuteResponseType> {
  // Retrieve cached quote
  const quote = quoteCache.get(quoteId);
  if (!quote) {
    throw httpErrors.badRequest('Quote not found or expired');
  }

  // Parse the quote to get token information
  const solana = await Solana.getInstance(network);
  const jupiter = await Jupiter.getInstance(network);

  const inputToken = await solana.getToken(quote.inputMint || quote.inputToken);
  const outputToken = await solana.getToken(quote.outputMint || quote.outputToken);

  if (!inputToken || !outputToken) {
    throw httpErrors.badRequest('Invalid tokens in quote');
  }

  // Build the swap UNSIGNED with the wallet as authority (the same build the Ledger path
  // uses), then sign + send via the wallet-type-aware chokepoint (local keypair / Ledger)
  // — no per-wallet-type branching here.
  logger.info(
    `Executing quote ${quoteId} for ${inputToken.symbol} -> ${outputToken.symbol}, slippageBps=${quote.slippageBps}`,
  );
  const transaction = await jupiter.buildSwapTransactionForHardwareWallet(
    walletAddress,
    quote,
    maxLamports,
    priorityLevel,
  );

  if (!waitConfirm) {
    // Fast path (copy-engine): Jupiter already embedded CU limit + priority fee
    // (dynamicComputeUnitLimit) and simulated server-side. Sign as-is and send;
    // return the signature immediately — the caller confirms via its own WSS
    // and computes balance diffs itself. Skips gateway-side confirm wait +
    // getTransaction + handleConfirmation (~0.5-1s saved).
    const keypair = await solana.getWallet(walletAddress);
    transaction.sign([keypair]);
    const signature = await solana.connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
      maxRetries: 0,
    });
    logger.info(`Swap sent (waitConfirm=false): ${signature} for ${inputToken.symbol} -> ${outputToken.symbol}`);
    return { signature, status: 0 } as SwapExecuteResponseType;
  }

  // Jupiter already embedded CU limit + priority fee (dynamicComputeUnitLimit) and
  // simulated server-side — sign as-is and send (preserveEmbeddedBudget fast path).
  const { signature } = await solana.sendAndConfirmTransactionForWallet(transaction, walletAddress, [], undefined, {
    preserveEmbeddedBudget: true,
  });
  const txData = await solana.connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  // Handle confirmation status
  const result = await solana.handleConfirmation(
    signature,
    txData !== null,
    txData,
    inputToken.address,
    outputToken.address,
    walletAddress,
  );

  // Remove quote from cache only after successful execution (confirmed)
  if (result.status === 1) {
    quoteCache.delete(quoteId);
    logger.info(
      `Swap executed successfully: ${result.data?.amountIn.toFixed(4)} ${inputToken.symbol} -> ${result.data?.amountOut.toFixed(4)} ${outputToken.symbol}`,
    );
  }

  return result as SwapExecuteResponseType;
}

export const executeQuoteRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: ExecuteQuoteRequestType;
    Reply: SwapExecuteResponseType;
  }>(
    '/execute-quote',
    {
      schema: {
        description: 'Execute a previously fetched quote from Jupiter',
        tags: ['/connector/jupiter'],
        body: JupiterExecuteQuoteRequest,
        response: { 200: SwapExecuteResponse },
      },
    },
    async (request) => {
      try {
        const { walletAddress, network, quoteId, priorityLevel, maxLamports, waitConfirm } =
          request.body as typeof JupiterExecuteQuoteRequest._type;

        return await executeQuote(walletAddress, network, quoteId, priorityLevel, maxLamports, waitConfirm);
      } catch (e) {
        if (e.statusCode) throw e;
        logger.error('Error executing quote:', e);
        throw httpErrors.internalServerError(e.message || 'Internal server error');
      }
    },
  );
};

export default executeQuoteRoute;
