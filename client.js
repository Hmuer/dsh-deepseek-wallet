/**
 * dsh-deepseek-wallet — Client half.
 *
 * Two seats:
 *   conversation.input.right            live CNY account balance chip (click: grant/top-up detail)
 *   conversation.chat.assistant-actions per-turn CNY cost beside the token usage pill
 *
 * Both read the Host half's authenticated `/api/dsh-wallet.*` routes with the
 * page's own cookies; only `react` is required from the module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-wallet',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'dsh-deepseek-wallet';

    const zh = {
      'balance.label': '余额',
      'balance.tooltip': 'DeepSeek 账户余额，点击查看赠金与充值明细',
      'balance.total': '总余额',
      'balance.granted': '赠金余额',
      'balance.toppedUp': '充值余额',
      'balance.available': '账户可用',
      'balance.unavailable': '账户不可用',
      'balance.stale': '余额可能不是最新',
      'turn.tooltip':
        '本轮消耗 ¥{amount}（{price}）\n模型：{model}\n输入 {input} tokens（缓存命中 {hit}）\n输出 {output} tokens',
      'turn.peak': '高峰价',
      'turn.valley': '谷价',
      'turn.mixed': '峰谷混合价',
    };

    const en = {
      'balance.label': 'Balance',
      'balance.tooltip': 'DeepSeek account balance — click for granted and topped-up detail',
      'balance.total': 'Total',
      'balance.granted': 'Granted',
      'balance.toppedUp': 'Topped up',
      'balance.available': 'Account available',
      'balance.unavailable': 'Account unavailable',
      'balance.stale': 'May not be up to date',
      'turn.tooltip':
        'This turn cost ¥{amount} ({price})\nModel: {model}\nInput {input} tokens (cache hit {hit})\nOutput {output} tokens',
      'turn.peak': 'peak price',
      'turn.valley': 'off-peak price',
      'turn.mixed': 'mixed peak/off-peak',
    };

    /** Format a CNY amount tightly: small turn costs keep four decimals. */
    function formatMoney(amount) {
      if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
      const magnitude = Math.abs(amount);
      if (magnitude === 0) return '0.00';
      if (magnitude >= 1) return amount.toFixed(2);
      if (magnitude >= 0.01) return amount.toFixed(3);
      return amount.toFixed(4);
    }

    /** Currency symbol for an ISO code; unknown codes stay readable. */
    function symbolFor(currency) {
      if (currency === 'CNY' || currency === 'RMB') return '¥';
      if (currency === 'USD') return '$';
      return typeof currency === 'string' && currency !== '' ? `${currency} ` : '¥';
    }

    /** Compact token counts: 9338 → 9.3k. */
    function formatTokens(count) {
      if (typeof count !== 'number' || !Number.isFinite(count)) return '0';
      if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
      if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
      return String(Math.round(count));
    }

    function formatPercent(ratio) {
      if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return '0%';
      return `${Math.round(ratio * 100)}%`;
    }

    // --- shared balance store -------------------------------------------------
    // One fetch shared by every seat in the page; polling starts with the first
    // subscriber and stops with the last.
    const balanceStore = (() => {
      let state = { value: null, error: null, at: 0 };
      const listeners = new Set();
      let inflight = null;
      let timer = null;
      let focusBound = false;

      const emit = () => {
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
            // A broken subscriber must not starve the rest.
          }
        }
      };

      const refresh = () => {
        if (inflight !== null) return inflight;
        if (state.at !== 0 && Date.now() - state.at < 15_000) return Promise.resolve();
        inflight = (async () => {
          try {
            const response = await fetch('/api/dsh-wallet.balance', {
              headers: { accept: 'application/json' },
              credentials: 'same-origin',
            });
            if (!response.ok) throw new Error(`http-${response.status}`);
            const body = await response.json();
            if (body === null || typeof body !== 'object') throw new Error('empty');
            state = { value: body, error: null, at: Date.now() };
          } catch (error) {
            state = { ...state, error: String(error?.message ?? error), at: Date.now() };
          } finally {
            inflight = null;
            emit();
          }
        })();
        return inflight;
      };

      const onFocus = () => {
        refresh();
      };

      const startPolling = () => {
        if (typeof window === 'undefined') return;
        refresh();
        if (timer === null) timer = window.setInterval(() => refresh(), 60_000);
        if (!focusBound) {
          window.addEventListener('focus', onFocus);
          focusBound = true;
        }
      };

      const stopPolling = () => {
        if (typeof window === 'undefined') return;
        if (timer !== null) {
          window.clearInterval(timer);
          timer = null;
        }
        if (focusBound) {
          window.removeEventListener('focus', onFocus);
          focusBound = false;
        }
      };

      return {
        getSnapshot: () => state,
        refresh,
        subscribe(listener) {
          listeners.add(listener);
          if (listeners.size === 1) startPolling();
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0) stopPolling();
          };
        },
      };
    })();

    function useBalance() {
      const [snapshot, setSnapshot] = useState(() => balanceStore.getSnapshot());
      useEffect(() => {
        setSnapshot(balanceStore.getSnapshot());
        return balanceStore.subscribe(() => setSnapshot(balanceStore.getSnapshot()));
      }, []);
      return snapshot;
    }

    // --- balance chip ---------------------------------------------------------
    /** Translate through the injected seat; fall back to the key when absent. */
    function translator(props) {
      return typeof props.t === 'function' ? props.t : (key) => key;
    }

    function BalanceChip(props) {
      const t = translator(props);
      const snapshot = useBalance();
      const value = snapshot.value;
      const [hover, setHover] = useState(false);
      const [open, setOpen] = useState(false);
      const [anchor, setAnchor] = useState(null);
      const buttonRef = useRef(null);

      useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const node = buttonRef.current;
          if (node !== null && event.target instanceof Node && node.contains(event.target)) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('mousedown', onPointerDown);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      if (value === null) return null;

      const toggle = () => {
        if (open) {
          setOpen(false);
          return;
        }
        const node = buttonRef.current;
        if (node === null) return;
        const rect = node.getBoundingClientRect();
        const width = 224;
        const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
        setAnchor({ left, bottom: window.innerHeight - rect.top + 8 });
        setOpen(true);
      };

      const button = h(
        'button',
        {
          ref: buttonRef,
          type: 'button',
          title: t('balance.tooltip'),
          onClick: toggle,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            flexShrink: 0,
            height: '24px',
            padding: '0 8px',
            border: 'none',
            borderRadius: '6px',
            background: hover ? 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.14))' : 'transparent',
            color: 'var(--dsw-alias-label-secondary, #6b7280)',
            font: 'inherit',
            fontSize: '12px',
            lineHeight: '24px',
            whiteSpace: 'nowrap',
            cursor: 'pointer',
            transition: 'background 120ms ease',
          },
        },
        h('span', { style: { opacity: 0.75 } }, t('balance.label')),
        h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, `${symbolFor(value.currency)}${formatMoney(value.total)}`),
      );

      if (!open || anchor === null) return button;

      const row = (label, amount) =>
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: '16px',
              padding: '2px 0',
              fontSize: '12px',
              lineHeight: '18px',
            },
          },
          h('span', { style: { color: 'var(--dsw-alias-label-secondary, #6b7280)' } }, label),
          h(
            'span',
            { style: { color: 'var(--dsw-alias-label-primary, inherit)', fontVariantNumeric: 'tabular-nums' } },
            `${symbolFor(value.currency)}${formatMoney(amount)}`,
          ),
        );

      const popup = h(
        'div',
        {
          role: 'dialog',
          style: {
            position: 'fixed',
            left: `${anchor.left}px`,
            bottom: `${anchor.bottom}px`,
            width: '224px',
            padding: '8px 12px',
            boxSizing: 'border-box',
            borderRadius: '8px',
            border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.24))',
            background: 'var(--dsw-alias-bg-overlay, #ffffff)',
            boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
            color: 'var(--dsw-alias-label-primary, inherit)',
            zIndex: 100,
          },
        },
        row(t('balance.total'), value.total),
        row(t('balance.granted'), value.granted),
        row(t('balance.toppedUp'), value.toppedUp),
        h(
          'div',
          {
            style: {
              marginTop: '6px',
              paddingTop: '6px',
              borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.24))',
              fontSize: '11px',
              lineHeight: '16px',
              color: 'var(--dsw-alias-label-secondary, #6b7280)',
            },
          },
          value.stale === true
            ? t('balance.stale')
            : value.available === false
              ? t('balance.unavailable')
              : t('balance.available'),
        ),
      );

      return h(React.Fragment, null, button, popup);
    }

    // --- per-turn cost chip ---------------------------------------------------
    function TurnCostChip(props) {
      const { messageId, sessionId } = props;
      const t = translator(props);
      const [state, setState] = useState({ status: 'idle', value: null });

      useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '' || typeof messageId !== 'string') {
          setState({ status: 'idle', value: null });
          return undefined;
        }
        const controller = new AbortController();
        const query = `/api/dsh-wallet.turn?sessionId=${encodeURIComponent(sessionId)}&messageId=${encodeURIComponent(messageId)}`;
        setState({ status: 'loading', value: null });
        fetch(query, {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
          signal: controller.signal,
        })
          .then(async (response) => {
            if (!response.ok) throw new Error(`http-${response.status}`);
            return response.json();
          })
          .then((body) => {
            setState({ status: 'ready', value: body });
            // A finished turn just changed the balance: let the chip catch up.
            balanceStore.refresh();
          })
          .catch((error) => {
            if (error?.name === 'AbortError') return;
            setState({ status: 'error', value: null });
          });
        return () => controller.abort();
      }, [sessionId, messageId]);

      const value = state.value;
      if (value === null || typeof value.amount !== 'number') return null;

      const prompt = value.tokens?.input ?? 0;
      const cacheRead = value.tokens?.cacheRead ?? 0;
      const title = t('turn.tooltip', {
        amount: formatMoney(value.amount),
        price:
          value.allPeak === true
            ? t('turn.peak')
            : value.peak === false
              ? t('turn.valley')
              : t('turn.mixed'),
        model: (value.models ?? []).join(', ') || 'deepseek-flash',
        input: formatTokens(prompt + cacheRead + (value.tokens?.cacheWrite ?? 0)),
        hit: formatPercent(value.cacheHitRate),
        output: formatTokens(value.tokens?.output ?? 0),
      });

      return h(
        'span',
        {
          title,
          style: {
            flexShrink: 0,
            padding: '0 2px',
            fontSize: '12px',
            lineHeight: '20px',
            whiteSpace: 'nowrap',
            color: 'var(--dsw-alias-label-secondary, #6b7280)',
            fontVariantNumeric: 'tabular-nums',
            cursor: 'default',
          },
        },
        `¥${formatMoney(value.amount)}`,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'dsh-deepseek-wallet: dictionaries',
        );
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: 'deepseek-balance',
              order: 5,
              locale: NS,
            },
            BalanceChip,
          ),
        );
        ctx.slots.inject('conversation.chat.assistant-actions', () =>
          ctx.slots.register(
            {
              name: 'conversation.chat.assistant-actions',
              id: 'deepseek-turn-cost',
              order: 20,
              locale: NS,
              inject: (sessionId) => ({ sessionId }),
            },
            TurnCostChip,
          ),
        );
      },
    };
  },
});
