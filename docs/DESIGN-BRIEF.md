# Tudumm — Design Brief (design system + product rules)

## Product
Tudumm reads every layer of a market (price and structure, order flow, derivatives, fundamentals, context and sentiment) and turns it into clear trade setups with defined risk. Each setup gives the direction, entry zone, stop, T1/T2, R:R, a confidence score, a plain-language "why," and the condition that cancels it. Every call goes on a public, hash-chained ledger. Audience: sophisticated traders and investors worldwide (Indian F&O, US equities and options, crypto, FX, commodities, long-term investors) who distrust "90% accuracy" tip channels.

## Non-negotiables
1. **Honesty is the brand.** Never write "guaranteed," "accuracy" or "profits only." Use "confidence," "probability," "edge" and "expectancy." Microcopy: "Probability, not promise." Live engine v0 signals are rule-based and **uncalibrated**, so they must be labelled that way.
2. **Label data honestly.**
   - Demo mode keeps a `DEMO DATA` badge.
   - Live mode shows a freshness badge on every price: `REAL-TIME · BINANCE`, `DELAYED 15M · CBOE`, `END OF DAY · NSE`, `DAILY REF · ECB`.
   - Proxies are labelled: PAXG for gold, the USO ETF for WTI, the ASML NASDAQ ADR.
   - Footer disclaimer on every page: "Tudumm is in beta. Signals are probabilistic and not investment advice. Trading involves risk of loss."
3. **No dead controls.** Every control works, or it's hidden or explained from `GET /api/v1/config` capabilities. Never show an empty widget; show an honest N/A state with the reason.
4. **"Sitting out" is a first-class state**, never hidden.
5. **Long and short never rely on color alone.** Always use ▲/▼ plus LONG/SHORT.
6. `prefers-reduced-motion` disables the sweeps, count-ups and tick flashes, and shows final values immediately.

## Aesthetic: "Editorial Terminal: The Reveal"
*Tudumm* is the drum hit at a reveal (ta-DUMM). The look is a precision instrument that speaks like a seasoned analyst:
- **Surfaces and data:** ink-black surfaces, hairline 1px rules, and dense but calm data, with every number in mono and tabular.
- **Type pairing:** headlines and the analyst "why" note in Instrument Serif (italic for emphasis). Serif prose next to mono numbers is the signature.
- **Accent:** one saffron "spotlight" color, used sparingly for the brand, focus, confidence and the reveal sweep. Long and short use mint and coral.
- **What to avoid:** glassmorphism, purple gradients, rounded fintech bubbles, stock photos, neon.
- **Shape and depth:** 8–10px radius max. Depth comes from stepping surfaces, not shadows.

Signature components that already exist in `web/src/components`:
- **SignalCard**, with a reveal animation: a two-beat pulse, a saffron sweep, and the confidence counting up.
- **TradeMap:** a horizontal ladder showing SL, the entry band, T1 and T2, with a live price needle and distance labels in R.
- **ConfluenceMeter:** five segmented layer bars, hatched when N/A.
- **StatusPill** and **DirectionPill.**
- **LivePrice:** the tick flash.
- **Logo:** the "two beats" mark (a small saffron dot, then a larger one set higher) next to a lowercase `tudumm` wordmark in Instrument Serif.

## Tokens (`web/src/styles/tokens.css` — reuse, don't redefine)
```
--bg #0A0B0D  --bg-raise #0F1114  --surface #13161B  --surface-2 #191D24  --surface-3 #20252E
--line #232833  --line-strong #323946  --text #EEEAE0  --text-2 #A9A69A  --text-3 #807E75
--brand #F5B841  --brand-ink #1A1305  --brand-dim rgba(245,184,65,.14)
--long #3DD68C  --long-dim rgba(61,214,140,.14)  --short #FF5C4D  --short-dim rgba(255,92,77,.14)
--neutral #8E9AAF  --info #7FA7FF  --radius-sm 6px  --radius 10px
--font-display "Instrument Serif"  --font-ui "Geist"  --font-mono "Geist Mono"
```
- Eyebrow labels: mono, 11px, uppercase, letter-spacing .12em, `--text-3`.
- Formatting: INR uses `en-IN` grouping (₹5,00,000); other currencies use `en-US`. Prefixes are ₹, $, € and ¥; USDT is a suffix.
- Responsive: 1440 desktop is primary, and 390 mobile must work: no horizontal page scroll, with tables scrolling inside their own containers.

## Security (frontend)
- No `dangerouslySetInnerHTML` or `innerHTML`. Render all user and admin text as text.
- Never put tokens in localStorage; the session is an HttpOnly cookie.
- CSP is strict (see `worker/src/lib/edge.ts`): `script-src 'self'` plus Cloudflare Insights and Turnstile; `connect-src 'self'` plus Binance market data, HTTPS and WSS.
