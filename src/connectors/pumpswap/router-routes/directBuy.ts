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
// - 不支持：quote != wSOL 的池、is_mayhem_mode 池（需 reserved 收款方列表）（4xx 让引擎回退 Jupiter）
//   cashback 币 / Token-2022 base 均支持（remaining 结构相同，官方 SDK 证实）
// - cc=SET 池（coin_creator@211 ≠ 11111111…，2026-08-26 实单踩坑）：必须多传一个 remaining
//   account = PDA(["pool-v2", base_mint], pAMM)（按 mint 派生、只读、链上不存在也要传，
//   否则 6062 InvalidPoolV2），位置在 cashback ATA 之后、buyback 收款方之前
// - cashback 币：remaining[0] 附 ATA(quote_mint, user_volume_accumulator) 可写（可选，
//   附了 creator fee 返现给我们，不附则归 creator —— 官方 PUMP_CASHBACK_README）
// - 费率精确计算（官方 pump-swap-sdk fees.js 同款）：canonical 池（pool.creator@11 ==
//   PDA(["pool-authority", base_mint], pump 程序 6EF8rr…），即 migrate 毕业池）→ 本地
//   FEE_TIERS 阶梯表按 mcap=quoteReserve×mintSupply/baseReserve 查档；非 canonical →
//   FLAT_FEES(25,5,0)。阶梯表为 fee_config 链上快照（2026-08-26，mindshare 实单 GetFees
//   返回 (20,5,95) 交叉验证）。报价用 effective quote reserve = vault + virtual_quote_reserves@245
//   （i128，现全链为 0）
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

// 自建交易 CU 预算（T22 首买含 ATA 创建时实测会超过 150k）；价格默认 0.1 lamport/CU，
// 请求 250k CU 时优先费 ~0.000025 SOL（Solana 优先费按请求上限计费，比 150k 每笔多 ~0.00001 SOL）。
const DEFAULT_CU_LIMIT = 250_000;
const DEFAULT_CU_PRICE_MICRO_LAMPORTS = 100_000;

const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

