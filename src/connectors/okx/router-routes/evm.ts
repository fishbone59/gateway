// OKX connector EVM execution path (local patch, 2026-08-29): quote + execute on EVM
// networks (robinhoodchain). OKX /swap returns unsigned tx fields; gateway signs with the
// local EVM wallet and broadcasts via the network nodeURL. approve is handled serially
// per-amount (allowance precheck -> approve exact amount -> swap), never max-approve.
import { Static } from '@sinclair/typebox';
import { BigNumber, utils } from 'ethers';
import { v4 as uuidv4 } from 'uuid';

import { Ethereum, TokenInfo } from '../../../chains/ethereum/ethereum';
import { SwapExecuteResponseType } from '../../../schemas/router-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { quoteCache } from '../../../services/quote-cache';
import { sanitizeErrorMessage, sanitizeString } from '../../../services/sanitize';
import { Okx } from '../okx';
import { OkxConfig } from '../okx.config';
import { OkxQuoteSwapResponse } from '../schemas';

const ERC20_ALLOWANCE_SEL = '0xdd62ed3e'; // allowance(address,address)
const ERC20_APPROVE_SEL = '0x095ea7b3'; // approve(address,uint256)

const pad32 = (addr: string) => addr.toLowerCase().replace('0x', '').padStart(64, '0');

