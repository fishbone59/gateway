// PumpSwap AMM (pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA) 直连买入 —— 本地补丁
//
// 绕过 Jupiter 聚合器：引擎侧已用 Shyft gPA（pool.base_mint@43 / quote_mint@75）
// 判定代币有 PumpSwap 池并把 poolAddress 传进来；本端点完成：读池状态 →
// 恒定乘积本地定价（不询价）→ 本地构建交易（wrap SOL + buy_exact_quote_in +
// unwrap）→ 本地签名 → 发送即返回 signature（同 execute-quote waitConfirm=false
// 语义，调用方用自家 WSS 确认 + 自解析成交量）。
//
// 关键事实（2026-08-26 链上 IDL + 真实交易 + simulateTransaction 三重验证）：
// - buy_exact_quote_in(spendable_quote_in: u64, min_base_amount_out: u64,
//   track_volume: OptionBool=1byte) —— ExactIn 语义，discriminator [198,46,21,82,180,217,232,112]
// - Pool 布局：8 disc + bump@8 + index@9 + creator@11 + base_mint@43 + quote_mint@75
//   + lp_mint@107 + pool_base_ta@139 + pool_quote_ta@171 + lp_supply@203
//   + coin_creator@211 + is_mayhem@243 + is_cashback@244（储备量在池的两个 token 账户里）
// - GlobalConfig：lp_fee_bps@40 + protocol_fee_bps@48 + disable_flags@56
//   + protocol_fee_recipients[8]@57 + coin_creator_fee_bps@313
//   + buyback_fee_recipients[8]@643 + buyback_bps@899
// - 费率 = lp+protocol+coin_creator（实测 20+5+5=30bps；buyback_bps 是协议费内部分成，
//   不影响用户定价）。公式：effIn = in*(10000-feeBps)/10000；out = effIn*Rb/(Rq+effIn)，
//   已用 0.1% minOut 容差通过 simulate 校验（公式精度 <0.1%）
// - buyback_bps>0 时程序强制要求 remaining accounts [buyback_recipient, 其 quote ATA]
//   （否则 AnchorError 6058 BuybackFeeRecipientMissing）；recipient 任选数组其一
// - coin_creator_vault_authority = PDA(["creator_vault", pool.coin_creator])（用 @211 的
//   coin_creator，不是 @11 的 pool creator —— 用错报 ConstraintSeeds 2006）
// - fee_config = PDA(["fee_config", pAMM_program_id], fee_program)
// - user_volume_accumulator = PDA(["user_volume_accumulator", user])，不存在则须先
//   init_user_volume_accumulator（discriminator [94,6,202,115,255,96,232,183]）
// - 不支持：quote != wSOL 的池、is_mayhem_mode / is_cashback_coin 池（4xx 让引擎回退 Jupiter）
import { Type } from '@sinclair/typebox';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { FastifyPluginAsync } from 'fastify';

import { Solana } from '../../../chains/solana/solana';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';

const PAMM_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const POOL_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const BUY_EXACT_QUOTE_IN_DISC = Buffer.from([198, 46, 21, 82, 180, 217, 232, 112]);
const INIT_UVA_DISC = Buffer.from([94, 6, 202, 115, 255, 96, 232, 183]);

// 自建交易 CU 预算（simulate 实测 swap 整包 ~100k CU）；价格默认 0.1 lamport/CU，
// 打满 150k CU 时优先费 ~0.000015 SOL —— 对齐 Jupiter veryHigh 档实测（1.3-1.6e-5 SOL）
const DEFAULT_CU_LIMIT = 150_000;
const DEFAULT_CU_PRICE_MICRO_LAMPORTS = 100_000;

