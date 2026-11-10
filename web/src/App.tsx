import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { AppShell } from "./pages/app/AppShell";
import { Signals } from "./pages/app/Signals";
import { NotFound } from "./pages/NotFound";

const Landing = lazy(() => import("./pages/Landing"));
const Instrument = lazy(() => import("./pages/app/Instrument"));
const Markets = lazy(() => import("./pages/app/Markets"));
const Proof = lazy(() => import("./pages/app/Proof"));
const Profile = lazy(() => import("./pages/app/Profile"));

function Loading() {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="loading__beat" />
      <span className="loading__beat" />
      <span className="visually-hidden">Loading</span>
    </div>
  );
}

export function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/app" element={<AppShell />}>
          <Route index element={<Signals />} />
          <Route path="i/:symbol" element={<Instrument />} />
          <Route path="markets" element={<Markets />} />
          <Route path="proof" element={<Proof />} />
          <Route path="profile" element={<Profile />} />
          <Route path="*" element={<NotFound inApp />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