/** Poll eth_getTransactionReceipt until mined (0.1s blocks on robinhoodchain) or timeout. */
async function waitReceipt(
  ethereum: Ethereum,
  txHash: string,
  intervalMs = 300,
  maxRounds = 100,
): Promise<{ status: number; receipt: any }> {
  for (let i = 0; i < maxRounds; i++) {
    const receipt = await ethereum.provider.getTransactionReceipt(txHash);
    if (receipt && receipt.blockNumber) {
      return { status: receipt.status === 1 ? 1 : -1, receipt };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { status: 0, receipt: null };
}

export async function quoteSwapEvm(
  network: string,
  baseToken: string,
  quoteToken: string,
  amount: number,
  side: 'BUY' | 'SELL',
  slippagePct: number = OkxConfig.config.slippagePct,
): Promise<Static<typeof OkxQuoteSwapResponse>> {
  const ethereum = await Ethereum.getInstance(network);
  const okx = await Okx.getInstance(network);

  const baseTokenInfo = await ethereum.getToken(baseToken);
  const quoteTokenInfo = await ethereum.getToken(quoteToken);
  if (!baseTokenInfo || !quoteTokenInfo) {
    throw httpErrors.badRequest(sanitizeErrorMessage('Token not found: {}', !baseTokenInfo ? baseToken : quoteToken));
  }

  const inputToken = side === 'SELL' ? baseTokenInfo : quoteTokenInfo;
  const outputToken = side === 'SELL' ? quoteTokenInfo : baseTokenInfo;
  const swapMode: 'exactIn' | 'exactOut' = side === 'BUY' ? 'exactOut' : 'exactIn';
  const baseAmountRaw = utils.parseUnits(amount.toString(), baseTokenInfo.decimals).toString();

  logger.info(`Getting OKX EVM quote for ${amount} ${inputToken.symbol} -> ${outputToken.symbol} (${side})`);

  let routerResult;
  try {
    routerResult = await okx.getQuote(inputToken.address, outputToken.address, baseAmountRaw, swapMode);
  } catch (error) {
    // OKX exactOut is only served on ETH/Base/BSC/Arb — on 4663 BUY quotes are unsupported.
    const tokenPair = `${sanitizeString(baseToken)} -> ${sanitizeString(quoteToken)}`;
    throw httpErrors.noRouteFound(`No route found for ${tokenPair} (${swapMode}). ${error?.message || String(error)}`);
  }

  const estimatedAmountIn = Number(utils.formatUnits(routerResult.fromTokenAmount, inputToken.decimals));
  const estimatedAmountOut = Number(utils.formatUnits(routerResult.toTokenAmount, outputToken.decimals));

  const minAmountOut = side === 'SELL' ? estimatedAmountOut * (1 - slippagePct / 100) : amount;
  const maxAmountIn = side === 'BUY' ? estimatedAmountIn * (1 + slippagePct / 100) : amount;
  const price = side === 'SELL' ? estimatedAmountOut / estimatedAmountIn : estimatedAmountIn / estimatedAmountOut;

  const quoteId = uuidv4();
  quoteCache.set(quoteId, {
    connector: 'okx',
    evm: true,
    network,
    inputToken,
    outputToken,
    side,
    slippagePct,
    amountRaw: baseAmountRaw,
    swapMode,
    routerResult,
  });

  return {
    quoteId,
    tokenIn: inputToken.address,
    tokenOut: outputToken.address,
    amountIn: side === 'SELL' ? amount : estimatedAmountIn,
    amountOut: side === 'SELL' ? estimatedAmountOut : amount,
    price,
    priceImpactPct: parseFloat(routerResult.priceImpactPercent ?? routerResult.priceImpactPercentage ?? '0'),
    minAmountOut,
    maxAmountIn,
    routerResult,
  };
}

export async function executeQuoteEvm(
  walletAddress: string,
  network: string,
  quoteId: string,
  waitConfirm = true,
): Promise<SwapExecuteResponseType> {
  const cached = quoteCache.get(quoteId);
  if (!cached || cached.connector !== 'okx' || !cached.evm) {
    throw httpErrors.badRequest('Quote not found or expired');
  }

  const ethereum = await Ethereum.getInstance(network);
  const okx = await Okx.getInstance(network);
  const { inputToken, outputToken, amountRaw, swapMode, slippagePct } = cached as {
    inputToken: TokenInfo;
    outputToken: TokenInfo;
    amountRaw: string;
    swapMode: 'exactIn' | 'exactOut';
    slippagePct: number;
  };

  const wallet = await ethereum.getWallet(walletAddress);
  const spender = await okx.getApproveSpender();

  // Per-amount approve: check allowance, top up with an exact-amount approve if short.
  const required = BigNumber.from(amountRaw);
  const allowanceData = ERC20_ALLOWANCE_SEL + pad32(wallet.address) + pad32(spender);
  const allowanceRaw = await ethereum.provider.call({ to: inputToken.address, data: allowanceData });
  const allowance = BigNumber.from(allowanceRaw);
  if (allowance.lt(required)) {
    logger.info(
      `OKX EVM approve: ${inputToken.symbol} allowance ${allowance.toString()} < ${required.toString()}, approving exact amount`,
    );
    const approveData = ERC20_APPROVE_SEL + pad32(spender) + required.toHexString().replace('0x', '').padStart(64, '0');
    const approveTx = await wallet.sendTransaction({ to: inputToken.address, data: approveData });
    logger.info(`OKX EVM approve sent: ${approveTx.hash}`);
    const approveResult = await waitReceipt(ethereum, approveTx.hash);
    if (approveResult.status !== 1) {
      // Sent but failed / unknown — do NOT retry or continue (double-spend class risk)
      throw httpErrors.internalServerError(
        `Approve transaction ${approveTx.hash} ${approveResult.status === -1 ? 'failed on-chain' : 'confirmation timeout'}`,
      );
    }
    logger.info(`OKX EVM approve confirmed: ${approveTx.hash}`);
  }

  logger.info(`Executing OKX EVM quote ${quoteId} for ${inputToken.symbol} -> ${outputToken.symbol}`);
  const { tx } = await okx.getEvmSwapTransaction(
    wallet.address,
    inputToken.address,
    outputToken.address,
    amountRaw,
    swapMode,
    slippagePct,
  );

  const sent = await wallet.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value ? BigNumber.from(tx.value) : undefined,
    gasPrice: tx.gasPrice ? BigNumber.from(tx.gasPrice) : undefined,
    gasLimit: tx.gas ? BigNumber.from(tx.gas).mul(120).div(100) : undefined,
  });
  logger.info(`OKX EVM swap sent (waitConfirm=${waitConfirm}): ${sent.hash}`);

  if (!waitConfirm) {
    // Fast path for copy-engine: return immediately; caller confirms via receipt polling
    return { signature: sent.hash, status: 0 } as SwapExecuteResponseType;
  }

  const result = await waitReceipt(ethereum, sent.hash);
  if (result.status === 1) {
    quoteCache.delete(quoteId);
    logger.info(`OKX EVM swap executed successfully: ${sent.hash}`);
  }
  return { signature: sent.hash, status: result.status } as SwapExecuteResponseType;
}
