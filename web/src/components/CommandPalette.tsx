import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, CornerDownLeft, Search } from "lucide-react";
import { instruments, MARKET_SHORT } from "../engine/seed";
import type { Instrument } from "../engine/types";
import { isTrade } from "../engine/types";
import { useStatuses } from "../engine/live";
import { STATUS_LABEL } from "./signal";

interface Item {
  key: string;
  kind: "instrument" | "page";
  title: string;
  sub: string;
  to: string;
  inst?: Instrument;
  matched?: string;
}

const PAGES: Item[] = [
  { key: "p-signals", kind: "page", title: "Signals feed", sub: "All live calls and sit-outs", to: "/app" },
  { key: "p-markets", kind: "page", title: "Markets heatmap", sub: "Every instrument by market", to: "/app/markets" },
  { key: "p-proof", kind: "page", title: "Proof · track record", sub: "Ledger, stats and chain verification", to: "/app/proof" },
  { key: "p-profile", kind: "page", title: "Profile", sub: "Persona, markets, capital and risk", to: "/app/profile" },
  { key: "p-home", kind: "page", title: "Tudumm home", sub: "The landing page", to: "/" },
];

function rank(inst: Instrument, q: string): { score: number; matched?: string } {
  const sym = inst.symbol.toLowerCase();
  if (sym === q) return { score: 100 };
  if (sym.startsWith(q)) return { score: 80 };
  const alias = inst.aliases.find((a) => a.toLowerCase() === q);
  if (alias) return { score: 75, matched: alias };
  const aliasP = inst.aliases.find((a) => a.toLowerCase().includes(q));
  if (inst.name.toLowerCase().startsWith(q)) return { score: 60 };
  if (aliasP) return { score: 50, matched: aliasP };
  if (inst.name.toLowerCase().includes(q)) return { score: 40 };
  if (inst.exchange.toLowerCase().includes(q) || MARKET_SHORT[inst.market].toLowerCase().startsWith(q)) return { score: 20 };
  return { score: 0 };
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const navigate = useNavigate();
  const statuses = useStatuses();

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const query = q.trim().toLowerCase();
    const toItem = (inst: Instrument, matched?: string): Item => ({
      key: inst.symbol,
      kind: "instrument",
      title: inst.symbol,
      sub: `${inst.name} · ${inst.exchange}`,
      to: `/app/i/${inst.symbol}`,
      inst,
      matched,
    });
    if (!query) {
      const top = [...instruments]
        .filter((i) => isTrade(i.signal))
        .sort((a, b) => (isTrade(b.signal) ? b.signal.confidence : 0) - (isTrade(a.signal) ? a.signal.confidence : 0))
        .slice(0, 6)
        .map((i) => toItem(i));
      return [...top, ...PAGES];
    }
    const inst = instruments
      .map((i) => ({ i, r: rank(i, query) }))
      .filter((x) => x.r.score > 0)
      .sort((a, b) => b.r.score - a.r.score)
      .map((x) => toItem(x.i, x.r.matched));
    const pages = PAGES.filter((p) => p.title.toLowerCase().includes(query) || p.sub.toLowerCase().includes(query));
    return [...inst, ...pages];
  }, [q]);

  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, items.length - 1)));
  }, [items.length]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  const go = (it: Item | undefined) => {
    if (!it) return;
    onClose();
    navigate(it.to);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(items.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(items[sel]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  let lastKind = "";
  return (
    <div className="cmdk" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmdk__box" role="dialog" aria-modal="true" aria-label="Search instruments and pages">
        <div className="cmdk__bar">
          <Search size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            className="cmdk__input"
            placeholder="Search symbols, names or aliases (RELIANCE.NS, BTC-USD, GC=F)…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKey}
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={items[sel] ? `cmdk-${items[sel].key}` : undefined}
          />
          <kbd className="kbd">esc</kbd>
        </div>
        <ul className="cmdk__list" id="cmdk-list" role="listbox" ref={listRef}>
          {items.length === 0 && (
            <li className="cmdk__empty">
              No instrument matches “{q}”. The demo covers {instruments.length} instruments across India, US, Europe, crypto, FX
              and commodities.
            </li>
          )}
          {items.map((it, idx) => {
            const header =
              it.kind !== lastKind ? (
                <li key={`h-${it.kind}`} className="cmdk__group eyebrow" role="presentation">
                  {it.kind === "instrument" ? (q ? "Instruments" : "Top live signals") : "Go to"}
                </li>
              ) : null;
            lastKind = it.kind;
            const st = it.inst ? statuses[it.inst.symbol] : undefined;
            const s = it.inst?.signal;
            return [
              header,
              <li
                key={it.key}
                id={`cmdk-${it.key}`}
                data-idx={idx}
                role="option"
                aria-selected={idx === sel}
                className={`cmdk__item ${idx === sel ? "is-sel" : ""}`}
                onMouseEnter={() => setSel(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  go(it);
                }}
              >
                <span className={`cmdk__title ${it.kind === "instrument" ? "mono" : ""}`}>{it.title}</span>
                <span className="cmdk__sub">
                  {it.sub}
                  {it.matched && <span className="cmdk__alias mono"> · alias {it.matched}</span>}
                </span>
                <span className="cmdk__right">
                  {s && st && (
                    <span className="cmdk__sig mono">
                      {st === "sit_out" ? (
                        <span className="c-neutral">SITTING OUT</span>
                      ) : st === "queued" ? (
                        <span className="c-brand">{STATUS_LABEL.queued.toUpperCase()}</span>
                      ) : isTrade(s) ? (
                        <span className={s.direction === "LONG" ? "c-long" : "c-short"}>
                          {s.direction === "LONG" ? "▲" : "▼"} {s.direction} {Math.round(s.confidence * 100)}%
                        </span>
                      ) : null}
                    </span>
                  )}
                  {idx === sel ? <CornerDownLeft size={14} aria-hidden="true" /> : <ArrowRight size={14} aria-hidden="true" className="t3" />}
                </span>
              </li>,
            ];
          })}
        </ul>
        <div className="cmdk__foot mono">
          <span>
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> navigate
          </span>
          <span>
            <kbd className="kbd">↵</kbd> open
          </span>
          <span>
            <kbd className="kbd">⌘K</kbd> / <kbd className="kbd">Ctrl K</kbd> toggle
          </span>
        </div>
      </div>
    </div>
  );
}
