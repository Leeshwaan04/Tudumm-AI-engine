#!/usr/bin/env python3
"""Generate shared/seed.json — the canonical SIMULATED demo dataset for Tudumm.

Both the web app and the Chrome extension read this file so every symbol shows
the same signal everywhere. Nothing here is real market data or advice.

Ledger hash chain (verifiable in-browser with Web Crypto):
  hash_i = sha256_hex( JSON.stringify([prevHash, id, issuedAt, symbol, direction,
                                       entry, stop, target, exit, closedAt, r]) )
  prevHash of the first entry = "0" * 64.
Numbers are emitted so Python json.dumps and JS JSON.stringify print them identically
(integral floats are converted to int; everything is rounded).
"""
import hashlib
import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

random.seed(20261110)
ROOT = Path(__file__).resolve().parent.parent


def num(x, dp):
    v = round(float(x), dp)
    return int(v) if v == int(v) else v


# fields: symbol, name, exchange, market, assetClass, currency, dp (decimals), price, prevClose, aliases
INSTRUMENTS = [
    ("NIFTY", "NIFTY 50", "NSE", "IN", "index", "INR", 2, 25962.40, 25884.10,
     ["NIFTY", "NIFTY50", "NIFTY 50", "NSE:NIFTY", "NSE:NIFTY50", "^NSEI", "NIFTY_50:INDEXNSE", "NIFTY 50:INDEXNSE"]),
    ("BANKNIFTY", "Nifty Bank", "NSE", "IN", "index", "INR", 2, 58412.85, 58690.30,
     ["BANKNIFTY", "NIFTY BANK", "NSE:BANKNIFTY", "^NSEBANK", "NIFTY_BANK:INDEXNSE"]),
    ("RELIANCE", "Reliance Industries", "NSE", "IN", "equity", "INR", 2, 1486.20, 1471.55,
     ["RELIANCE", "RELIANCE.NS", "NSE:RELIANCE", "RELIANCE:NSE", "BSE:RELIANCE"]),
    ("HDFCBANK", "HDFC Bank", "NSE", "IN", "equity", "INR", 2, 986.40, 991.10,
     ["HDFCBANK", "HDFCBANK.NS", "NSE:HDFCBANK", "HDFCBANK:NSE"]),
    ("TCS", "Tata Consultancy Services", "NSE", "IN", "equity", "INR", 2, 3108.70, 3152.90,
     ["TCS", "TCS.NS", "NSE:TCS", "TCS:NSE"]),
    ("INFY", "Infosys", "NSE", "IN", "equity", "INR", 2, 1552.30, 1548.00,
     ["INFY", "INFY.NS", "NSE:INFY", "INFY:NSE"]),
    ("ICICIBANK", "ICICI Bank", "NSE", "IN", "equity", "INR", 2, 1421.60, 1409.20,
     ["ICICIBANK", "ICICIBANK.NS", "NSE:ICICIBANK", "ICICIBANK:NSE"]),
    ("SBIN", "State Bank of India", "NSE", "IN", "equity", "INR", 2, 872.45, 866.90,
     ["SBIN", "SBIN.NS", "NSE:SBIN", "SBIN:NSE"]),
    ("SPY", "SPDR S&P 500 ETF", "NYSE Arca", "US", "etf", "USD", 2, 684.12, 681.40,
     ["SPY", "AMEX:SPY", "SPY:NYSEARCA", "NYSEARCA:SPY"]),
    ("NVDA", "NVIDIA", "NASDAQ", "US", "equity", "USD", 2, 192.84, 188.10,
     ["NVDA", "NASDAQ:NVDA", "NVDA:NASDAQ"]),
    ("AAPL", "Apple", "NASDAQ", "US", "equity", "USD", 2, 251.30, 250.85,
     ["AAPL", "NASDAQ:AAPL", "AAPL:NASDAQ"]),
    ("TSLA", "Tesla", "NASDAQ", "US", "equity", "USD", 2, 418.60, 431.20,
     ["TSLA", "NASDAQ:TSLA", "TSLA:NASDAQ"]),
    ("MSFT", "Microsoft", "NASDAQ", "US", "equity", "USD", 2, 512.40, 508.75,
     ["MSFT", "NASDAQ:MSFT", "MSFT:NASDAQ"]),
    ("ASML", "ASML Holding", "Euronext Amsterdam", "EU", "equity", "EUR", 2, 742.80, 739.10,
     ["ASML", "ASML.AS", "EURONEXT:ASML", "ASML:AMS"]),
    ("BTCUSDT", "Bitcoin", "Binance", "CRYPTO", "crypto", "USDT", 1, 104850.0, 102920.0,
     ["BTCUSDT", "BTC_USDT", "BTC-USD", "BTCUSD", "BINANCE:BTCUSDT", "BTC-USDT"]),
    ("ETHUSDT", "Ethereum", "Binance", "CRYPTO", "crypto", "USDT", 2, 3812.40, 3864.90,
     ["ETHUSDT", "ETH_USDT", "ETH-USD", "ETHUSD", "BINANCE:ETHUSDT", "ETH-USDT"]),
    ("SOLUSDT", "Solana", "Binance", "CRYPTO", "crypto", "USDT", 2, 182.60, 177.35,
     ["SOLUSDT", "SOL_USDT", "SOL-USD", "SOLUSD", "BINANCE:SOLUSDT", "SOL-USDT"]),
    ("EURUSD", "Euro / US Dollar", "FX (OTC)", "FX", "fx", "USD", 5, 1.16420, 1.16180,
     ["EURUSD", "EURUSD=X", "FX:EURUSD", "EUR-USD", "EURUSD:CUR", "OANDA:EURUSD"]),
    ("USDINR", "US Dollar / Indian Rupee", "FX (OTC)", "FX", "fx", "INR", 4, 88.6200, 88.5800,
     ["USDINR", "INR=X", "USDINR=X", "FX_IDC:USDINR", "USD-INR"]),
    ("USDJPY", "US Dollar / Japanese Yen", "FX (OTC)", "FX", "fx", "JPY", 3, 152.300, 152.880,
     ["USDJPY", "JPY=X", "USDJPY=X", "FX:USDJPY", "USD-JPY", "OANDA:USDJPY"]),
    ("XAUUSD", "Gold Spot", "OTC / COMEX", "CMDTY", "commodity", "USD", 2, 4018.50, 3996.20,
     ["XAUUSD", "GOLD", "GC=F", "OANDA:XAUUSD", "TVC:GOLD", "COMEX:GC1!"]),
    ("CL", "WTI Crude Oil", "NYMEX", "CMDTY", "commodity", "USD", 2, 61.84, 62.70,
     ["CL", "CL=F", "WTI", "NYMEX:CL1!", "USOIL", "TVC:USOIL", "CRUDEOIL"]),
]

