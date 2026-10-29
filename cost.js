/**
 * DeepSeek billing arithmetic for dsh-deepseek-wallet.
 *
 * Everything here is pure, so it can be exercised without a Host:
 * model pricing, the Beijing-time peak/off-peak window, and aggregation of one
 * turn's billed assistant messages into CNY plus token buckets.
 *
 * Official prices (CNY per one million tokens), as published on
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing:
 *
 *   model              cache-hit        cache-miss       output
 *   deepseek-flash     0.02 / 0.04      1    / 2         4    / 8
 *   deepseek-v4-pro    0.15 / 0.30      4.5  / 9         13.5 / 27
 *                      valley / peak
 *
 * Peak = Beijing time (UTC+8) Monday through Friday, 09:00-12:00 and
 * 14:00-18:00, excluding Chinese statutory holidays. Every other hour — and a
 * whole statutory holiday or weekend — bills at the valley (peak/2) price.
 * DeepSeek has no separate cache-write fee: tokens written into the cache are
 * part of the cache-miss bucket.
 */

/** @typedef {{ hit: readonly [number, number], miss: readonly [number, number], out: readonly [number, number] }} ModelPrice */

/** Prices in CNY per one million tokens, `[valley, peak]`. */
export const PRICES_CNY_PER_MILLION = {
  'deepseek-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-pro': { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] },
};

/** Model whose price an unknown route falls back to. */
export const DEFAULT_MODEL = 'deepseek-flash';

/** Beijing-time peak windows, `[fromHour, toHour)` local hours. */
export const PEAK_WINDOWS = /** @type {const} */ ([[9, 12], [14, 18]]);

/**
 * Chinese statutory holiday dates (inclusive ranges, `YYYY-MM-DD`).
 * A weekday listed here bills at the valley price all day. Ranges outside this
 * table fall back to the plain weekday/weekend rule, which is the only stable
 * approximation before the State Council publishes the next year's calendar.
 */
export const HOLIDAY_RANGES = [
  // 2024
  ['2024-01-01', '2024-01-01'],
  ['2024-02-10', '2024-02-17'],
  ['2024-04-04', '2024-04-06'],
  ['2024-05-01', '2024-05-05'],
  ['2024-06-08', '2024-06-10'],
  ['2024-09-15', '2024-09-17'],
  ['2024-10-01', '2024-10-07'],
  // 2025
  ['2025-01-01', '2025-01-01'],
  ['2025-01-28', '2025-02-04'],
  ['2025-04-04', '2025-04-06'],
  ['2025-05-01', '2025-05-05'],
  ['2025-05-31', '2025-06-02'],
  ['2025-10-01', '2025-10-08'],
  // 2026
  ['2026-01-01', '2026-01-03'],
  ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'],
  ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'],
  ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07'],
  // 2027 (New Year; the rest of the calendar is unpublished)
  ['2027-01-01', '2027-01-03'],
];

const DAY_MS = 86_400_000;
/** @type {Set<string>} */
const HOLIDAYS = new Set();
for (const [from, to] of HOLIDAY_RANGES) {
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let cursor = Date.parse(`${from}T00:00:00Z`); cursor <= end; cursor += DAY_MS) {
    HOLIDAYS.add(new Date(cursor).toISOString().slice(0, 10));
  }
}

/**
 * Count one usage bucket; anything missing or non-positive reads as zero.
 * @param {unknown} value candidate bucket count.
 * @returns {number} a non-negative integer.
 */
export function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * Whether a moment bills at the peak price.
 * @param {number} timeMs Unix epoch milliseconds.
 * @returns {boolean} true inside a Beijing-time weekday peak window.
 */
export function isPeak(timeMs) {
  if (typeof timeMs !== 'number' || !Number.isFinite(timeMs)) return false;
  const shifted = new Date(timeMs + 8 * 3_600_000);
  const weekday = shifted.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  if (HOLIDAYS.has(shifted.toISOString().slice(0, 10))) return false;
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return PEAK_WINDOWS.some(([from, to]) => minutes >= from * 60 && minutes < to * 60);
}

