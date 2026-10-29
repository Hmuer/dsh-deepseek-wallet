# dsh-deepseek-wallet

Live **DeepSeek account balance** and **per-turn CNY cost** inside the DSH Web conversation UI.

| Where | What |
| --- | --- |
| Right side of the composer toolbar | Balance chip (`余额 ¥42.02` / `Balance ¥42.02`). Click it for total, granted and topped-up amounts plus the account-available flag. |
| Action row of every completed turn, next to the token usage pill | The turn's cost in CNY (`¥2.16`). Hover it for the turn's tokens, cache hit rate and the pricing band. |

Everything is read-only and local to your machine: the plugin never sends your conversation anywhere.

## Install

```sh
# from this repository
dsh plugin add github:Hmuer/dsh-deepseek-wallet

# or from a prebuilt tarball (attached to the latest release)
dsh plugin add https://github.com/Hmuer/dsh-deepseek-wallet/releases/download/v0.1.0/dsh-deepseek-wallet-0.1.0.tgz
```

Then reload the Web page. No configuration is needed.

Remove with `dsh plugin remove dsh-deepseek-wallet`.

## Where the numbers come from

**Balance** — the Host half resolves the `DEEPSEEK_API_KEY` credential (falling back to the
same-named environment variable) and calls the official endpoint
`https://api.deepseek.com/user/balance` with it. The key stays server-side and is never sent
to the browser. Results are cached for 15 seconds and served through an authenticated
`GET /api/dsh-wallet.balance` route; when the endpoint fails, the last known value is returned
with `stale: true` instead of the chip disappearing. The chip polls every 60 seconds, refreshes
when the window regains focus, and refreshes once more after a turn's cost arrives.

**Turn cost** — `GET /api/dsh-wallet.turn?sessionId=…&messageId=…` finds the turn owning the
final assistant message, collects that turn's billed `assistant/message` events, and prices each
message with its own timestamp so a turn that crosses a peak/off-peak boundary is split
accordingly. Prices are DeepSeek's official table (CNY per one million tokens, `[valley, peak]`):

| Model | Cache hit | Cache miss | Output |
| --- | --- | --- | --- |
| `deepseek-flash` | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro` | 0.15 / 0.30 | 4.5 / 9 | 13.5 / 27 |

- Peak: Beijing time, Monday–Friday 09:00–12:00 and 14:00–18:00, excluding Chinese statutory
  holidays. Everything else — weekends and holidays all day — bills at the valley price.
- The statutory-holiday table covers 2024–2027. Dates beyond it fall back to the weekday/weekend
  rule.
- Cache writes are billed as cache misses; cached input is priced with the cache-hit rate.
- Routes whose model name is neither `deepseek-flash` nor contains `pro` (e.g. a future model)
  are priced as `deepseek-flash`, which can under- or over-estimate their cost.

Rates come from <https://api-docs.deepseek.com/zh-cn/quick_start/pricing> and are compiled into
`cost.js`; the plugin makes no pricing request at runtime.

## Notes and limits

- Both routes live behind the Harness Connection authentication fence: an unauthenticated
  request gets `401` and the browser half shows nothing.
- The balance endpoint needs an API-key credential. Accounts signed in through DeepSeek
  OAuth instead of an API key show no chip (the plugin does not call the account-login API).
- A turn's cost is what the billing arithmetic says the reported usage costs; it is not a
  substitute for the provider's own invoice.
- Cost is shown per completed turn, so the rows appear once a turn finishes — not while it runs.
- The token-usage pill itself is rendered by the Harness `dsh-token-meter` UI, which only shows
  it in the detailed performance mode; this plugin's cost chip is independent of that setting.

## Layout

- `index.js` — Host half: authenticated `/api` routes, balance fetch, session log reading.
- `cost.js` — pure pricing and aggregation (peak windows, holiday table, per-message cost).
- `client.js` — browser half: two slot registrations, polling, hover/click surfaces.
- `locale/en.json` — plugin metadata for the Harness.
- `cordis.patch.yml` — bundle patch that inserts the plugin.

Only `react` is required by the browser half; the rest is plain DOM and `fetch` with the page's
own cookies.

## Development

```sh
node --check index.js && node --check cost.js && node --check client.js
```

`cost.js` has no dependencies, so it can be unit-tested from any Node script:

```js
import { costOfCall, isPeak, aggregateTurn } from './cost.js';
```

This repository is a plain bundle directory: `package.json` declares `dsh.bundle.patch` and
`dsh.client`, and `cordis.patch.yml` inserts it as `dsh-deepseek-wallet`.

## License

MIT
