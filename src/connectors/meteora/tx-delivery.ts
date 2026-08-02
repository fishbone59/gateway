import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

import { PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { AddressLookupTableAccount, Connection, MessageV0, Signer, TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';

import { Solana } from '../../chains/solana/solana';
import { httpErrors } from '../../services/error-handler';
import { logger } from '../../services/logger';

/**
 * Reusable multi-transaction delivery for Meteora flows (zap-in today, zap-out next).
 *
 * The zap SDK (and similar builders) prebuild an ordered sequence of transactions whose
 * later steps depend on the state created by earlier ones. This module provides the three
 * delivery strategies for such sequences plus the shared preparation machinery:
 *
 *  - prepareSequence:   pin one shared blockhash + CU limits and sign everything up front
 *  - deliverPipelined:  broadcast back-to-back with a stagger, confirm the batch at the end
 *                       (fastest, but intra-slot execution order is best-effort)
 *  - deliverNozomiGated: confirm-gated sequential delivery via Temporal/Nozomi
 *                       (deterministic order, ~1 slot per step, costs a tip per tx)
 */

// ---------------------------------------------------------------------------
// Types

export interface LabeledTx {
  label: string;
  tx: Transaction | VersionedTransaction;
  signers: Signer[];
  cuOverride?: number;
}

export interface PreparedTx {
  label: string;
  tx: Transaction | VersionedTransaction;
}

export interface DeliveryConfirmation {
  signature: string;
  confirmed: boolean;
  error?: string;
  fee?: number;
}

export interface DeliveryOutcome {
  signatures: string[];
  results: DeliveryConfirmation[];
  totalFee: number;
  keySignature?: string;
}

export interface DeliveryOptions {
  /** Log/error prefix, e.g. 'Zap-in' */
  flowName?: string;
  /** Label whose signature is reported as keySignature (e.g. 'zapIn') */
  keyLabel?: string;
  /** Dispatch stagger for pipelined delivery (default 150ms — must exceed leader-arrival jitter) */
  staggerMs?: number;
  /** Maps a failure to an actionable recovery hint (e.g. resumeOnly/cleanupOnly guidance) */
  recoveryHint?: (failedLabel: string, confirmedLabels: string[]) => string;
  /** Attempt metadata (position address, pool, bins...) persisted right after bundle
   * submission — if the process dies or the client disconnects after a landing, the
   * position is recoverable from data/zapin-attempts.jsonl instead of tx archaeology. */
  attemptRecord?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Compute-unit table for fast delivery (no per-tx simulation possible pre-broadcast;
// values pinned from observed mainnet consumption)

export const DEFAULT_FAST_CU_OVERRIDES: Record<string, number> = {
  setup: 40_000, // measured ~24k
  ledger: 50_000, // measured ~27k
};
export const SWAP_CU_OVERRIDE = 150_000; // measured 24k-105k depending on Jupiter route

/** Static priority fee for Nozomi delivery — on Nozomi paths the tip is the lever,
 * priority fee is essentially ignored (their docs: start with 100% of the bid in the tip). */
export const STATIC_PRIORITY_FEE = 0.1; // lamports per CU

// ---------------------------------------------------------------------------
// Jito block engine — https://docs.jito.wtf/lowlatencytxnsend
// A bundle is up to 5 transactions executed in ONE slot, strictly in order,
// all-or-nothing — exactly the zap-in sequence semantics, with no reorder risk
// and no intermediate state to recover (a failed bundle drops entirely).
// One tip transfer to any of the 8 tip accounts is required per bundle (NOT per
// tx), minimum 1000 lamports; check https://bundles.jito.wtf/api/v1/bundles/tip_floor
// for the live auction floor. Auth: x-jito-auth header with the provisioned UUID
// (default 2 req/s — keep polling at 1/s and leave headroom for sendBundle).
// Land-rate tracking: every submission is appended to logs/jito-bundles.jsonl —
// Jito requires >75% land rate for 7 days (with self-tracked logs) before any
// rate-limit increase.

export const JITO_TIP_FLOOR_URL = 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';
export const JITO_DEFAULT_API_URL = 'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles';
export const JITO_MAX_BUNDLE_SIZE = 5;
export const JITO_DEFAULT_TIP_LAMPORTS = 10_000; // ~75th percentile of the tip floor
export const JITO_DEFAULT_MAX_TIP_LAMPORTS = 200_000;
/** tip_floor percentiles are dominated by small (1-2 tx, <200k CU) bundles, so the
 * percentile value is scaled by bundle CU when pricing our much larger bundles —
 * the auction effectively compares tip per unit of block space. */
export const JITO_TIP_REFERENCE_CU = 200_000;
export const JITO_TIP_SAFETY_FACTOR = 1.25;
// Canonical tip accounts (stable, match getTipAccounts; hardcoded to save one
// rate-limited request per zap-in).
export const JITO_TIP_ACCOUNTS = [
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
];

// ---------------------------------------------------------------------------
// Temporal (Nozomi) — https://use.temporal.xyz
// Every transaction must carry its own >= 0.001 SOL tip transfer to a public tip
// address (below-minimum tips are silently dropped). Rotate addresses per transaction
// to avoid write-lock contention.

export const NOZOMI_BATCH_URL = 'https://nozomi.temporal.xyz/api/sendBatch';
export const NOZOMI_TIP_LAMPORTS = 1_000_000; // 0.001 SOL per transaction (Nozomi default minimum)
export const NOZOMI_TIP_ADDRESSES = [
  'TEMPaMeCRFAS9EKF53Jd6KpHxgL47uWLcpFArU1Fanq',
  'noz3jAjPiHuBPqiSPkkugaJDkJscPuRhYnSpbi8UvC4',
  'noz3str9KXfpKknefHji8L1mPgimezaiUyCHYMDv1GE',
  'noz6uoYCDijhu1V7cutCpwxNiSovEwLdRHPwmgCGDNo',
  'noz9EPNcT7WH6Sou3sr3GGjHQYVkN3DNirpbvDkv9YJ',
  'nozc5yT15LazbLTFVZzoNZCwjh3yUtW86LoUyqsBu4L',
  'nozFrhfnNGoyqwVuwPAW4aaGqempx4PU6g6D9CJMv7Z',
  'nozievPk7HyK1Rqy1MPJwVQ7qQg2QoJGyP71oeDwbsu',
  'noznbgwYnBLDHu8wcQVCEw6kDrXkPdKkydGJGNXGvL7',
  'nozNVWs5N8mgzuD3qigrCG2UoKxZttxzZ85pvAQVrbP',
  'nozpEGbwx4BcGp6pvEdAh1JoC2CQGZdU6HbNP1v2p6P',
  'nozrhjhkCr3zXT3BiT4WCodYCUFeQvcdUkM7MqhKqge',
  'nozrwQtWhEdrA6W8dkbt9gnUaMs52PdAv5byipnadq3',
  'nozUacTVWub3cL4mJmGCYjKZTnE9RbdY5AP46iQgbPJ',
  'nozWCyTPppJjRuw2fpzDhhWbW355fzosWSzrrMYB1Qk',
  'nozWNju6dY353eMkMqURqwQEoM3SFgEKC6psLCSfUne',
  'nozxNBgWohjR75vdspfxR5H9ceC7XXH99xpxhVGt3Bb',
];

// ---------------------------------------------------------------------------
// Helpers

export function signatureOf(tx: Transaction | VersionedTransaction): string {
  return bs58.encode(tx instanceof Transaction ? (tx.signature as Buffer) : tx.signatures[0]);
}

/** Append an instruction to a versioned (v0) transaction by decompiling, adding the
 * instruction and recompiling with the same address lookup tables. Caller must
 * (re-)sign afterwards. */
export async function appendInstructionToVersionedTx(
  connection: Connection,
  tx: VersionedTransaction,
  ix: TransactionInstruction,
): Promise<void> {
  const msg = tx.message as MessageV0;
  const lookups = (
    await Promise.all(
      msg.addressTableLookups.map((l) => connection.getAddressLookupTable(l.accountKey).then((r) => r.value)),
    )
  ).filter((a): a is AddressLookupTableAccount => !!a);
  const compiled = TransactionMessage.decompile(msg, { addressLookupTableAccounts: lookups });
  compiled.instructions.push(ix);
  tx.message = compiled.compileToV0Message(lookups);
}

/** Attach a Nozomi tip transfer to every transaction in the sequence (required per-tx). */
export async function addNozomiTips(connection: Connection, payer: PublicKey, sequence: LabeledTx[]): Promise<void> {
  for (const entry of sequence) {
    const tipIx = SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: new PublicKey(NOZOMI_TIP_ADDRESSES[Math.floor(Math.random() * NOZOMI_TIP_ADDRESSES.length)]),
      lamports: NOZOMI_TIP_LAMPORTS,
    });
    if (entry.tx instanceof Transaction) {
      entry.tx.add(tipIx);
    } else {
      await appendInstructionToVersionedTx(connection, entry.tx, tipIx);
    }
  }
}

/** Pin one shared blockhash + CU limits and sign the whole sequence up front. */
export function prepareSequence(
  solana: Solana,
  feePayer: PublicKey,
  sequence: LabeledTx[],
  blockhash: string,
  priorityFeePerCU: number,
  cuTable: Record<string, number> = DEFAULT_FAST_CU_OVERRIDES,
): PreparedTx[] {
  return sequence.map(({ label, tx, signers, cuOverride }) => {
    const cu = cuOverride ?? cuTable[label] ?? (label.startsWith('swap') ? SWAP_CU_OVERRIDE : undefined);
    if (tx instanceof Transaction) {
      tx.feePayer = feePayer;
    }
    return { label, tx: solana.prepareForRapidBroadcast(tx, signers, blockhash, priorityFeePerCU, cu) };
  });
}

// ---------------------------------------------------------------------------
// Delivery strategies

/**
 * Pipelined plain broadcast: dispatch each send `staggerMs` apart WITHOUT awaiting the
 * previous RPC response, then confirm the whole batch in one polling loop.
 * Fastest delivery (~4s for 5 txs), but intra-slot execution order is best-effort —
 * a reorder once left the ledger executing before the swap it records, so callers
 * MUST verify the semantic outcome afterwards.
 */
export async function deliverPipelined(
  solana: Solana,
  prepared: PreparedTx[],
  lastValidBlockHeight: number,
  opts: DeliveryOptions = {},
): Promise<DeliveryOutcome> {
  const flow = opts.flowName ?? 'Flow';
  const staggerMs = opts.staggerMs ?? 150;
  const signatures: string[] = [];
  let keySignature: string | undefined;

  const sendPromises: Promise<string>[] = [];
  for (const { tx } of prepared) {
    sendPromises.push(solana.sendPreparedTransaction(tx));
    await new Promise((resolve) => setTimeout(resolve, staggerMs));
  }
  const settled = await Promise.allSettled(sendPromises);
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      signatures.push(s.value);
      if (prepared[i].label === opts.keyLabel) {
        keySignature = s.value;
      }
      logger.info(`${flow} pipelined: broadcast ${prepared[i].label} -> ${s.value}`);
    } else {
      logger.error(`${flow} pipelined: broadcast ${prepared[i].label} failed at RPC: ${s.reason?.message ?? s.reason}`);
      signatures.push(''); // keep index alignment with prepared
    }
  });
  const unsent = prepared.filter((_, i) => settled[i].status === 'rejected').map((p) => p.label);
  if (unsent.length > 0) {
    throw httpErrors.internalServerError(
      `${flow} pipelined broadcast failed at RPC for [${unsent.join(', ')}]; nothing after those was sent. ` +
        `Sent signatures: ${signatures.filter(Boolean).join(', ')}`,
    );
  }

  const results = await solana.confirmTransactionsBatch(signatures, lastValidBlockHeight);
  results.forEach((r, i) => {
    logger.info(
      `${flow} pipelined: ${prepared[i].label} ${r.signature} -> ${r.confirmed ? 'confirmed' : `FAILED (${r.error ?? 'expired'})`}`,
    );
  });
  const failedLabels = prepared.filter((_, i) => !results[i].confirmed).map((p) => p.label);
  if (failedLabels.length > 0) {
    const confirmedLabels = prepared.filter((_, i) => results[i].confirmed).map((p) => p.label);
    const hint = opts.recoveryHint?.(failedLabels[0], confirmedLabels) ?? '';
    throw httpErrors.internalServerError(
      `${flow} pipelined broadcast incomplete: failed=[${failedLabels.join(', ')}], confirmed=[${confirmedLabels.join(', ')}]. ` +
        `${hint} Signatures: ${signatures.join(', ')}`,
    );
  }
  const totalFee = results.reduce((acc, r) => acc + (r.fee ?? 0), 0);
  return { signatures, results, totalFee, keySignature };
}