# Live signals. layers: agreement with the call, -100..100 (null = not applicable).
# status: active | pending | t1_hit | sit_out | queued
SIGNALS = {
    "NIFTY": dict(direction="LONG", style="swing", timeframe="1H", strategy="OI-confirmed breakout", confidence=0.71,
                  entry=(25900, 25960), stop=25760, t1=26180, t2=26350, status="active", regime="trending-up", ago=38,
                  layers=dict(price=72, flow=55, derivatives=81, fundamentals=20, context=35),
                  thesis="Fresh put writing at 25,800 (+38% OI) while 26,000 call OI unwinds — option sellers are lifting the floor.",
                  invalidation="Hourly close below 25,760, beneath the put wall."),
    "BANKNIFTY": dict(status="sit_out", regime="range", ago=12,
                      layers=dict(price=-10, flow=5, derivatives=0, fundamentals=15, context=-20),
                      thesis="Range-bound between 58,100 and 58,900 with IV crush ahead of the RBI policy — no edge until the range breaks.",
                      invalidation=None),
    "RELIANCE": dict(direction="LONG", style="swing", timeframe="1D", strategy="Long build-up + base breakout", confidence=0.68,
                     entry=(1478, 1488), stop=1452, t1=1532, t2=1565, status="active", regime="trending-up", ago=96,
                     layers=dict(price=70, flow=62, derivatives=66, fundamentals=48, context=30),
                     thesis="Futures added 9% OI with price rising — a classic long build-up — as delivery volumes hit a 20-day high.",
                     invalidation="Daily close below 1,452."),
    "HDFCBANK": dict(direction="LONG", style="positional", timeframe="1D", strategy="Pullback to rising 50-DMA", confidence=0.63,
                     entry=(972, 978), stop=958, t1=1012, t2=1038, status="pending", regime="trending-up", ago=210,
                     layers=dict(price=58, flow=40, derivatives=35, fundamentals=74, context=22),
                     thesis="Deposit growth is strong and margins are stable; price is pulling back into a rising 50-day average where FIIs bought last time.",
                     invalidation="Daily close below 958."),
    "TCS": dict(direction="SHORT", style="swing", timeframe="1D", strategy="Short build-up below support", confidence=0.64,
                entry=(3105, 3125), stop=3168, t1=3040, t2=2985, status="active", regime="trending-down", ago=150,
                layers=dict(price=66, flow=50, derivatives=61, fundamentals=12, context=40),
                thesis="Broke 3,130 support on rising futures OI (short build-up) after cautious deal-pipeline commentary; US tech spending signals stay soft.",
                invalidation="Daily close back above 3,168."),
    "INFY": dict(status="sit_out", regime="high-vol", ago=45,
                 layers=dict(price=20, flow=-15, derivatives=10, fundamentals=30, context=-40),
                 thesis="Earnings in 2 days — event risk outweighs any edge. Tudumm does not trade binary events.",
                 invalidation=None),
    "ICICIBANK": dict(direction="LONG", style="swing", timeframe="1D", strategy="Trend continuation", confidence=0.70,
                      entry=(1388, 1396), stop=1370, t1=1420, t2=1452, status="t1_hit", regime="trending-up", ago=1440 * 3,
                      layers=dict(price=68, flow=60, derivatives=52, fundamentals=66, context=28),
                      thesis="Higher highs on rising delivery. Target 1 is done and the stop is trailed to entry — the rest rides risk-free.",
                      invalidation="Close below 1,392 (breakeven)."),
    "SBIN": dict(direction="LONG", style="intraday", timeframe="15m", strategy="Opening-range breakout", confidence=0.61,
                 entry=(874, 877), stop=866, t1=890, t2=898, status="queued", regime="trending-up", ago=0, revealAfterSec=25,
                 layers=dict(price=64, flow=70, derivatives=48, fundamentals=40, context=25),
                 thesis="Bids stacked 2.3x the asks at the top of the opening range, with the PSU bank index leading.",
                 invalidation="15-minute close below 866."),
    "SPY": dict(direction="LONG", style="swing", timeframe="1D", strategy="Dip-buy in uptrend", confidence=0.66,
                entry=(680, 684), stop=674.5, t1=693, t2=700, status="active", regime="trending-up", ago=300,
                layers=dict(price=64, flow=45, derivatives=58, fundamentals=30, context=42),
                thesis="Dealers are long gamma above 680, which dampens volatility and gets dips bought; breadth is improving.",
                invalidation="Daily close below 674.50."),
    "NVDA": dict(direction="LONG", style="positional", timeframe="1D", strategy="Earnings-drift continuation", confidence=0.69,
                 entry=(188, 192), stop=181.5, t1=205, t2=214, status="active", regime="trending-up", ago=520,
                 layers=dict(price=75, flow=68, derivatives=60, fundamentals=82, context=50),
                 thesis="Data-center revenue beat with a raised guide; call skew is bid and institutional blocks absorbed every dip this week.",
                 invalidation="Daily close below 181.50 (gap fill)."),
    "AAPL": dict(status="sit_out", regime="range", ago=75,
                 layers=dict(price=15, flow=10, derivatives=-5, fundamentals=40, context=0),
                 thesis="Low-volatility drift with no confluence — only 2 of 5 layers agree. Waiting.",
                 invalidation=None),
    "TSLA": dict(direction="SHORT", style="swing", timeframe="4H", strategy="Failed breakout reversal", confidence=0.62,
                 entry=(420, 426), stop=438, t1=402, t2=390, status="active", regime="high-vol", ago=180,
                 layers=dict(price=60, flow=55, derivatives=50, fundamentals=-20, context=35),
                 thesis="Rejected at 440 with heavy put buying and dark-pool selling; momentum is rolling over on the 4-hour chart.",
                 invalidation="4-hour close above 438."),
    "MSFT": dict(direction="LONG", style="investing", timeframe="1W", strategy="Quality compounder accumulation", confidence=0.72,
                 entry=(500, 515), stop=468, t1=560, t2=600, status="active", regime="trending-up", ago=1440 * 2,
                 layers=dict(price=55, flow=50, derivatives=30, fundamentals=88, context=45),
                 thesis="Azure growth is re-accelerating with 30%+ operating margins and steady buybacks; the weekly trend holds above the 40-week average.",
                 invalidation="Weekly close below 468."),
    "ASML": dict(direction="LONG", style="swing", timeframe="1D", strategy="Breakout retest", confidence=0.60,
                 entry=(728, 735), stop=712, t1=768, t2=790, status="pending", regime="trending-up", ago=400,
                 layers=dict(price=52, flow=40, derivatives=25, fundamentals=70, context=18),
                 thesis="Order backlog is stable; price is retesting the breakout level near EUR 730, where the volume profile shows heavy acceptance.",
                 invalidation="Daily close below EUR 712."),
    "BTCUSDT": dict(direction="LONG", style="swing", timeframe="4H", strategy="Funding reset + spot bid", confidence=0.67,
                    entry=(103800, 104600), stop=101400, t1=108500, t2=111000, status="active", regime="trending-up", ago=240,
                    layers=dict(price=66, flow=72, derivatives=70, fundamentals=None, context=40),
                    thesis="Perp funding reset to neutral while spot ETFs logged 3 straight days of inflows — leverage is flushed and real buyers are in.",
                    invalidation="4-hour close below 101,400."),
    "ETHUSDT": dict(direction="SHORT", style="intraday", timeframe="1H", strategy="Liquidity sweep fade", confidence=0.60,
                    entry=(3830, 3860), stop=3915, t1=3740, t2=3680, status="pending", regime="high-vol", ago=55,
                    layers=dict(price=55, flow=48, derivatives=62, fundamentals=None, context=20),
                    thesis="Open interest jumped 6% into resistance with funding running hot — late longs are crowded above 3,850.",
                    invalidation="1-hour close above 3,915."),
    "SOLUSDT": dict(direction="LONG", style="swing", timeframe="4H", strategy="Relative-strength breakout", confidence=0.64,
                    entry=(181, 184), stop=174, t1=196, t2=205, status="queued", regime="trending-up", ago=0, revealAfterSec=55,
                    layers=dict(price=70, flow=60, derivatives=55, fundamentals=None, context=38),
                    thesis="Outperforming BTC for 9 sessions and breaking a 3-week range on rising spot volume.",
                    invalidation="4-hour close below 174."),
    "EURUSD": dict(direction="LONG", style="swing", timeframe="1D", strategy="Rate-spread momentum", confidence=0.62,
                   entry=(1.1625, 1.1645), stop=1.1580, t1=1.1720, t2=1.1780, status="active", regime="trending-up", ago=360,
                   layers=dict(price=58, flow=None, derivatives=45, fundamentals=55, context=40),
                   thesis="The US-EU yield spread has narrowed for 3 weeks and CME euro futures positioning is shifting net long.",
                   invalidation="Daily close below 1.1580."),
    "USDINR": dict(status="sit_out", regime="range", ago=90,
                   layers=dict(price=5, flow=None, derivatives=10, fundamentals=20, context=-10),
                   thesis="RBI is actively capping volatility near 88.80 — a managed range offers no edge.",
                   invalidation=None),
    "USDJPY": dict(direction="SHORT", style="swing", timeframe="1D", strategy="Intervention-zone fade", confidence=0.59,
                   entry=(152.4, 152.9), stop=154.1, t1=150.2, t2=148.8, status="active", regime="high-vol", ago=600,
                   layers=dict(price=50, flow=None, derivatives=48, fundamentals=52, context=60),
                   thesis="Approaching levels where Japan's Ministry of Finance has intervened before, while BoJ hike odds keep rising.",
                   invalidation="Daily close above 154.10."),
    "XAUUSD": dict(direction="LONG", style="positional", timeframe="1D", strategy="Central-bank bid trend", confidence=0.70,
                   entry=(3985, 4010), stop=3920, t1=4120, t2=4200, status="active", regime="trending-up", ago=1440,
                   layers=dict(price=68, flow=40, derivatives=55, fundamentals=72, context=60),
                   thesis="Real yields are easing and central-bank buying is steady; COMEX open interest rises with price — trend money is adding.",
                   invalidation="Daily close below 3,920."),
    "CL": dict(direction="SHORT", style="swing", timeframe="1D", strategy="Supply-glut breakdown", confidence=0.61,
               entry=(61.9, 62.6), stop=64.1, t1=59.4, t2=57.8, status="active", regime="trending-down", ago=480,
               layers=dict(price=60, flow=42, derivatives=55, fundamentals=58, context=30),
               thesis="OPEC+ output additions with inventories building 3 weeks in a row; the futures curve's backwardation is flattening.",
               invalidation="Daily close above 64.10."),
}

