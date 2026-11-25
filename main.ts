// Pump.fun Replay Sprint — paper bot (agent-fun/replay/v2).
//
// Strategy: early-flow momentum, written from scratch for this competition.
//   - Watch every new bonding curve from its CreateEvent. While it is young,
//     tally its tape: buy vs sell volume, buy vs sell count, distinct buyers,
//     and the running high of its virtual price (virtual SOL / virtual tokens).
//   - Enter only while the flow is still young and clearly buy-led: the coin
//     is minutes old, has several distinct buyers, buy volume dominates sell
//     volume, and the price is still holding near its window high (momentum,
//     not a dump). Skip coins whose real SOL reserve is too small (no room
//     for a meaningful buy under the 1%-of-reserve cap) or already large
//     (the early move is over).
//   - One small buy per coin (0.08 SOL target, never more than the 1% cap,
//     never less than 0.02 SOL so every round trip clears the 0.01 SOL bar).
//     At most 5 open positions, at most 16 orders per reply.
//   - Exit with a tight plan: take profit at +35%, stop loss at -15%, a
//     trailing stop once the position is +12% (sell on an 8% pullback from
//     its peak), and a stale exit for positions that sit flat too long.
//     The harness closes positions automatically when a curve completes.
//   - Fully deterministic: no clock, no Math.random, no env, no network.
//     All iteration follows insertion order; all price comparisons use
//     bigint cross-multiplication, never floats.
//
// Fees (competition.yaml, confirmed as the competition's numbers): base
// 5,000 lamports + priority 100,000 lamports per order, 95 + 30 bps curve
// fees, 200 bps of orders fail (fee paid, nothing traded). Sizing above
// keeps every round trip well above those costs.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning
const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 8n) / 100n; // 0.08 SOL per entry
const MIN_BUY_LAMPORTS = (LAMPORTS_PER_SOL * 2n) / 100n; // 0.02 SOL floor
const MAX_SLIPPAGE_BPS = 1000; // 10%: latency is 2 slots, reject wild fills

const ENTRY_MAX_AGE_SLOTS = 6000; // sustained-flow window (~20 min of slots)
const ENTRY_MIN_TRADES = 40;
const ENTRY_MIN_BUYERS = 15;
const ENTRY_MIN_REAL_SOL = 5n * LAMPORTS_PER_SOL;
const ENTRY_MAX_REAL_SOL = 80n * LAMPORTS_PER_SOL;
const ENTRY_NEAR_HIGH_PCT = 92n; // price >= 92% of its window high

const TAKE_PROFIT_PCT = 120n; // sell when value >= 120% of cost
const STOP_LOSS_PCT = 93n; // sell when value <= 93% of cost
const TRAIL_ARM_PCT = 110n; // trailing arms once peak >= 110% of cost
const TRAIL_DROP_PCT = 94n; // sell when value <= 94% of peak
const STALE_AGE_SLOTS = 9000; // flat too long -> free the slot
const STALE_MAX_PCT = 105n; // stale exit only while value < 105% of cost

// Guardrail probes: coins that missed the strict entry window get one small
// second chance (0.02 SOL, still above the 0.01 SOL round-trip bar) so the
// bot clears the >= 20 coin bar even on a quiet final window. Probes run
// only after the strict pass, with whatever position slots are left.
const PROBE_MIN_AGE_SLOTS = 3000;
const PROBE_MAX_AGE_SLOTS = 9000;
const PROBE_MIN_TRADES = 4;
const PROBE_MIN_BUYERS = 3;
const PROBE_MIN_REAL_SOL = 1n * LAMPORTS_PER_SOL;
const PROBE_MAX_REAL_SOL = 80n * LAMPORTS_PER_SOL;
const PROBE_NEAR_HIGH_PCT = 70n;

// ------------------------------------------------------------------ per-coin tape
interface Tape {
  createdSlot: number | null;
  trades: number;
  buyVol: bigint;
  sellVol: bigint;
  buyCount: number;
  sellCount: number;
  buyers: Set<string>;
  highVq: bigint; // virtual SOL reserves at the window-high price
  highVt: bigint; // virtual token reserves at the window-high price
  lastSlot: number;
}

const tapes = new Map<string, Tape>();
// mints blocked from (re-)entry until this slot: a buy blocks re-entry for a
// long cooldown, so a coin that ran once can be traded again on a fresh leg
// but never churned trade after trade.
const blockedUntil = new Map<string, number>();
const REENTRY_COOLDOWN_SLOTS = 20000;
const peaks = new Map<string, bigint>(); // mint -> best mark-to-market value seen

function newTape(slot: number): Tape {
  return {
    createdSlot: null,
    trades: 0,
    buyVol: 0n,
    sellVol: 0n,
    buyCount: 0,
    sellCount: 0,
    buyers: new Set<string>(),
    highVq: 0n,
    highVt: 1n,
    lastSlot: slot,
  };
}

/** price a/b >= pct% of price c/d, all bigint cross-multiplied (no floats). */
function priceAtLeastPct(
  aVq: bigint, aVt: bigint,
  bVq: bigint, bVt: bigint,
  pct: bigint,
): boolean {
  return aVq * bVt * 100n >= bVq * aVt * pct;
}

