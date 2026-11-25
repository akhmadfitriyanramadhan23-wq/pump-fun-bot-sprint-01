// Launch-buy entrypoint: one program at main.ts on Node 22, stdlib only.
//
// The harness speaks agent-fun/replay/v2 over stdin/stdout: it sends a
// hello, then one batch per slot, and expects exactly one reply of orders
// per batch. The kit shim in vendor/ owns that wire — it reads each batch,
// keeps the account, positions and curves current, and writes the reply.
// This file only hands every batch to the strategy in strategy.ts, which
// decides the orders, and logs a one-line summary when the replay ends.
//
// The bot paper-trades pump.fun bonding curves: it buys a hot launch in
// its first seconds — several distinct buyers, creator holding with a
// small stake — near the create price, then banks the burst in full at
// +15% and exits fast, recycling positions quickly because launches
// cluster. Buying after a burst has already crossed loses money (the spike reverses
// inside the two-slot latency), so the launch itself is the only place
// to buy. See strategy.ts for the full rules.
import { runBot } from './vendor/makefun-bot.ts';
import { LaunchBuy } from './strategy.ts';

const bot = new LaunchBuy();

await runBot({
  onBatch(state, batch) {
    return bot.onBatch(state, batch);
  },
  onDone(state) {
    bot.onDone(state);
  },
});
