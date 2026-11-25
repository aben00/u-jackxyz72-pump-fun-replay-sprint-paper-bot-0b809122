# u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/aben00/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/aben00/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A deterministic paper-trading bot for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty. It trades 10 virtual SOL over a replay of pump.fun bonding-curve events (protocol `agent-fun/replay/v2`), using an early-flow momentum strategy written from scratch: it buys young coins whose tape is clearly buy-led (buy volume dominating, several distinct buyers, price holding near its window high) and exits with a take-profit at +35%, stop-loss at -15%, a trailing stop, and a stale-position exit. Fully deterministic — no clock, no randomness, no network — so two runs produce byte-identical action logs.

## Run it

```sh
node main.ts
```

The bot speaks NDJSON on stdin/stdout: the harness sends `hello`, then one `batch` per slot, then `done`; the bot replies with exactly one JSON line per batch. No dependencies, no build step — Node 22 runs the TypeScript directly. The `vendor/makefun-bot.ts` shim is the kit's SDK, copied unchanged.

---

<sub>Entered on [make.fun](https://make.fun/?ref=bh1grvtt&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