// ---- 费率表（2026-08-26 链上 fee_config 5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx 快照，
// 官方 pump_fees IDL 布局。算法 = 官方 pump-swap-sdk fees.js computeFeesBps：
// canonical 池（pool.creator@11 == PDA(["pool-authority", base_mint], PUMP_PROGRAM)，即
// bonding curve migrate 毕业的池）→ 按 mcap(lamports)=quoteReserve×mintSupply/baseReserve
// 查 FEE_TIERS；非 canonical（社区池等）→ FLAT_FEES。阈值单位 lamports。
// 快照已用 mindshare 实单 GetFees CPI 返回值 (20,5,95) 交叉验证（mcap≈1180 SOL → tier1）。
// 若 pump 官方改档：重读 fee_config 账户更新本表即可。）
const FLAT_FEES = { lp: 25, proto: 5, creator: 0 } as const;
const FEE_TIERS: ReadonlyArray<{ th: bigint; lp: number; proto: number; creator: number }> = [
  { th: 0n, lp: 2, proto: 93, creator: 30 },
  { th: 420000000000n, lp: 20, proto: 5, creator: 95 },
  { th: 1470000000000n, lp: 20, proto: 5, creator: 90 },
  { th: 2460000000000n, lp: 20, proto: 5, creator: 85 },
  { th: 3440000000000n, lp: 20, proto: 5, creator: 80 },
  { th: 4420000000000n, lp: 20, proto: 5, creator: 75 },
  { th: 9820000000000n, lp: 20, proto: 5, creator: 70 },
  { th: 14740000000000n, lp: 20, proto: 5, creator: 65 },
  { th: 19650000000000n, lp: 20, proto: 5, creator: 60 },
  { th: 24560000000000n, lp: 20, proto: 5, creator: 55 },
  { th: 29470000000000n, lp: 20, proto: 5, creator: 50 },
  { th: 34380000000000n, lp: 20, proto: 5, creator: 45 },
  { th: 39300000000000n, lp: 20, proto: 5, creator: 40 },
  { th: 44210000000000n, lp: 20, proto: 5, creator: 35 },
  { th: 49120000000000n, lp: 20, proto: 5, creator: 30 },
  { th: 54030000000000n, lp: 20, proto: 5, creator: 28 },
  { th: 58940000000000n, lp: 20, proto: 5, creator: 25 },
  { th: 63860000000000n, lp: 20, proto: 5, creator: 23 },
  { th: 68770000000000n, lp: 20, proto: 5, creator: 20 },
  { th: 73681000000000n, lp: 20, proto: 5, creator: 18 },
  { th: 78590000000000n, lp: 20, proto: 5, creator: 15 },
  { th: 83500000000000n, lp: 20, proto: 5, creator: 13 },
  { th: 88400000000000n, lp: 20, proto: 5, creator: 10 },
  { th: 93330000000000n, lp: 20, proto: 5, creator: 8 },
  { th: 98240000000000n, lp: 20, proto: 5, creator: 5 },
];
/** calculateFeeTier：mcap 落入最后一个 threshold ≤ mcap 的档 */
function tierFees(mcapLamports: bigint): { lp: number; proto: number; creator: number } {
  for (let i = FEE_TIERS.length - 1; i >= 0; i--) if (mcapLamports >= FEE_TIERS[i].th) return FEE_TIERS[i];
  return FEE_TIERS[0];
}
/** i128 LE 读取（Pool.virtual_quote_reserves @245，现全链为 0，官方要求报价用 effective=raw+virtual） */
function readI128le(b: Buffer): bigint {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = v * 256n + BigInt(b[i]);
  return v >= 1n << 127n ? v - (1n << 128n) : v;
}

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
  canonical: boolean;
  feeBreakdown: { lp: number; proto: number; creator: number };
  cashback: boolean;
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
  if (pd[243]) throw httpErrors.badRequest('mayhem pool (unsupported, reserved fee recipients)');
  const isCashback = !!pd[244]; // cashback 币可直连：附 cashback ATA 还能拿 creator fee 返现

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
  const baseTokenProgram = baseMintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  // 费率精确计算（官方 pump-swap-sdk fees.js 同款；2026-08-26 起替代 120bps 保守上限）：
  // canonical 池（pool.creator@11 == PDA(["pool-authority", base_mint], pump 程序）→ 阶梯表按
  // mcap 查档；非 canonical → flat (25,5,0)。mcap = effectiveQuoteReserve × mintSupply / baseReserve。
  const poolCreator = new PublicKey(pd.subarray(11, 43));
  const canonical = poolCreator.equals(
    PublicKey.findProgramAddressSync([Buffer.from('pool-authority'), poolBaseMint.toBuffer()], PUMP_PROGRAM)[0],
  );
  const mintSupply = baseMintInfo.data.readBigUInt64LE(36); // SPL/t22 mint 布局 supply @36
  const virtualQuote = pd.length >= 261 ? readI128le(pd.subarray(245, 261)) : 0n; // 现全链为 0
  const effectiveQuoteReserve = reserveQuote + virtualQuote;
  if (effectiveQuoteReserve <= 0n) throw httpErrors.badRequest('empty effective quote reserves');
  const mcapLamports = (effectiveQuoteReserve * mintSupply) / reserveBase;
  const fees = canonical ? tierFees(mcapLamports) : FLAT_FEES;
  const feeBps = fees.lp + fees.proto + fees.creator;
  // pool-v2 remaining account 的条件（官方 SDK buy.js）：coin_creator ≠ default
  const hasCreator = !coinCreator.equals(SystemProgram.programId);
  const protocolFeeRecipient = new PublicKey(g.subarray(57, 89)); // recipients[0]
  const buybackBps = Number(g.readBigUInt64LE(899));

  // ---- 3. 本地定价（恒定乘积，全 floor 取整 —— minOut 偏保守方向）
  const effectiveIn = (amountLamports * BigInt(10_000 - feeBps)) / 10_000n;
  const expectedOut = (effectiveIn * reserveBase) / (effectiveQuoteReserve + effectiveIn);
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
  // remaining accounts 顺序（官方 SDK buyInstructionsNoPool 原文）：
  // [cashback 币: ATA(quote_mint, user_volume_accumulator) 可写]
  // → [coin_creator≠0: pool-v2 PDA 只读] → [buyback_recipient 只读, 其 quote ATA 可写]
  if (isCashback) {
    keys.push({
      pubkey: getAssociatedTokenAddressSync(quoteMint, userVolAcc, true),
      isWritable: true,
      isSigner: false,
    });
  }
  if (hasCreator) {
    // cc=SET 池：pool-v2 PDA（按 base_mint 派生，只读，链上不存在也传）否则 6062 InvalidPoolV2
    keys.push({
      pubkey: pda([Buffer.from('pool-v2'), poolBaseMint.toBuffer()]),
      isWritable: false,
      isSigner: false,
    });
  }
  if (buybackBps > 0) {
    // 程序强制（6058）：任选 8 个 buyback_fee_recipients 其一
    const bbRecipient = new PublicKey(g.subarray(643, 675)); // buyback_fee_recipients[0]
    keys.push({ pubkey: bbRecipient, isWritable: false, isSigner: false });
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
    canonical,
    feeBreakdown: { lp: fees.lp, proto: fees.proto, creator: fees.creator },
    cashback: isCashback,
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
