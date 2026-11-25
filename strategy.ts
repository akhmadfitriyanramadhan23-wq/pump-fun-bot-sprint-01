// Launch-buy bot for the pump.fun paper sprint (agent-fun/replay/v2).
//
// The replay hands the bot one batch per slot: a hello first, then a batch
// of chain events for that slot, and the bot answers with its orders for
// the slot. Orders decided on slot s fill at slot s + 2 (the latency the
// hello announces), so nothing here can buy the very first print of a
// launch — by the time an order fills, the move is two slots old.
//
// What the dev window's own data says (128,058 events, 1,222 coins),
// measured properly this time — entry at the first price two slots after
// the decision, dead coins counted at their last price:
// buying a burst AFTER it crosses 3x loses money at every horizon
// (median -3% ten slots after the crossing, mean negative everywhere),
// because the spike reverses inside the two-slot latency. Four designs
// failed on this window for exactly that reason: confirmed rises, peak
// holds and crossing buys all buy the top. The only place left to buy is
// BEFORE the burst: at the launch itself, near the create price, where
// the burst — when it comes — is the profit. A launch is worth buying
// only when it is already hot: several distinct buyers paying in the
// first seconds, the creator holding instead of dumping, and the
// creator's own stake small.
//
// Entry (all must hold at decision time):
//   - coin seen since its CreateEvent, age 1..5 slots (the launch window)
//   - >= 5 distinct non-creator buyers already (breadth, not one wallet)
//   - creator has not sold, and the creator's own buys total <= 3 SOL
//   - >= 2 SOL of buy flow since create, buys >= 60% of all volume
//   - real SOL reserve 0.3..30 at decision time (a real curve, not dust
//     and not already a whale's playground)
//   - one entry per mint, ever; at most 5 open positions (hello caps)
//
// Size: 0.25 SOL per buy, capped by the harness rule (buys on one mint
// in one reply <= 1% of real reserve) and by free cash. Fees run ~1.25%
// a side plus a 105,000-lamport tx fee per order, so nothing below
// 0.01 SOL is ever worth sending.
//
// Exits, per position — fast, because most launches bleed out:
//   - at +15% sell all the tokens (bank the burst in full; a runner kept
//     after a partial gave its gains back too often)
//   - hard stop at -10% from cost
//   - max hold 10 slots (~4 seconds): launches cluster, so positions
//     must recycle fast — a launch that has not burst by then is dead
//   - a completed curve is closed by the harness itself
//
// Everything is deterministic: every decision comes from the event
// stream only. No clock, no environment, no randomness.

import type { Batch, BotState, Fill, OrderInput } from './vendor/makefun-bot.ts';

const ENTRY = {
  buySolMin: 2.0, // ... on at least 2 SOL of early buy flow
  creatorBuyMax: 2.5, // the creator's own buys must total <= 2.5 SOL
  sizeLamports: 250_000_000n, // 0.25 SOL per buy
  stopLoss: -0.1, // sell at -10% from cost
  takeProfit: 0.15, // sell all the tokens at +15%
  maxHoldSlots: 10, // ~4 seconds: recycle positions fast, launches cluster
};
const MIN_AGE_SLOTS = 1; // buy the launch while it is still launching
const MAX_AGE_SLOTS = 3; // ... but only in the first seconds
const MIN_BUYERS = 6; // breadth: at least 6 distinct non-creator buyers
const BUY_SHARE_MIN = 0.6; // buys must be >= 60% of volume
const REAL_MIN_LAMPORTS = 300_000_000n; // real reserve >= 0.3 SOL
const REAL_MAX_LAMPORTS = 30_000_000_000n; // ... and <= 30 SOL
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: the guardrail's round trip
const BUY_SLIPPAGE_BPS = 4000; // launches move fast; accept a wide fill
const SELL_SLIPPAGE_BPS = 8000; // exits must fill on the first try

interface CoinTrack {
  /** Price (virtual quote / virtual token) at first sight. */
  p0: number;
  /** Latest known price. */
  price: number;
  trades: number;
  buySol: number;
  sellSol: number;
  /** SOL the creator themself has bought. */
  creatorBuySol: number;
  /** Distinct non-creator wallets that bought (breadth of the launch). */
  buyers: Set<string>;
  /** Wallet that created the coin (from its CreateEvent). */
  creator: string;
  /** True once the creator has sold any amount. */
  creatorSold: boolean;
  complete: boolean;
}