/**
 * Confirm-gated sequential delivery through Temporal/Nozomi: submit one transaction,
 * wait for its on-chain confirmation, then submit the next. Nozomi forwards over
 * parallel staked paths, so even a single-request batch does NOT preserve execution
 * order at the leader (observed: zapIn executed before the ledger it depends on, in
 * the same slot) — gating on confirmation is the only robust fast pattern.
 * ~1 slot per step (~5-8s for 5 txs), deterministic order, deterministic failure point.
 */
export async function deliverNozomiGated(
  solana: Solana,
  prepared: PreparedTx[],
  lastValidBlockHeight: number,
  apiKey: string,
  opts: DeliveryOptions = {},
): Promise<DeliveryOutcome> {
  const flow = opts.flowName ?? 'Flow';
  if (!apiKey) {
    throw httpErrors.internalServerError(
      `${flow} temporal delivery requires a Nozomi API key (meteora.temporalApiKey in conf/connectors/meteora.yml).`,
    );
  }
  const signatures: string[] = [];
  const results: DeliveryConfirmation[] = [];
  let keySignature: string | undefined;
  let totalFee = 0;

  for (const p of prepared) {
    const sig = signatureOf(p.tx);
    const raw = Buffer.from(p.tx.serialize() as Uint8Array);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(raw.length, 0);
    const body = Buffer.concat([len, raw] as unknown as Uint8Array[]);
    const res = await fetch(`${NOZOMI_BATCH_URL}?c=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      const confirmedLabels = prepared.filter((_, i) => results[i]?.confirmed).map((x) => x.label);
      const hint = opts.recoveryHint?.(p.label, confirmedLabels) ?? '';
      throw httpErrors.internalServerError(
        `${flow} temporal: Nozomi rejected ${p.label} (HTTP ${res.status}): ${text}. ` +
          `Confirmed so far: [${confirmedLabels.join(', ')}]. ${hint}`,
      );
    }
    signatures.push(sig);
    if (p.label === opts.keyLabel) {
      keySignature = sig;
    }
    const [result] = await solana.confirmTransactionsBatch([sig], lastValidBlockHeight);
    results.push(result);
    if (!result.confirmed) {
      const confirmedLabels = prepared.filter((_, i) => results[i]?.confirmed).map((x) => x.label);
      const hint = opts.recoveryHint?.(p.label, confirmedLabels) ?? '';
      throw httpErrors.internalServerError(
        `${flow} temporal: ${p.label} failed on-chain (${result.error ?? 'not confirmed before blockhash expiry'}). ` +
          `Completed: [${confirmedLabels.join(', ')}]. ${hint}`,
      );
    }
    totalFee += result.fee ?? 0;
    logger.info(`${flow} temporal: ${p.label} confirmed (${sig})`);
  }
  return { signatures, results, totalFee, keySignature };
}

// ---------------------------------------------------------------------------
// Jito bundle delivery

/** Append the single bundle tip transfer to the LAST transaction of the sequence
 * (Jito requires one tip per bundle, not per tx). Rotate tip accounts to avoid
 * write-lock contention with other searchers. */
export async function addJitoTip(
  connection: Connection,
  payer: PublicKey,
  sequence: LabeledTx[],
  tipLamports: number = JITO_DEFAULT_TIP_LAMPORTS,
): Promise<void> {
  const last = sequence[sequence.length - 1];
  const tipIx = SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]),
    lamports: tipLamports,
  });
  if (last.tx instanceof Transaction) {
    last.tx.add(tipIx);
  } else {
    await appendInstructionToVersionedTx(connection, last.tx, tipIx);
  }
}

/** JSON-RPC call against the block engine with UUID auth. Retries on the
 * rate-limit error (-32097) with linear backoff — the default quota is 2 req/s. */
async function jitoRpc(method: string, params: unknown[], uuid: string, apiUrl: string, retries = 4): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-jito-auth': uuid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const json = await res.json();
    if (json.error) {
      const msg = JSON.stringify(json.error);
      if ((json.error.code === -32097 || msg.includes('Rate limit')) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 1100 * (attempt + 1)));
        continue;
      }
      throw new Error(`Jito ${method}: ${msg}`);
    }
    return json.result;
  }
}

/** Current tip floor (lamports per percentile), fetched from bundles.jito.wtf —
 * a separate host from the block engine, so these calls do NOT consume the
 * 2 req/s UUID quota. Cached for 30s to avoid hammering on rapid retries. */
interface JitoTipFloor {
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
}
let tipFloorCache: { at: number; floor: JitoTipFloor } | null = null;

async function fetchJitoTipFloor(): Promise<JitoTipFloor | null> {
  if (tipFloorCache && Date.now() - tipFloorCache.at < 30_000) {
    return tipFloorCache.floor;
  }
  try {
    const res = await fetch(JITO_TIP_FLOOR_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return tipFloorCache?.floor ?? null;
    }
    const d = (await res.json())?.[0];
    if (!d) {
      return tipFloorCache?.floor ?? null;
    }
    const toLamports = (sol: number) => Math.ceil((sol ?? 0) * 1e9);
    const floor: JitoTipFloor = {
      p25: toLamports(d.landed_tips_25th_percentile),
      p50: toLamports(d.landed_tips_50th_percentile),
      p75: toLamports(d.landed_tips_75th_percentile),
      p95: toLamports(d.landed_tips_95th_percentile),
      p99: toLamports(d.landed_tips_99th_percentile),
    };
    tipFloorCache = { at: Date.now(), floor };
    return floor;
  } catch {
    return tipFloorCache?.floor ?? null;
  }
}

/** Resolve the tip for one bundle. staticTip > 0 wins (fixed pricing). Otherwise
 * dynamic: p75 of the live tip floor, scaled by the bundle's total CU relative to
 * a small reference bundle (auction competition is per unit of block space — our
 * 5-tx ~2.3M CU zap-in bundle lost auctions repeatedly at a flat 10k tip), times
 * a safety factor, clamped to [1000, maxTip]. Falls back to JITO_DEFAULT_TIP_LAMPORTS
 * when the floor API is unreachable. */
export async function resolveJitoTipLamports(staticTip: number, totalCu: number, maxTip: number): Promise<number> {
  if (staticTip > 0) {
    return staticTip;
  }
  const floor = await fetchJitoTipFloor();
  if (!floor || floor.p75 <= 0) {
    logger.warn('Jito tip floor unavailable, falling back to static default tip');
    return JITO_DEFAULT_TIP_LAMPORTS;
  }
  const cuFactor = Math.max(1, totalCu / JITO_TIP_REFERENCE_CU);
  const tip = Math.ceil(floor.p75 * cuFactor * JITO_TIP_SAFETY_FACTOR);
  const clamped = Math.min(Math.max(tip, 1_000), maxTip);
  logger.info(
    `Jito dynamic tip: p75=${floor.p75} lamports x CU factor ${cuFactor.toFixed(1)} (${totalCu} CU) x ${JITO_TIP_SAFETY_FACTOR} = ${tip} (clamped: ${clamped})`,
  );
  return clamped;
}

/** Append one land-rate record — Jito requires self-tracked land-rate logs
 * (>75% over 7 days) for any future rate-limit increase. Kept in data/ (NOT
 * logs/ — `pnpm clean` wipes logs/, which would destroy the 7-day evidence). */
function logJitoLand(record: Record<string, unknown>): void {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    appendFileSync(join(process.cwd(), 'data', 'jito-bundles.jsonl'), JSON.stringify(record) + '\n');
  } catch (e) {
    logger.warn(`Jito land-rate log write failed: ${(e as Error).message}`);
  }
}

/** Persist a zap attempt (position address, pool, bins, bundleId, signatures)
 * IMMEDIATELY after bundle submission. If the process dies or the client
 * disconnects before the response, the position is recoverable from this file —
 * an untracked position would have no lp_executor watching it (no out-of-range
 * close, no take-profit/stop-loss). */
function logZapAttempt(record: Record<string, unknown>): void {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    appendFileSync(join(process.cwd(), 'data', 'zapin-attempts.jsonl'), JSON.stringify(record) + '\n');
  } catch (e) {
    logger.warn(`Zap attempt log write failed: ${(e as Error).message}`);
  }
}

/**
 * Jito bundle delivery: the whole sequence (<= 5 txs) executes in ONE slot,
 * strictly in order, all-or-nothing. There is no reorder risk and no partial
 * state — a non-landed bundle changes nothing on-chain, so recovery is simply
 * "retry". Costs one tip (default 10k lamports) for the whole bundle instead of
 * 0.001 SOL per transaction on the temporal path.
 */
export async function deliverJitoBundle(
  solana: Solana,
  prepared: PreparedTx[],
  lastValidBlockHeight: number,
  uuid: string,
  tipLamports: number = JITO_DEFAULT_TIP_LAMPORTS,
  apiUrl: string = JITO_DEFAULT_API_URL,
  opts: DeliveryOptions = {},
): Promise<DeliveryOutcome> {
  const flow = opts.flowName ?? 'Flow';
  if (!uuid) {
    throw httpErrors.internalServerError(
      `${flow} jito delivery requires a block-engine UUID (meteora.jitoUuid in conf/connectors/meteora.yml).`,
    );
  }
  if (prepared.length > JITO_MAX_BUNDLE_SIZE) {
    throw httpErrors.internalServerError(
      `${flow} jito: sequence has ${prepared.length} transactions, exceeding the bundle max of ${JITO_MAX_BUNDLE_SIZE}. ` +
        'Use broadcastMode serial/fast/temporal instead.',
    );
  }

  const signatures = prepared.map((p) => signatureOf(p.tx));
  const keySignature = prepared.find((p) => p.label === opts.keyLabel)
    ? signatures[prepared.findIndex((p) => p.label === opts.keyLabel)]
    : undefined;
  const encoded = prepared.map((p) => Buffer.from(p.tx.serialize() as Uint8Array).toString('base64'));
  const submittedAt = Date.now();

  const bundleId = await jitoRpc('sendBundle', [encoded, { encoding: 'base64' }], uuid, apiUrl);
  logger.info(`${flow} jito: bundle ${bundleId} submitted (${prepared.length} txs, tip ${tipLamports} lamports)`);
  if (opts.attemptRecord) {
    logZapAttempt({ ts: new Date(submittedAt).toISOString(), ...opts.attemptRecord, bundleId, signatures });
  }

  // Landing detection via our own RPC (Shyft): a landed bundle means every one of
  // its transactions confirms, typically within 1-3 slots. Jito's own status
  // endpoints are best-effort telemetry with cross-region/indexing lag (observed:
  // getInflightBundleStatuses reports "Invalid" for bundles that landed fine,
  // getBundleStatuses lags the landing by several seconds) — so they are used
  // ONLY as a backstop for the land-rate log, never for control flow. This also
  // leaves the full 2 req/s Jito quota available for sendBundle.
  //
  // A bundle can land at ANY point while its blockhash is valid — so "Dropped" is
  // only authoritative once lastValidBlockHeight has passed (~60-90s). Declaring
  // earlier risks the caller retrying and the first bundle landing late: two
  // positions, the first one invisible to any automation.
  let status = 'Dropped';
  let landedSlot: number | null = null;
  let txError: string | undefined;
  // Wall-clock backstop: the normal exit is blockhash expiry, but if our RPC
  // fails persistently (getBlockHeight keeps catching to 0) the loop must not
  // hang the request forever.
  const confirmDeadline = submittedAt + 150_000;
  for (;;) {
    const statuses = await solana.connection.getSignatureStatuses(signatures);
    const vals = statuses?.value ?? [];
    const confirmedCount = vals.filter(
      (v) => v && !v.err && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized'),
    ).length;
    if (confirmedCount === signatures.length) {
      status = 'Landed';
      landedSlot = Math.max(...vals.map((v) => v?.slot ?? 0)) || null;
      break;
    }
    const failed = vals.find((v) => v && v.err);
    if (failed) {
      // A landed bundle executes atomically, so a tx error here means the bundle
      // landed and failed on-chain (e.g. slippage) — NOT a drop.
      status = 'Failed';
      txError = JSON.stringify(failed.err);
      landedSlot = failed.slot ?? null;
      break;
    }
    const blockHeight = await solana.connection.getBlockHeight('confirmed').catch(() => 0);
    if (blockHeight > lastValidBlockHeight || Date.now() > confirmDeadline) {
      break; // blockhash expired (or wall-clock backstop) — the bundle can no longer land
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  if (status === 'Dropped') {
    // Backstop: our RPC may lag — check Jito's landed record once before
    // declaring the (already authoritative) drop, enriching the land-rate log.
    const landed = await jitoRpc('getBundleStatuses', [[bundleId]], uuid, apiUrl).catch(() => null);
    const entry = landed?.value?.[0];
    if (entry) {
      if (entry.err && entry.err.Ok === null) {
        status = 'Landed';
        landedSlot = entry.slot ?? null;
      } else {
        status = 'Failed';
        txError = JSON.stringify(entry.err);
        landedSlot = entry.slot ?? null;
      }
    }
  }
  const latencyMs = Date.now() - submittedAt;
  logJitoLand({
    ts: new Date(submittedAt).toISOString(),
    flow,
    bundleId,
    signatures,
    tipLamports,
    status,
    landedSlot,
    latencyMs,
  });

  if (status !== 'Landed') {
    throw httpErrors.internalServerError(
      status === 'Failed'
        ? `${flow} jito: bundle ${bundleId} landed but failed on-chain (${txError ?? 'unknown error'}). ` +
            'Bundles are atomic — the failed transaction reverted the whole bundle; nothing changed on-chain. ' +
            'Fix the cause (e.g. slippage) and retry. ' +
            `Signatures (unused): ${signatures.join(', ')}`
        : `${flow} jito: bundle ${bundleId} not landed before blockhash expiry — authoritative drop, retry is safe. ` +
            'Bundles are atomic — nothing changed on-chain. ' +
            `Signatures (unused): ${signatures.join(', ')}`,
    );
  }
  logger.info(`${flow} jito: bundle landed at slot ${landedSlot} in ${latencyMs}ms`);

  // Bundle landed => every tx is on-chain in order; collect fees via the shared
  // batch confirmation (already confirmed, so this is one status+fee fetch pass).
  const results = await solana.confirmTransactionsBatch(signatures, lastValidBlockHeight);
  results.forEach((r, i) => {
    logger.info(
      `${flow} jito: ${prepared[i].label} ${r.signature} -> ${r.confirmed ? 'confirmed' : `FAILED (${r.error ?? 'expired'})`}`,
    );
  });
  const unconfirmed = prepared.filter((_, i) => !results[i].confirmed).map((p) => p.label);
  if (unconfirmed.length > 0) {
    // Should not happen for a landed bundle — treat as data inconsistency, not partial state.
    logger.error(`${flow} jito: bundle landed but [${unconfirmed.join(', ')}] not found confirmed on-chain`);
  }
  const totalFee = results.reduce((acc, r) => acc + (r.fee ?? 0), 0);
  return { signatures, results, totalFee, keySignature };
}
