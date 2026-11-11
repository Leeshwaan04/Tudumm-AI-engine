// Broker (Zerodha Kite) page registration. pages/Broker.tsx is owned by another agent and may not
// exist yet, so it's resolved through import.meta.glob: an absent file yields no loader (no build
// break, nav item hidden); once the file lands, Vite picks it up and code-splits it as its own chunk.
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

type Mod = { default?: ComponentType; Broker?: ComponentType };
const mods = import.meta.glob<Mod>("./pages/Broker.tsx");
const loader = mods["./pages/Broker.tsx"];

export const hasBroker = loader !== undefined;

export const BrokerPage: LazyExoticComponent<ComponentType> | null = loader
  ? lazy(async () => {
      const m = await loader();
      const C = m.default ?? m.Broker;
      if (!C) throw new Error("pages/Broker.tsx has no default export");
      return { default: C };
    })
  : null;