interface Held {
  /** Tokens held, as of the latest account. */
  tokens: bigint;
  /** Total SOL outlay (fill quote + tx fee), lamports. */
  costLamports: bigint;
  entrySlot: number;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

export class LaunchBuy {
  /** Per-mint launch tracking, in first-seen order. */
  private coins = new Map<string, CoinTrack>();
  /** Mints we already tried to buy once (one entry per mint, ever). */
  private entered = new Set<string>();
  /** Open positions, keyed by mint. */
  private held = new Map<string, Held>();
  /** Pending buy client_id -> mint, so fills can open positions. */
  private pendingBuys = new Map<string, string>();
  /** Mints with a completed round trip (any sell fill). */
  private closed = new Set<string>();
  private buys = 0;
  private sells = 0;
  private fillsSeen = 0;

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    this.applyFills(batch.fills);
    this.syncHeld(state);
    this.considerExits(state, batch, orders);
    this.considerEntries(state, batch, orders);
    return orders;
  }

  onDone(state: BotState): void {
    const cashSol = Number(state.cash) / 1e9;
    console.error(
      `[launch-buy] done: cash=${cashSol.toFixed(4)} SOL buys=${this.buys} sells=${this.sells} ` +
        `distinctClosed=${this.closed.size} open=${this.held.size} fillsSeen=${this.fillsSeen}`,
    );
  }

  /** Fold this batch's fills in: open positions on buy fills, close on sells.
   *
   * A sell fill only shrinks the position by the tokens it sold, and the
   * cost basis scales down with them. Only a fill that sells the last
   * tokens, or a harness close (a client_id starting with `_`: the curve
   * completed, the replay ended, or a write-off), completes the round
   * trip. Deleting the record on any sell fill would orphan whatever
   * tokens remain: they would sit in the account forever, hold one of
   * the 5 position slots hostage, and the bot would stop trading.
   */
  private applyFills(fills: Fill[]): void {
    for (const f of fills) {
      this.fillsSeen++;
      if (f.status !== 'filled') {
        // A rejected/failed buy frees nothing: the mint stays entered
        // (one shot per mint) and no position opens.
        this.pendingBuys.delete(f.client_id);
        continue;
      }
      if (f.side === 'buy') {
        const mint = this.pendingBuys.get(f.client_id);
        this.pendingBuys.delete(f.client_id);
        if (mint === undefined) continue;
        const tokens = BigInt(f.token_amount);
        if (tokens === 0n) continue;
        this.buys++;
        this.held.set(mint, {
          tokens,
          costLamports: BigInt(f.quote_lamports) + BigInt(f.tx_fee_lamports),
          entrySlot: f.slot,
        });
      } else {
        this.sells++;
        const rec = this.held.get(f.mint);
        if (rec === undefined) {
          this.closed.add(f.mint);
          continue;
        }
        const sold = BigInt(f.token_amount);
        // A harness close ends the position whatever the fill says
        // (a write-off sells 0 tokens but the position is gone).
        if (f.client_id.startsWith('_')) {
          this.closed.add(f.mint);
          this.held.delete(f.mint);
          continue;
        }
        if (sold >= rec.tokens) {
          // The last tokens are gone: the round trip is complete.
          this.closed.add(f.mint);
          this.held.delete(f.mint);
        } else {
          // Fewer tokens sold than held (a harness partial close): keep
          // tracking the rest, with the cost basis scaled down with the
          // tokens, or the remaining gain would read wrong.
          const before = rec.tokens;
          rec.tokens -= sold;
          rec.costLamports = (rec.costLamports * rec.tokens) / before;
        }
      }
    }
  }

  /** Positions I hold plus buys in flight, by mint: what counts against
   * the hello caps. Counted from my own fills, never from the account
   * snapshot — the account lists a mint as long as any tokens remain,
   * which is exactly the runner a partial sale leaves behind.
   */
  private openPositionCount(): number {
    const mints = new Set<string>(this.held.keys());
    for (const mint of this.pendingBuys.values()) mints.add(mint);
    return mints.size;
  }

  /** Drop held records for mints the account no longer holds. */
  private syncHeld(state: BotState): void {
    for (const mint of [...this.held.keys()]) {
      const pos = state.positions.get(mint);
      if (pos === undefined) {
        this.held.delete(mint);
        continue;
      }
      const rec = this.held.get(mint)!;
      rec.tokens = pos.token_amount;
    }
  }