STRATEGIES = {
    "intraday": ["Opening-range breakout", "VWAP reclaim", "Liquidity sweep fade", "Order-book imbalance push"],
    "swing": ["OI-confirmed breakout", "Long build-up + base breakout", "Short build-up below support", "Trend continuation",
              "Failed breakout reversal", "Dip-buy in uptrend", "Funding reset + spot bid", "Breakout retest"],
    "positional": ["Pullback to rising 50-DMA", "Earnings-drift continuation", "Central-bank bid trend", "Sector rotation leader"],
    "investing": ["Quality compounder accumulation", "Deep-value re-rating", "Dividend compounder"],
}
STYLE_W = [("intraday", 0.30), ("swing", 0.45), ("positional", 0.17), ("investing", 0.08)]


def pick_style():
    r, acc = random.random(), 0.0
    for s, w in STYLE_W:
        acc += w
        if r <= acc:
            return s
    return "swing"


def build_instruments():
    out = []
    for sym, name, exch, mkt, ac, ccy, dp, price, prev, aliases in INSTRUMENTS:
        s = SIGNALS[sym]
        inst = dict(symbol=sym, name=name, exchange=exch, market=mkt, assetClass=ac, currency=ccy, decimals=dp,
                    price=num(price, dp), prevClose=num(prev, dp), aliases=aliases)
        sig = dict(id=f"SIG-{sym}-{random.randint(1000, 9999)}", symbol=sym, status=s["status"], regime=s["regime"],
                   issuedMinutesAgo=s["ago"], layers=s["layers"], thesis=s["thesis"], invalidation=s.get("invalidation"))
        if s["status"] != "sit_out":
            lo, hi = s["entry"]
            mid = (lo + hi) / 2
            risk = abs(mid - s["stop"])
            sig.update(direction=s["direction"], style=s["style"], timeframe=s["timeframe"], strategy=s["strategy"],
                       confidence=s["confidence"], entryLow=num(lo, dp), entryHigh=num(hi, dp), stop=num(s["stop"], dp),
                       target1=num(s["t1"], dp), target2=num(s["t2"], dp),
                       rr1=num(abs(s["t1"] - mid) / risk, 2), rr2=num(abs(s["t2"] - mid) / risk, 2))
            if "revealAfterSec" in s:
                sig["revealAfterSec"] = s["revealAfterSec"]
        else:
            sig.update(direction=None, confidence=None)
        inst["signal"] = sig
        out.append(inst)
    return out