const u64le = (n: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const pda = (seeds: Buffer[], program: PublicKey = PAMM_PROGRAM): PublicKey =>
  PublicKey.findProgramAddressSync(seeds, program)[0];

export const DirectBuyRequest = Type.Object({
  walletAddress: Type.String({ description: 'Solana wallet that signs and pays' }),
  network: Type.Optional(Type.String({ default: 'mainnet-beta' })),
  poolAddress: Type.String({ description: 'PumpSwap pool address (engine-side gPA detection result)' }),
  baseMint: Type.String({ description: 'Token mint to buy (pool base mint)' }),
  amountSol: Type.Number({ description: 'Exact-in SOL amount to spend' }),
  slippagePct: Type.Optional(Type.Number({ default: 3, description: 'minOut = expectedOut*(1-slippage)' })),
  computeUnitLimit: Type.Optional(Type.Number()),
  computeUnitPriceMicroLamports: Type.Optional(Type.Number()),
});

export interface DirectBuyRequestBody {
  walletAddress: string;
  network?: string;
  poolAddress: string;
  baseMint: string;
  amountSol: number;
  slippagePct?: number;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;
}

export interface DirectBuyResult {
  signature: string;
  status: number; // 0 = sent, caller confirms via own WSS
  poolAddress: string;
  amountInLamports: string;
  expectedOut: string;
  minOut: string;
  feeBps: number;
  timings: Record<string, number>;
}

export async function directBuy(
  walletAddress: string,
  network: string,
  poolAddress: string,
  baseMint: string,
  amountSol: number,
  slippagePct = 3,
  computeUnitLimit = DEFAULT_CU_LIMIT,
  computeUnitPriceMicroLamports = DEFAULT_CU_PRICE_MICRO_LAMPORTS,
): Promise<DirectBuyResult> {
  const timings: Record<string, number> = {};
  const t0 = Date.now();
  const solana = await Solana.getInstance(network);
  const conn = solana.connection;
  const wallet = new PublicKey(walletAddress);
  const poolAddr = new PublicKey(poolAddress);
  const amountLamports = BigInt(Math.round(amountSol * 1e9));
  if (amountLamports <= 0n) throw httpErrors.badRequest('amountSol must be > 0');

  // ---- 1. 池账户 + 校验（场地不符 → 4xx，引擎回退 Jupiter）
  const poolInfo = await conn.getAccountInfo(poolAddr);
  timings.pool_fetch_ms = Date.now() - t0;
  if (!poolInfo || !poolInfo.owner.equals(PAMM_PROGRAM)) throw httpErrors.badRequest('not a PumpSwap AMM pool');
  const pd = poolInfo.data;
  if (pd.length < 245 || pd.subarray(0, 8).toString('hex') !== POOL_DISCRIMINATOR.toString('hex'))
    throw httpErrors.badRequest('bad pool account (discriminator mismatch)');
  const coinCreator = new PublicKey(pd.subarray(211, 243));
  const poolBaseMint = new PublicKey(pd.subarray(43, 75));
  const quoteMint = new PublicKey(pd.subarray(75, 107));
  const poolBaseTa = new PublicKey(pd.subarray(139, 171));
  const poolQuoteTa = new PublicKey(pd.subarray(171, 203));
  if (poolBaseMint.toBase58() !== baseMint) throw httpErrors.badRequest('pool base_mint != requested baseMint');
  if (!quoteMint.equals(WSOL_MINT)) throw httpErrors.badRequest('pool quote is not wSOL (unsupported)');
  if (pd[243] || pd[244]) throw httpErrors.badRequest('mayhem/cashback pool (unsupported)');

  // ---- 2. 池状态（储备量=池的两个 token 账户余额）+ 全局配置 + base mint owner + blockhash 并行
  const s0 = Date.now();
  const globalConfig = pda([Buffer.from('global_config')]);
  const userVolAcc = pda([Buffer.from('user_volume_accumulator'), wallet.toBuffer()]);
  const [accounts, { blockhash, lastValidBlockHeight }] = await Promise.all([
    conn.getMultipleAccountsInfo([poolBaseTa, poolQuoteTa, globalConfig, new PublicKey(baseMint), userVolAcc]),
    conn.getLatestBlockhash('confirmed'),
  ]);
  timings.state_fetch_ms = Date.now() - s0;
  const [baseTaInfo, quoteTaInfo, gcInfo, baseMintInfo, uvaInfo] = accounts;
  if (!baseTaInfo || !quoteTaInfo || !gcInfo || !baseMintInfo)
    throw httpErrors.badRequest('pool state accounts missing');
  const reserveBase = baseTaInfo.data.readBigUInt64LE(64);
  const reserveQuote = quoteTaInfo.data.readBigUInt64LE(64);
  if (reserveBase === 0n || reserveQuote === 0n) throw httpErrors.badRequest('empty pool reserves');
  const g = gcInfo.data;
  const lpFeeBps = Number(g.readBigUInt64LE(40));
  const protocolFeeBps = Number(g.readBigUInt64LE(48));
  const creatorFeeBps = Number(g.readBigUInt64LE(313));
  const feeBps = lpFeeBps + protocolFeeBps + creatorFeeBps;
  const protocolFeeRecipient = new PublicKey(g.subarray(57, 89)); // recipients[0]
  const baseTokenProgram = baseMintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const buybackBps = Number(g.readBigUInt64LE(899));

  // ---- 3. 本地定价（恒定乘积，全 floor 取整 —— minOut 偏保守方向）
  const effectiveIn = (amountLamports * BigInt(10_000 - feeBps)) / 10_000n;
  const expectedOut = (effectiveIn * reserveBase) / (reserveQuote + effectiveIn);
  const slippageBps = BigInt(Math.round(slippagePct * 100));
  const minOut = (expectedOut * (10_000n - slippageBps)) / 10_000n;
  if (minOut <= 0n) throw httpErrors.badRequest('minOut rounds to zero (amount too small)');

  // ---- 4. 本地构建：CU 预算 ×2 + wrap SOL + 建 base ATA(幂等) + [init uva] + swap + unwrap
  const b0 = Date.now();
  const userBaseAta = getAssociatedTokenAddressSync(poolBaseMint, wallet, false, baseTokenProgram);
  const userQuoteAta = getAssociatedTokenAddressSync(WSOL_MINT, wallet);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicroLamports }),
    createAssociatedTokenAccountIdempotentInstruction(wallet, userQuoteAta, wallet, WSOL_MINT),
    SystemProgram.transfer({ fromPubkey: wallet, toPubkey: userQuoteAta, lamports: amountLamports }),
    createSyncNativeInstruction(userQuoteAta),
    createAssociatedTokenAccountIdempotentInstruction(wallet, userBaseAta, wallet, poolBaseMint, baseTokenProgram),
  ];
  const eventAuthority = pda([Buffer.from('__event_authority')]);
  if (!uvaInfo) {
    // user_volume_accumulator 未初始化：先建（payer=user=wallet）
    ixs.push({
      programId: PAMM_PROGRAM,
      keys: [
        { pubkey: wallet, isWritable: true, isSigner: true },
        { pubkey: wallet, isWritable: false, isSigner: false },
        { pubkey: userVolAcc, isWritable: true, isSigner: false },
        { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
        { pubkey: eventAuthority, isWritable: false, isSigner: false },
        { pubkey: PAMM_PROGRAM, isWritable: false, isSigner: false },
      ],
      data: INIT_UVA_DISC,
    });
  }
  const creatorVaultAuth = pda([Buffer.from('creator_vault'), coinCreator.toBuffer()]);
  const keys = [
    { pubkey: poolAddr, isWritable: true, isSigner: false },
    { pubkey: wallet, isWritable: true, isSigner: true },
    { pubkey: globalConfig, isWritable: false, isSigner: false },
    { pubkey: poolBaseMint, isWritable: false, isSigner: false },
    { pubkey: quoteMint, isWritable: false, isSigner: false },
    { pubkey: userBaseAta, isWritable: true, isSigner: false },
    { pubkey: userQuoteAta, isWritable: true, isSigner: false },
    { pubkey: poolBaseTa, isWritable: true, isSigner: false },
    { pubkey: poolQuoteTa, isWritable: true, isSigner: false },
    { pubkey: protocolFeeRecipient, isWritable: false, isSigner: false },
    { pubkey: getAssociatedTokenAddressSync(quoteMint, protocolFeeRecipient, true), isWritable: true, isSigner: false },
    { pubkey: baseTokenProgram, isWritable: false, isSigner: false },
    { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false }, // quote token program (wSOL 恒为 SPL Token)
    { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
    { pubkey: ATA_PROGRAM, isWritable: false, isSigner: false },
    { pubkey: eventAuthority, isWritable: false, isSigner: false },
    { pubkey: PAMM_PROGRAM, isWritable: false, isSigner: false },
    { pubkey: getAssociatedTokenAddressSync(quoteMint, creatorVaultAuth, true), isWritable: true, isSigner: false },
    { pubkey: creatorVaultAuth, isWritable: false, isSigner: false },
    { pubkey: pda([Buffer.from('global_volume_accumulator')]), isWritable: false, isSigner: false },
    { pubkey: userVolAcc, isWritable: true, isSigner: false },
    {
      pubkey: pda([Buffer.from('fee_config'), PAMM_PROGRAM.toBuffer()], FEE_PROGRAM),
      isWritable: false,
      isSigner: false,
    },
    { pubkey: FEE_PROGRAM, isWritable: false, isSigner: false },
  ];
  if (buybackBps > 0) {
    // 程序强制（6058）：remaining accounts = [buyback_recipient, 其 quote ATA]，任选数组其一
    const bbRecipient = new PublicKey(g.subarray(643, 675)); // buyback_fee_recipients[0]
    keys.push({ pubkey: bbRecipient, isWritable: true, isSigner: false });
    keys.push({
      pubkey: getAssociatedTokenAddressSync(quoteMint, bbRecipient, true),
      isWritable: true,
      isSigner: false,
    });
  }
  ixs.push({
    programId: PAMM_PROGRAM,
    keys,
    data: Buffer.concat([
      BUY_EXACT_QUOTE_IN_DISC,
      u64le(amountLamports),
      u64le(minOut),
      Buffer.from([1]),
    ] as unknown as Uint8Array[]),
  });
  ixs.push(createCloseAccountInstruction(userQuoteAta, wallet, wallet));
  timings.build_ms = Date.now() - b0;

  // ---- 5. 本地签名 + 发送即返回（不等待链上确认，同 execute-quote waitConfirm=false 语义）
  const tx = new VersionedTransaction(
    new TransactionMessage({ payerKey: wallet, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(),
  );
  const keypair = await solana.getWallet(walletAddress);
  tx.sign([keypair]);
  const x0 = Date.now();
  const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 });
  timings.send_ms = Date.now() - x0;
  timings.total_ms = Date.now() - t0;
  logger.info(
    `PumpSwap direct-buy sent: ${signature} pool=${poolAddress} in=${amountLamports}lamports ` +
      `expectedOut=${expectedOut} minOut=${minOut} feeBps=${feeBps} bh=${lastValidBlockHeight} timings=${JSON.stringify(timings)}`,
  );
  return {
    signature,
    status: 0,
    poolAddress,
    amountInLamports: amountLamports.toString(),
    expectedOut: expectedOut.toString(),
    minOut: minOut.toString(),
    feeBps,
    timings,
  };
}

export const directBuyRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: DirectBuyRequestBody }>(
    '/direct-buy',
    {
      schema: {
        description:
          'PumpSwap AMM direct buy: local pricing + local build, sign & send immediately (no Jupiter round-trip)',
        tags: ['/connector/pumpswap'],
        body: DirectBuyRequest,
      },
    },
    async (request) => {
      try {
        const b = request.body;
        return await directBuy(
          b.walletAddress,
          b.network ?? 'mainnet-beta',
          b.poolAddress,
          b.baseMint,
          b.amountSol,
          b.slippagePct,
          b.computeUnitLimit,
          b.computeUnitPriceMicroLamports,
        );
      } catch (e: any) {
        // 4xx = 场地/参数不支持（引擎回退 Jupiter）；5xx = 网关/RPC 故障（引擎不回退，防双仓）
        if (e.statusCode) throw e;
        logger.error('PumpSwap direct-buy error:', e);
        throw httpErrors.internalServerError(e.message || 'Internal server error');
      }
    },
  );
};

export default directBuyRoute;
