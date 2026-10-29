/**
 * dsh-deepseek-wallet — Host half.
 *
 * Serves two authenticated `GET` routes on the shared `/api` channel:
 *
 *   /api/dsh-wallet.balance          DeepSeek account balance in CNY (API-key credential)
 *   /api/dsh-wallet.turn             billed tokens and CNY of the turn owning one message
 *
 * The browser halves in `client.js` fetch these routes; no Host Remote
 * namespace is involved. Pricing lives in `cost.js` and follows DeepSeek's
 * official peak/off-peak table.
 */
import { aggregateTurn, isPeak, turnUsageRows } from './cost.js';

/** DeepSeek account balance endpoint (`Authorization: Bearer <api key>`). */
const BALANCE_URL = 'https://api.deepseek.com/user/balance';
/** Credential reference resolved through `ctx.credentials`. */
const API_KEY_REF = 'DEEPSEEK_API_KEY';
/** Balance response cache lifetime; the endpoint is cheap but not free to hammer. */
const BALANCE_TTL_MS = 15_000;
/** Session log cache lifetime while a conversation keeps writing. */
const SESSION_TTL_MS = 5_000;
/** Upper bound of cached session logs (one entry is a whole logical session log). */
const SESSION_CACHE_LIMIT = 8;

export const inject = ['connection', 'credentials', 'sessionQuery'];

/**
 * Parse a balance string into a number.
 * @param {unknown} value raw decimal string from the balance endpoint.
 * @returns {number} the amount, or 0 when unreadable.
 */
function toAmount(value) {
  const amount = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(amount) ? amount : 0;
}

/**
 * Describe an error without leaking credentials.
 * @param {unknown} error thrown value.
 * @returns {string} a short message.
 */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Emit a JSON response that must never be cached by the browser.
 * @param {number} status HTTP status.
 * @param {unknown} body JSON body.
 * @returns {Response} the response.
 */
function json(status, body) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

/**
 * Read the account balance with the API key.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host context.
 * @returns {Promise<object>} normalized balance.
 */
async function fetchBalance(ctx) {
  let secret;
  try {
    const resolved = await ctx.credentials.resolve(API_KEY_REF);
    secret = resolved?.value;
  } catch {
    secret = undefined;
  }
  if (secret === undefined || secret === '') secret = process.env?.[API_KEY_REF];
  if (secret === undefined || secret === '') throw new Error('missing-credential');

  const response = await fetch(BALANCE_URL, {
    method: 'GET',
    headers: { accept: 'application/json', authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`balance-http-${response.status}`);
  const body = await response.json();
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  const info = infos.find((item) => item?.currency === 'CNY') ?? infos[0];
  if (info === undefined || info === null) throw new Error('balance-empty');
  return {
    currency: typeof info.currency === 'string' ? info.currency : 'CNY',
    available: body?.is_available === true,
    total: toAmount(info.total_balance),
    granted: toAmount(info.granted_balance),
    toppedUp: toAmount(info.topped_up_balance),
    at: Date.now(),
  };
}

/**
 * Host half entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host context.
 */
export function apply(ctx) {
  // --- balance: cached, single-flight ---------------------------------------
  let balanceState = { at: 0, value: /** @type {object | undefined} */ (undefined) };
  let balanceInflight = /** @type {Promise<object> | undefined} */ (undefined);

  const readBalance = () => {
    if (balanceState.value !== undefined && Date.now() - balanceState.at < BALANCE_TTL_MS) {
      return Promise.resolve(balanceState.value);
    }
    if (balanceInflight !== undefined) return balanceInflight;
    balanceInflight = (async () => {
      try {
        const value = await fetchBalance(ctx);
        balanceState = { at: Date.now(), value };
        return value;
      } finally {
        balanceInflight = undefined;
      }
    })();
    return balanceInflight;
  };

  // --- session events: cached, single-flight --------------------------------
  /** @type {Map<string, { at: number, events: readonly any[] }>} */
  const sessionCache = new Map();
  /** @type {Map<string, Promise<readonly any[]>>} */
  const sessionInflight = new Map();

  /**
   * Read one complete logical session log, sharing concurrent readers.
   * @param {string} sessionId session identity.
   * @returns {Promise<readonly any[]>} the session's events.
   */
  const readEvents = (sessionId) => {
    const cached = sessionCache.get(sessionId);
    if (cached !== undefined && Date.now() - cached.at < SESSION_TTL_MS) {
      return Promise.resolve(cached.events);
    }
    const pending = sessionInflight.get(sessionId);
    if (pending !== undefined) return pending;
    const task = (async () => {
      try {
        const snapshot = await ctx.sessionQuery.readSession(sessionId);
        const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
        sessionCache.set(sessionId, { at: Date.now(), events });
        while (sessionCache.size > SESSION_CACHE_LIMIT) {
          const oldest = sessionCache.keys().next().value;
          if (oldest === undefined) break;
          sessionCache.delete(oldest);
        }
        return events;
      } finally {
        sessionInflight.delete(sessionId);
      }
    })();
    sessionInflight.set(sessionId, task);
    return task;
  };

  /**
   * Register one authenticated GET route.
   * @param {string} path absolute `/api/...` path.
   * @param {(request: Request) => Promise<Response>} handler fetch-shaped handler.
   */
  const route = (path, handler) => {
    ctx.effect(
      () =>
        ctx.connection.fetch.register({
          path,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: handler,
        }),
      `dsh-deepseek-wallet: ${path}`,
    );
  };

  route('/api/dsh-wallet.balance', async () => {
    try {
      return json(200, await readBalance());
    } catch (error) {
      // A stale balance beats an empty corner: keep showing the last known value.
      if (balanceState.value !== undefined) {
        return json(200, { ...balanceState.value, stale: true, error: messageOf(error) });
      }
      return json(502, { error: messageOf(error) });
    }
  });

  route('/api/dsh-wallet.turn', async (request) => {
    const url = new URL(request.url, 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');
    const messageId = url.searchParams.get('messageId');
    if (sessionId === null || sessionId === '' || messageId === null || messageId === '') {
      return json(400, { error: 'missing-params' });
    }

    let events;
    try {
      events = await readEvents(sessionId);
    } catch (error) {
      return json(404, { error: 'session-unavailable', detail: messageOf(error) });
    }

    const target = events.find(
      (event) => event?.type === 'assistant/message' && event?.data?.message?.id === messageId,
    );
    if (target === undefined) return json(404, { error: 'message-not-found' });

    const turn = target.data?.turn;
    if (typeof turn !== 'number' || !Number.isSafeInteger(turn)) {
      return json(404, { error: 'message-not-found' });
    }

    const rows = turnUsageRows(events, turn);
    if (rows.length === 0) return json(404, { error: 'usage-unavailable' });

    const priced = aggregateTurn(rows);
    return json(200, {
      ...priced,
      currency: 'CNY',
      turn,
      at: Date.now(),
      // The UI shows a peak marker only when the whole turn billed at peak price.
      allPeak: priced.peak && rows.every((row) => isPeak(row.time)),
    });
  });
}