def build_ledger(instruments, n=320):
    start = datetime(2025, 1, 6, 9, 15, tzinfo=timezone.utc)
    end = datetime(2026, 11, 7, 16, 0, tzinfo=timezone.utc)
    span = (end - start).total_seconds()
    times = sorted(start + timedelta(seconds=random.random() * span) for _ in range(n))
    hold = {"intraday": (0.05, 0.3), "swing": (1, 9), "positional": (6, 30), "investing": (25, 120)}
    rows, prev = [], "0" * 64
    for i, t in enumerate(times):
        inst = random.choice(instruments)
        dp, base = inst["decimals"], inst["price"]
        style = pick_style()
        strat = random.choice(STRATEGIES[style])
        direction = "LONG" if random.random() < 0.58 else "SHORT"
        # entry drifts back in time a bit so older calls sit at older-looking prices
        age_frac = (end - t).total_seconds() / span
        entry = base * (1 - 0.18 * age_frac + random.uniform(-0.06, 0.06))
        risk_pct = {"intraday": 0.006, "swing": 0.018, "positional": 0.035, "investing": 0.07}[style] * random.uniform(0.7, 1.3)
        risk = entry * risk_pct
        rr_target = round(random.uniform(1.4, 2.6), 2)
        sign = 1 if direction == "LONG" else -1
        stop = entry - sign * risk
        target = entry + sign * risk * rr_target
        u = random.random()
        if u < 0.36:
            outcome, r = "target", rr_target * random.uniform(0.92, 1.0)
        elif u < 0.50:
            outcome, r = "trailed", random.uniform(0.25, 1.2)
        elif u < 0.57:
            outcome, r = "expired", random.uniform(-0.35, 0.3)
        else:
            outcome, r = "stopped", -random.uniform(0.95, 1.06)
        r = round(r, 2)
        if r == 0:
            r = 0.01
        exit_px = entry + sign * risk * r
        lo, hi = hold[style]
        closed = t + timedelta(days=random.uniform(lo, hi))
        if closed > end:
            closed = end
        row = dict(id=f"T{str(i + 1).zfill(5)}", issuedAt=t.strftime("%Y-%m-%dT%H:%M:%SZ"), symbol=inst["symbol"],
                   market=inst["market"], style=style, strategy=strat, direction=direction,
                   entry=num(entry, dp), stop=num(stop, dp), target=num(target, dp), exit=num(exit_px, dp),
                   closedAt=closed.strftime("%Y-%m-%dT%H:%M:%SZ"), outcome=outcome, r=num(r, 2), prevHash=prev)
        canon = json.dumps([prev, row["id"], row["issuedAt"], row["symbol"], row["direction"], row["entry"], row["stop"],
                            row["target"], row["exit"], row["closedAt"], row["r"]], separators=(",", ":"), ensure_ascii=False)
        row["hash"] = hashlib.sha256(canon.encode("utf-8")).hexdigest()
        prev = row["hash"]
        rows.append(row)
    return rows


