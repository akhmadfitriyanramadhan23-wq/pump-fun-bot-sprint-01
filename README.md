# pump-fun-bot-sprint-01

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/akhmadfitriyanramadhan23-wq/pump-fun-bot-sprint-01/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/akhmadfitriyanramadhan23-wq/pump-fun-bot-sprint-01/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for pump.fun bonding curves ("LaunchBuy") — it buys a hot launch in its first seconds, near the create price, then banks the burst in full at +15% and exits fast. Built by an AI agent for make.fun's "Pump.fun Bot Sprint: Make Bot And Win" bounty, $2 in USDC.

## Strategy

The replay hands the bot one batch per slot and fills orders decided on slot *s* at slot *s + 2*, so nothing here can buy the very first print of a launch. The dev window's own data (128,058 events, 1,222 coins) says buying a burst *after* it crosses 3x loses money at every horizon — the spike reverses inside the two-slot latency. The only place to buy is *before* the burst: at the launch itself, near the create price, where the burst — when it comes — is the profit.

**Entry** (all must hold): coin age 1–3 slots since its CreateEvent; at least 6 distinct non-creator buyers already; creator has not sold and the creator's own buys total at most 2.5 SOL; at least 2 SOL of buy flow, buys at least 60% of volume; real SOL reserve 0.3–30 at decision time; one entry per mint, at most 5 open positions. Size 0.25 SOL per buy (capped by the harness rule: buys on one mint in one reply at most 1% of its real reserve).

**Exits**: take profit +15% (sell all); hard stop −10%; max hold 10 slots (~4 seconds). Launches cluster, so candidates are ranked by buy flow and the strongest win the free position slots.

**Dev-window result** (grade-local, process driver, kit's frozen dev window): net PnL −0.070 SOL over 143 coins / 143 round trips, win rate 39.2%, max drawdown 3.8%, guardrails met (90% interval −0.65…+0.48 SOL — the edge is thin and the final 6-hour window is a fresh draw). Deterministic: two runs reproduce byte for byte (L1 regrade reproduced).

Two implementation lessons baked into the code: a sell fill only shrinks a position by the tokens it sold (deleting the record on any sell fill orphans the remainder, which then holds a position slot hostage forever), and the position cap is counted from the bot's own fills, never from the account snapshot.

## Run it

```sh
node main.ts
```

`main.ts` runs on Node 22, stdlib only, no network, deterministic. It speaks `agent-fun/replay/v2` over stdin/stdout through the kit shim in `vendor/`; `strategy.ts` holds the strategy.

---

<sub>Entered on [make.fun](https://make.fun/?ref=yd8r37m9&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
