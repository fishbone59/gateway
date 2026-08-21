// Decode a wallet's recent Meteora DLMM instructions: open/add/remove/claim/close,
// position PDA, pool, bin range. Read-only analysis. Run from /root/gateway.
const fs = require('fs');
const { Connection, PublicKey } = require('@solana/web3.js');
const { BorshInstructionCoder } = require('@coral-xyz/anchor');
const { IDL } = require('@meteora-ag/dlmm');

const DLMM_PID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const wallet = process.argv[2];
const LIMIT = parseInt(process.argv[3] || '100', 10);

const conf = fs.readFileSync('/root/gateway/conf/chains/solana/mainnet-beta.yml', 'utf8');
const rpc = conf.match(/nodeURL:\s*(\S+)/)[1].replace(/["']/g, '');
const conn = new Connection(rpc, 'confirmed');
const coder = new BorshInstructionCoder(IDL);

const KNOWN = {
  cpamdpZCGKUy: 'Meteora DAMM v2 (cp-amm)',
  FqGg2Y1FNxMi: '???',
  proVF4pMXVaY: '???',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmtT = (bt) => bt ? new Date(bt * 1000).toISOString().slice(5, 19).replace('T', ' ') : '?';

// IDL ix account name -> index map, per instruction name
function ixAccountIdx(name) {
  const ix = IDL.instructions.find(i => i.name === name);
  if (!ix) return {};
  const m = {};
  ix.accounts.forEach((a, i) => { m[a.name] = i; });
  return m;
}

(async () => {
  const sigs = await conn.getSignaturesForAddress(new PublicKey(wallet), { limit: LIMIT });
  console.log(`${sigs.length} signatures fetched\n`);
  const events = [];
  const unknownProgs = new Map();

  for (const s of [...sigs].reverse()) {
    let tx;
    try { tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }); }
    catch (e) { console.log('fetch fail', s.signature.slice(0, 12), e.message.slice(0, 60)); continue; }
    await sleep(120);
    if (!tx) continue;
    const msg = tx.transaction.message;
    let keys, topIxs;
    if (Array.isArray(msg.instructions)) {
      keys = (msg.accountKeys || []).map(k => k.pubkey ? k.pubkey.toBase58() : k.toBase58());
      topIxs = msg.instructions;
    } else {
      // versioned raw message: resolve lookup addresses from meta
      const la = tx.meta?.loadedAddresses || { writable: [], readonly: [] };
      keys = [...msg.staticAccountKeys, ...la.writable, ...la.readonly]
        .map(k => k.pubkey ? k.pubkey.toBase58() : k.toBase58());
      topIxs = msg.compiledInstructions;
    }
    // collect unknown program ids (top-level ix)
    for (const ix of topIxs) {
      const pid = keys[ix.programIdIndex];
      if (['cpamdpZCGKUy', 'FqGg2Y1FNxMi', 'proVF4pMXVaY'].some(p => pid.startsWith(p)) && !unknownProgs.has(pid)) {
        unknownProgs.set(pid, s.signature);
      }
    }
    // decode all DLMM ixs (top-level + inner)
    const allIxs = [...topIxs];
    (tx.meta?.innerInstructions || []).forEach(ii => ii.instructions.forEach(ix => allIxs.push(ix)));
    for (const ix of allIxs) {
      let pid = ix.programId ? ix.programId.toBase58?.() || ix.programId : keys[ix.programIdIndex];
      if (pid !== DLMM_PID) continue;
      let dec;
      try { dec = coder.decode(ix.data, 'base58'); } catch (e) { continue; }
      if (!dec) continue;
      const amap = ixAccountIdx(dec.name);
      const accs = ix.accounts || [];
      const getAcc = (...names) => {
        for (const n of names) if (amap[n] !== undefined && accs[amap[n]] !== undefined) return keys[accs[amap[n]]];
        return null;
      };
      const pos = getAcc('position', 'positionV2');
      const pool = getAcc('lb_pair', 'lbPair');
      const d = dec.data || {};
      const num = (v) => (v === undefined || v === null) ? null : Number(v.toString());
      const lower = num(d.lower_bin_id ?? d.lowerBinId);
      const upper = num(d.upper_bin_id ?? d.upperBinId);
      events.push({
        time: tx.blockTime, name: dec.name, position: pos, pool,
        lower, upper,
        width: num(d.width), binId: num(d.bin_id ?? d.binId),
        fee: tx.meta?.fee, cu: tx.meta?.computeUnitsConsumed,
        sig: s.signature, slot: tx.slot,
      });
    }
  }

  console.log(`--- ${events.length} DLMM instructions decoded ---`);
  for (const e of events) {
    const extra = e.lower !== null ? `bins[${e.lower}..${e.upper}] width=${e.width}` : (e.binId !== null ? `binId=${e.binId}` : '');
    console.log(`${fmtT(e.time)}  ${e.name.padEnd(28)} ${extra.padEnd(30)} pos=${e.position ? e.position.slice(0, 8) : '-'} pool=${e.pool ? e.pool.slice(0, 8) : '-'}`);
  }

  // aggregate per position
  const byPos = {};
  for (const e of events) {
    if (!e.position) continue;
    (byPos[e.position] = byPos[e.position] || []).push(e);
  }
  // decode binStep for each pool seen
  const pools = [...new Set(events.map(e => e.pool).filter(Boolean))];
  const { BorshAccountsCoder } = require('@coral-xyz/anchor');
  const accCoder = new BorshAccountsCoder(IDL);
  const poolInfo = {};
  for (const p of pools) {
    try {
      const ai = await conn.getAccountInfo(new PublicKey(p));
      if (ai) {
        let lb = null;
        for (const n of ['lbPair', 'LbPair', 'lb_pair']) { try { lb = accCoder.decode(n, ai.data); break; } catch (e) {} }
        if (lb) poolInfo[p] = { binStep: Number(lb.bin_step), mintX: lb.token_x_mint?.toBase58?.() || '?', mintY: lb.token_y_mint?.toBase58?.() || '?' };
      }
    } catch (e) {}
    await sleep(120);
  }
  console.log('\n--- pools seen ---');
  for (const [p, i] of Object.entries(poolInfo)) console.log(`${p}  binStep=${i.binStep} (${(i.binStep / 100).toFixed(2)}%/bin)  X=${i.mintX.slice(0, 8)} Y=${i.mintY.slice(0, 8)}`);

  console.log('\n--- per-position summary ---');
  for (const [pos, evs] of Object.entries(byPos)) {
    const open = evs.find(e => e.name === 'initialize_position');
    const close = evs.find(e => e.name.startsWith('close_position'));
    const claims = evs.filter(e => e.name.startsWith('claim')).length;
    const adds = evs.filter(e => e.name.startsWith('add_liquidity')).length;
    const rems = evs.filter(e => e.name.startsWith('remove_liquidity')).length;
    const rebs = evs.filter(e => e.name.startsWith('rebalance')).length;
    const pool = (evs.find(e => e.pool) || {}).pool || '-';
    const first = evs[0].time, last = evs[evs.length - 1].time;
    const life = close && (open || evs.length > 1) ? ((last - first) / 60).toFixed(1) + ' min' : (close ? 'close-only' : 'still-open@window-end');
    let range = '-';
    const addEv = evs.find(e => e.lower !== null);
    if (addEv && addEv.lower !== null) {
      const nBins = addEv.upper !== null ? addEv.upper - addEv.lower + 1 : addEv.width;
      const bs = poolInfo[pool]?.binStep;
      range = `bins[${addEv.lower}..${addEv.upper ?? '?'}] ${nBins ?? '?'} bins` + (bs ? ` (~${((nBins || 0) * bs / 100).toFixed(2)}%)` : '');
    }
    console.log(`${pos.slice(0, 12)}  pool=${pool.slice(0, 8)}  ${range.padEnd(38)}  life=${life.padEnd(22)}  add=${adds} remove=${rems} rebalance=${rebs} claim=${claims}`);
  }

  console.log('\n--- unknown program full ids ---');
  for (const [pid, sig] of unknownProgs) console.log(pid, ' (example tx ' + sig.slice(0, 20) + '...)');
})().catch(e => { console.error(e); process.exit(1); });