def main():
    instruments = build_instruments()
    ledger = build_ledger(instruments)
    wins = [x["r"] for x in ledger if x["r"] > 0]
    losses = [x["r"] for x in ledger if x["r"] <= 0]
    seed = dict(
        meta=dict(product="Tudumm", version=1, simulated=True,
                  note="SIMULATED demo data for product prototyping. Not real market data. Not investment advice.",
                  generatedFor="2026-11-10", ledgerHash="sha256(JSON.stringify([prevHash,id,issuedAt,symbol,direction,entry,stop,target,exit,closedAt,r]))",
                  ledgerGenesisPrevHash="0" * 64),
        markets=[dict(id="IN", label="India", flag="IN"), dict(id="US", label="United States", flag="US"),
                 dict(id="EU", label="Europe", flag="EU"), dict(id="CRYPTO", label="Crypto", flag="CRYPTO"),
                 dict(id="FX", label="Forex", flag="FX"), dict(id="CMDTY", label="Commodities", flag="CMDTY")],
        layers=[dict(id="price", label="Price & Structure"), dict(id="flow", label="Order Flow"),
                dict(id="derivatives", label="Derivatives"), dict(id="fundamentals", label="Fundamentals"),
                dict(id="context", label="Context & Sentiment")],
        instruments=instruments,
        ledger=ledger,
    )
    for p in [ROOT / "shared" / "seed.json"]:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(seed, indent=1, ensure_ascii=False))
    print(f"instruments={len(instruments)} ledger={len(ledger)} winRate={len(wins)/len(ledger):.3f} "
          f"avgWin={sum(wins)/len(wins):.2f} avgLoss={sum(losses)/len(losses):.2f} "
          f"expectancy={sum(x['r'] for x in ledger)/len(ledger):.3f} "
          f"PF={sum(wins)/abs(sum(losses)):.2f} lastHash={ledger[-1]['hash'][:12]}")


if __name__ == "__main__":
    main()
