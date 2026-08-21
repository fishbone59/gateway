// Full-history DLMM decode for a wallet: paginate ALL signatures, decode DLMM ixs,
// aggregate per-pool / per-position stats, dump JSON to /tmp/dlmm_positions.json.
// Read-only. Run from /root/gateway.
const fs = require('fs');
const { Connection, PublicKey } = require('@solana/web3.js');
const { BorshInstructionCoder, BorshAccountsCoder } = require('@coral-xyz/anchor');
const { IDL } = require('@meteora-ag/dlmm');

const DLMM_PID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const wallet = process.argv[2];
const conf = fs.readFileSync('/root/gateway/conf/chains/solana/mainnet-beta.yml', 'utf8');
const rpc = conf.match(/nodeURL:\s*(\S+)/)[1].replace(/["']/g, '');
const conn = new Connection(rpc, 'confirmed');
const coder = new BorshInstructionCoder(IDL);
const accCoder = new BorshAccountsCoder(IDL);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ixAccountIdx(name) {
  const ix = IDL.instructions.find(i => i.name === name);
  if (!ix) return {};
  const m = {};
  ix.accounts.forEach((a, i) => { m[a.name] = i; });
  return m;
}

(async () => {
  let sigs = [], before;
  while (true) {
    const opt = { limit: 1000 }; if (before) opt.before = before;
    const page = await conn.getSignaturesForAddress(new PublicKey(wallet), opt);
    await sleep(300);
    if (!page.length) break;
    sigs.push(...page);
    before = page[page.length - 1].signature;
    if (page.length < 1000) break;
  }
  console.error(`[info] ${sigs.length} signatures`);
  const events = [];
  let n = 0;
  for (const s of [...sigs].reverse()) {
    n++;
    let tx;
    try { tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }); }
    catch (e) { console.error('[retry]', e.message.slice(0, 50)); await sleep(2000); try { tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }); } catch (e2) { continue; } }
    await sleep(100);
    if (!tx) continue;
    if (n % 200 === 0) console.error(`[progress] ${n}/${sigs.length}`);
    const msg = tx.transaction.message;
    let keys, topIxs;
    if (Array.isArray(msg.instructions)) {
      keys = (msg.accountKeys || []).map(k => k.pubkey ? k.pubkey.toBase58() : k.toBase58());
      topIxs = msg.instructions;
    } else {
      const la = tx.meta?.loadedAddresses || { writable: [], readonly: [] };
      keys = [...msg.staticAccountKeys, ...la.writable, ...la.readonly].map(k => k.pubkey ? k.pubkey.toBase58() : k.toBase58());
      topIxs = msg.compiledInstructions;
    }
    const allIxs = [...topIxs];
    (tx.meta?.innerInstructions || []).forEach(ii => ii.instructions.forEach(ix => allIxs.push(ix)));
    for (const ix of allIxs) {
      const pid = ix.programId ? (ix.programId.toBase58?.() || ix.programId) : keys[ix.programIdIndex];
      if (pid !== DLMM_PID) continue;
      let dec;
      try { dec = coder.decode(ix.data, 'base58'); } catch (e) { continue; }
      if (!dec) continue;
      const amap = ixAccountIdx(dec.name);
      const accs = ix.accounts || [];
      const getAcc = (...names) => { for (const nm of names) if (amap[nm] !== undefined && accs[amap[nm]] !== undefined) return keys[accs[amap[nm]]]; return null; };
      const d = dec.data || {};
      const num = (v) => (v === undefined || v === null) ? null : Number(v.toString());
      events.push({
        time: tx.blockTime, name: dec.name,
        position: getAcc('position', 'positionV2'), pool: getAcc('lb_pair', 'lbPair'),
        lower: num(d.lower_bin_id ?? d.lowerBinId), upper: num(d.upper_bin_id ?? d.upperBinId),
        width: num(d.width), sig: s.signature,
      });
    }
  }
  fs.writeFileSync('/tmp/dlmm_positions.json', JSON.stringify(events));
  console.error(`[info] ${events.length} DLMM events -> /tmp/dlmm_positions.json`);

  // pool binStep + mints
  const pools = [...new Set(events.map(e => e.pool).filter(Boolean))];
  const poolInfo = {};
  for (const p of pools) {
    try {
      const ai = await conn.getAccountInfo(new PublicKey(p));
      if (ai) {
        let lb = null;
        for (const nm of ['lbPair', 'LbPair', 'lb_pair']) { try { lb = accCoder.decode(nm, ai.data); break; } catch (e) {} }
        if (lb) poolInfo[p] = { binStep: Number(lb.bin_step), mintX: lb.token_x_mint.toBase58(), mintY: lb.token_y_mint.toBase58() };
      }
    } catch (e) {}
    await sleep(120);
  }
  fs.writeFileSync('/tmp/dlmm_pools.json', JSON.stringify(poolInfo, null, 1));

  // per-position aggregation
  const byPos = {};
  for (const e of events) { if (!e.position) continue; (byPos[e.position] = byPos[e.position] || []).push(e); }
  const posSummary = Object.entries(byPos).map(([pos, evs]) => {
    const open = evs.find(e => e.name === 'initialize_position');
    const close = evs.find(e => e.name.startsWith('close_position'));
    const addEv = evs.find(e => e.lower !== null) || {};
    const pool = (evs.find(e => e.pool) || {}).pool || null;
    return {
      position: pos, pool,
      open: open ? open.time : evs[0].time, close: close ? close.time : null,
      life_min: close ? +(((close.time - (open ? open.time : evs[0].time)) / 60).toFixed(1)) : null,
      adds: evs.filter(e => e.name.startsWith('add_liquidity')).length,
      removes: evs.filter(e => e.name.startsWith('remove_liquidity')).length,
      rebalances: evs.filter(e => e.name.startsWith('rebalance')).length,
      claims: evs.filter(e => e.name.startsWith('claim')).length,
      lower: addEv.lower ?? null, width: addEv.width ?? null,
      mintX: pool && poolInfo[pool] ? poolInfo[pool].mintX : null,
      binStep: pool && poolInfo[pool] ? poolInfo[pool].binStep : null,
    };
  }).sort((a, b) => a.open - b.open);
  fs.writeFileSync('/tmp/dlmm_pos_summary.json', JSON.stringify(posSummary, null, 1));
  console.error(`[info] ${posSummary.length} positions -> /tmp/dlmm_pos_summary.json`);
  console.log('DONE');
})().catch(e => { console.error(e); process.exit(1); });