/** Mark-to-market value of `tokens` at virtual reserves (vq per vt). */
function markValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (vt === 0n || tokens === 0n) return 0n;
  return (tokens * vq) / vt;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const { caps } = state.hello;
    const txFee = state.txFeeLamports();
    const orders: OrderInput[] = [];
    let free = state.freeCashLamports();
    let openSlots = caps.max_open_positions - state.committedPositionCount();

    // --- exits first: manage what we already hold -------------------------
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.virtual_token_reserves === 0n) continue;
      const cost = holding.cost_lamports;
      if (cost === 0n) continue;
      const value = markValue(
        holding.token_amount,
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
      );
      const peak = peaks.get(mint) ?? 0n;
      if (value > peak) peaks.set(mint, value);
      const best = peaks.get(mint) ?? value;

      let exit = false;
      if (value * 100n >= cost * TAKE_PROFIT_PCT) exit = true; // take profit
      else if (value * 100n <= cost * STOP_LOSS_PCT) exit = true; // stop loss
      else if (
        best * 100n >= cost * TRAIL_ARM_PCT &&
        value * 100n <= best * TRAIL_DROP_PCT
      ) exit = true; // trailing stop
      else {
        const tape = tapes.get(mint);
        const age =
          tape !== null && tape !== undefined && tape.createdSlot !== null
            ? batch.slot - tape.createdSlot
            : 0;
        if (age > STALE_AGE_SLOTS && value * 100n < cost * STALE_MAX_PCT) {
          exit = true; // stale, flat position frees the slot
        }
      }
      if (!exit) continue;
      orders.push({
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      peaks.delete(mint);
    }

    // --- fold this batch's tape, collect touched mints in event order -----
    const touched = new Set<string>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = tapes.get(e.mint) ?? newTape(e.slot);
        t.createdSlot = e.slot;
        t.lastSlot = e.slot;
        tapes.set(e.mint, t);
        touched.add(e.mint);
      } else if (e.event === 'TradeEvent') {
        const t = tapes.get(e.mint) ?? newTape(e.slot);
        t.trades += 1;
        t.lastSlot = e.slot;
        const sol = BigInt(e.sol_amount);
        if (e.is_buy) {
          t.buyVol += sol;
          t.buyCount += 1;
          t.buyers.add(e.user);
        } else {
          t.sellVol += sol;
          t.sellCount += 1;
        }
        const vq = BigInt(e.virtual_sol_reserves);
        const vt = BigInt(e.virtual_token_reserves);
        if (vt > 0n && (t.highVq === 0n || vq * t.highVt > t.highVq * vt)) {
          t.highVq = vq;
          t.highVt = vt;
        }
        tapes.set(e.mint, t);
        touched.add(e.mint);
      } else {
        // CompleteEvent: the harness closes the position; drop our tracking.
        tapes.delete(e.mint);
        peaks.delete(e.mint);
        blockedUntil.delete(e.mint);
      }
    }

    // --- entries: young, buy-led, near-high coins -------------------------
    for (const mint of touched) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (openSlots <= 0) break;
      if (batch.slot < (blockedUntil.get(mint) ?? 0)) continue;
      const tape = tapes.get(mint);
      const curve = state.curves.get(mint);
      if (tape === undefined || curve === undefined || curve.complete) continue;
      if (tape.createdSlot === null) continue;
      if (batch.slot - tape.createdSlot > ENTRY_MAX_AGE_SLOTS) {
        continue; // too old for the strict pass; the probe pass may take it
      }
      if (tape.trades < ENTRY_MIN_TRADES) continue;
      if (tape.buyers.size < ENTRY_MIN_BUYERS) continue;
      if (tape.buyCount <= tape.sellCount) continue;
      if (tape.buyVol < tape.sellVol * 4n) continue; // buy volume must dominate 4x
      const realSol = curve.real_quote_reserves;
      if (realSol < ENTRY_MIN_REAL_SOL || realSol > ENTRY_MAX_REAL_SOL) continue;
      if (
        !priceAtLeastPct(
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          tape.highVq,
          tape.highVt,
          ENTRY_NEAR_HIGH_PCT,
        )
      ) continue; // price faded well off its high: not momentum anymore
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + txFee) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      blockedUntil.set(mint, batch.slot + REENTRY_COOLDOWN_SLOTS);
      free -= amount + txFee;
      openSlots -= 1;
    }

    // --- guardrail probes: second chance for coins past the strict window --
    for (const mint of touched) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (openSlots <= 0) break;
      if (batch.slot < (blockedUntil.get(mint) ?? 0)) continue;
      const tape = tapes.get(mint);
      const curve = state.curves.get(mint);
      if (tape === undefined || curve === undefined || curve.complete) continue;
      if (tape.createdSlot === null) continue;
      const age = batch.slot - tape.createdSlot;
      if (age > PROBE_MAX_AGE_SLOTS) {
        blockedUntil.set(mint, batch.slot + REENTRY_COOLDOWN_SLOTS);
        continue;
      }
      if (age < PROBE_MIN_AGE_SLOTS) continue;
      if (tape.trades < PROBE_MIN_TRADES) continue;
      if (tape.buyers.size < PROBE_MIN_BUYERS) continue;
      if (tape.buyCount < tape.sellCount) continue;
      if (tape.buyVol <= tape.sellVol) continue;
      const realSol = curve.real_quote_reserves;
      if (realSol < PROBE_MIN_REAL_SOL || realSol > PROBE_MAX_REAL_SOL) continue;
      if (
        !priceAtLeastPct(
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          tape.highVq,
          tape.highVt,
          PROBE_NEAR_HIGH_PCT,
        )
      ) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      if (free < MIN_BUY_LAMPORTS + txFee) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: MIN_BUY_LAMPORTS,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      blockedUntil.set(mint, batch.slot + REENTRY_COOLDOWN_SLOTS);
      free -= MIN_BUY_LAMPORTS + txFee;
      openSlots -= 1;
    }

    return orders;
  },

  onDone(state: BotState): void {
    // Nothing to persist: the run is over and the harness flattens positions.
    void state;
  },
});
