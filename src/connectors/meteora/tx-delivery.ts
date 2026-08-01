import { PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type {
  AddressLookupTableAccount,
  Connection,
  MessageV0,
  Signer,
  TransactionInstruction,
} from '@solana/web3.js';
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
}

// ---------------------------------------------------------------------------
// Compute-unit table for fast delivery (no per-tx simulation possible pre-broadcast;
// values pinned from observed mainnet consumption)

export const DEFAULT_FAST_CU_OVERRIDES: Record<string, number> = {
  setup: 60_000, // observed ~24k
  ledger: 120_000, // observed ~27k
};
export const SWAP_CU_OVERRIDE = 300_000; // observed 32k-105k depending on Jupiter route

/** Static priority fee for Nozomi delivery — on Nozomi paths the tip is the lever,
 * priority fee is essentially ignored (their docs: start with 100% of the bid in the tip). */
export const STATIC_PRIORITY_FEE = 0.1; // lamports per CU

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
