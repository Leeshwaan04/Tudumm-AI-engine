import { createContext, useContext } from "react";
import type { AdminMe } from "./types";

export interface AdminSession {
  me: AdminMe;
  appEnv: string | null;
  refreshMe: () => void;
}

export const AdminCtx = createContext<AdminSession | null>(null);

export function useAdmin(): AdminSession {
  const s = useContext(AdminCtx);
  if (!s) throw new Error("useAdmin outside AdminLayout");
  return s;
}
