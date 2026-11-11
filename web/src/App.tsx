import { lazy, Suspense, useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./pages/app/AppShell";
import { Signals } from "./pages/app/Signals";
import { NotFound } from "./pages/NotFound";
import { DataProvider } from "./components/DataProvider";
import { SignInSheet } from "./components/SignInSheet";
import { track } from "./api/events";

const Landing = lazy(() => import("./pages/Landing"));
const Instrument = lazy(() => import("./pages/app/Instrument"));
const Markets = lazy(() => import("./pages/app/Markets"));
const Proof = lazy(() => import("./pages/app/Proof"));
const Profile = lazy(() => import("./pages/app/Profile"));
const Account = lazy(() => import("./pages/app/Account"));
const Support = lazy(() => import("./pages/app/Support"));
const LinkDevice = lazy(() => import("./pages/app/Link"));
const Legal = lazy(() => import("./pages/legal/Legal"));

/** page_view on every route change (admin routes are never tracked). */
function RouteTracker() {
  const { pathname } = useLocation();
  useEffect(() => {
    if (!pathname.startsWith("/admin")) track("page_view");
  }, [pathname]);
  return null;
}
// Operator console: separate lazy chunk (JS + CSS), never in the main bundle.
const AdminApp = lazy(() => import("./admin"));

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
      <RouteTracker />
      <SignInSheet />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/terms" element={<Legal doc="terms" />} />
        <Route path="/privacy" element={<Legal doc="privacy" />} />
        <Route path="/risk" element={<Legal doc="risk" />} />
        <Route
          path="/app"
          element={
            <DataProvider>
              <AppShell />
            </DataProvider>
          }
        >
          <Route index element={<Signals />} />
          <Route path="i/:symbol" element={<Instrument />} />
          <Route path="markets" element={<Markets />} />
          <Route path="proof" element={<Proof />} />
          <Route path="profile" element={<Profile />} />
          <Route path="account" element={<Account />} />
          <Route path="support" element={<Support />} />
          <Route path="link" element={<LinkDevice />} />
          <Route path="*" element={<NotFound inApp />} />
        </Route>
        <Route path="/admin/*" element={<AdminApp />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