/**
 * Price table for a model route.
 * @param {unknown} model provider model id, e.g. `deepseek-flash`.
 * @returns {ModelPrice} the table to bill with.
 */
export function priceForModel(model) {
  const name = typeof model === 'string' ? model.toLowerCase() : '';
  if (name.includes('pro')) return PRICES_CNY_PER_MILLION['deepseek-v4-pro'];
  return PRICES_CNY_PER_MILLION[DEFAULT_MODEL];
}

/**
 * Billed cost of one model call.
 * @param {object} usage model-call token usage (`inputTokens` is uncached input).
 * @param {unknown} model provider model id.
 * @param {number} timeMs time the call billed at.
 * @returns {number} cost in CNY.
 */
export function costOfCall(usage, model, timeMs) {
  const table = priceForModel(model);
  const band = isPeak(timeMs) ? 1 : 0;
  const input = count(usage?.inputTokens) + count(usage?.cacheWriteTokens);
  const cacheRead = count(usage?.cacheReadTokens);
  const output = count(usage?.outputTokens);
  const amount =
    input * table.miss[band] + cacheRead * table.hit[band] + output * table.out[band];
  return amount / 1_000_000;
}

/**
 * Collect the billed usage rows of one turn.
 * @param {readonly any[]} events session events of one complete log.
 * @param {number} turn turn number the message belongs to.
 * @returns {Array<{ usage: object, model?: string, provider?: string, time: number }>} rows.
 */
export function turnUsageRows(events, turn) {
  /** @type {Array<{ usage: object, model?: string, provider?: string, time: number }>} */
  const rows = [];
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue;
    const data = event.data;
    if (!data || data.turn !== turn) continue;
    const usage = data.usage ?? streamUsage(data.stream);
    if (!usage || typeof usage !== 'object') continue;
    const source = data.message?.source;
    rows.push({
      usage,
      model: typeof source?.model === 'string' ? source.model : undefined,
      provider: typeof source?.provider === 'string' ? source.provider : undefined,
      time: typeof event.time === 'number' ? event.time : Date.now(),
    });
  }
  return rows;
}

/**
 * Last `usage` record embedded in a compacted assistant stream.
 * @param {unknown} stream assistant stream records.
 * @returns {object | undefined} the usage block, when the stream carried one.
 */
export function streamUsage(stream) {
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record?.type === 'usage' && record.usage && typeof record.usage === 'object') {
      return record.usage;
    }
  }
  return undefined;
}

/**
 * Sum one turn's rows into billed tokens and CNY.
 * @param {ReturnType<typeof turnUsageRows>} rows billed rows of one turn.
 * @returns {{ currency: string, amount: number, peak: boolean, models: string[],
 *   tokens: { input: number, cacheRead: number, cacheWrite: number, output: number, total: number },
 *   cacheHitRate: number }} priced turn.
 */
export function aggregateTurn(rows) {
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  let amount = 0;
  let peak = false;
  /** @type {Set<string>} */
  const models = new Set();
  for (const row of rows) {
    input += count(row.usage?.inputTokens);
    cacheRead += count(row.usage?.cacheReadTokens);
    cacheWrite += count(row.usage?.cacheWriteTokens);
    output += count(row.usage?.outputTokens);
    amount += costOfCall(row.usage, row.model, row.time);
    if (isPeak(row.time)) peak = true;
    if (row.model) models.add(row.model);
  }
  const prompt = input + cacheRead + cacheWrite;
  return {
    currency: 'CNY',
    amount,
    peak,
    models: [...models],
    tokens: { input, cacheRead, cacheWrite, output, total: prompt + output },
    cacheHitRate: prompt > 0 ? cacheRead / prompt : 0,
  };
}