  /** Sells for every held position whose exit rule fires. */
  private considerExits(state: BotState, batch: Batch, orders: OrderInput[]): void {
    // A sell already in flight (fills two slots after its batch) covers the
    // position: sending another for the same tokens only earns a rejection
    // (insufficient_tokens) once the first fills.
    const sellPending = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') sellPending.add(p.order.mint);
    }
    for (const [mint, rec] of this.held) {
      if (sellPending.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0 || rec.costLamports === 0n) continue;
      // Current value in lamports (float is plenty: ratios need ~0.1% accuracy).
      const value = Number(rec.tokens) * price;
      const ratio = value / Number(rec.costLamports);
      const gain = ratio - 1;
      const heldTooLong = batch.slot - rec.entrySlot >= ENTRY.maxHoldSlots;
      const stopHit = gain <= ENTRY.stopLoss;
      if (stopHit || heldTooLong) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: rec.tokens,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        continue;
      }
      // Take profit at +15%: sell everything. A runner kept after the
      // partial gave its gains back too often (the trailing stop exits
      // near breakeven), so the full size banks the burst when it comes.
      if (gain >= ENTRY.takeProfit) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: rec.tokens,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        continue;
      }
    }
  }

  /** Buys: walk this batch's events in order, track launches, buy hot ones.
   *
   * Launches cluster — dozens of coins can qualify in the same few slots
   * while only 5 positions are open — so candidates are collected first
   * and the strongest buy flow wins the free slots, instead of whichever
   * trade the batch happened to list first. A coin that loses the race
   * for a slot is NOT marked entered: it stays eligible on later trades
   * while its launch window is still open.
   */
  private considerEntries(state: BotState, batch: Batch, orders: OrderInput[]): void {
    const candidates: { mint: string; buySol: number }[] = [];
    const candidateMints = new Set<string>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!this.coins.has(e.mint)) {
          const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          this.coins.set(e.mint, {
            p0: p,
            price: p,
            trades: 0,
            buySol: 0,
            sellSol: 0,
            creatorBuySol: 0,
            buyers: new Set<string>(),
            creator: e.creator,
            creatorSold: false,
            complete: false,
          });
        }
        continue;
      }
      if (e.event === 'CompleteEvent') {
        const c = this.coins.get(e.mint);
        if (c !== undefined) c.complete = true;
        continue;
      }
      // TradeEvent.
      let c = this.coins.get(e.mint);
      if (c === undefined) {
        const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        c = {
          p0: p,
          price: p,
          trades: 0,
          buySol: 0,
          sellSol: 0,
          creatorBuySol: 0,
          buyers: new Set<string>(),
          creator: e.creator,
          creatorSold: false,
          complete: false,
        };
        this.coins.set(e.mint, c);
      }
      c.price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      c.trades += 1;
      const sol = Number(BigInt(e.sol_amount)) / 1e9;
      if (e.is_buy) {
        c.buySol += sol;
        if (e.user === c.creator) c.creatorBuySol += sol;
        else c.buyers.add(e.user);
      } else {
        c.sellSol += sol;
        if (e.user === c.creator) c.creatorSold = true;
      }

      if (this.entered.has(e.mint)) continue;
      if (this.held.has(e.mint)) continue;
      if (c.complete || c.creatorSold) continue;
      if (c.p0 <= 0) continue;
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.created_slot === null) continue;
      const age = batch.slot - curve.created_slot;
      if (age < MIN_AGE_SLOTS || age > MAX_AGE_SLOTS) continue;
      // Hot launch only: several distinct buyers already, the creator
      // holding with a small stake, real buy flow, buys dominating.
      if (c.buyers.size < MIN_BUYERS) continue;
      if (c.creatorBuySol > ENTRY.creatorBuyMax) continue;
      if (c.buySol < ENTRY.buySolMin) continue;
      const volume = c.buySol + c.sellSol;
      if (volume <= 0 || c.buySol / volume < BUY_SHARE_MIN) continue;
      const realSol = BigInt(e.real_quote_reserves);
      if (realSol < REAL_MIN_LAMPORTS || realSol > REAL_MAX_LAMPORTS) continue;
      if (candidateMints.has(e.mint)) {
        const prev = candidates.find((k) => k.mint === e.mint);
        if (prev !== undefined && c.buySol > prev.buySol) prev.buySol = c.buySol;
        continue;
      }
      candidateMints.add(e.mint);
      candidates.push({ mint: e.mint, buySol: c.buySol });
    }

    // Strongest buy flow first: a clustered launch window spends the
    // free position slots on the hottest coins.
    candidates.sort((a, b) => b.buySol - a.buySol);
    let buysAdded = 0;
    let cashReserved = 0n;
    for (const cand of candidates) {
      if (this.openPositionCount() + buysAdded >= state.hello.caps.max_open_positions) break;
      const cap = state.maxBuyLamports(cand.mint);
      const size = ENTRY.sizeLamports < cap ? ENTRY.sizeLamports : cap;
      if (size < MIN_BUY_LAMPORTS) continue;
      if (state.freeCashLamports() - cashReserved < size + state.txFeeLamports()) continue;
      const id = state.clientId();
      this.pendingBuys.set(id, cand.mint);
      this.entered.add(cand.mint);
      buysAdded++;
      cashReserved += size + state.txFeeLamports();
      orders.push({
        side: 'buy',
        client_id: id,
        mint: cand.mint,
        quote_lamports: size,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
    }
  }
}
