// Admin portal entry. Lazy-loaded from App.tsx at /admin/* so none of this ships in the
// main bundle. Styles are imported here so they land in the admin chunk's CSS.
import { Suspense } from "react";
import { Link, Route, Routes } from "react-router-dom";
import "./admin.css";
import { AdminLayout } from "./Layout";
import { Login } from "./Login";
import Overview from "./pages/Overview";
import Users from "./pages/Users";
import UserDetail from "./pages/UserDetail";
import Engine from "./pages/Engine";
import ActivityFeed from "./pages/Activity";
import Support from "./pages/Support";
import Content from "./pages/Content";
import Compliance from "./pages/Compliance";
import AuditLog from "./pages/Audit";
import DevOutbox from "./pages/DevOutbox";
import { BrokerPage } from "./broker";
import { Empty, Loading } from "./ui";

function AdminNotFound() {
  return (
    <div className="adm-empty adm-empty--page">
      <p className="adm-empty__t serif">No such admin page.</p>
      <Link className="btn btn--sm" to="/admin">
        Back to overview
      </Link>
    </div>
  );
}

function BrokerRoute() {
  if (!BrokerPage)
    return (
      <div className="adm-card">
        <Empty title="Broker module isn't in this build.">The Zerodha Kite page (pages/Broker.tsx) hasn't been added yet.</Empty>
      </div>
    );
  return (
    <Suspense fallback={<Loading label="Loading broker console" />}>
      <BrokerPage />
    </Suspense>
  );
}

export default function AdminApp() {
  return (
    <div className="adm-root">
      <Routes>
        <Route path="login" element={<Login />} />
        <Route element={<AdminLayout />}>
          <Route index element={<Overview />} />
          <Route path="users" element={<Users />} />
          <Route path="users/:id" element={<UserDetail />} />
          <Route path="activity" element={<ActivityFeed />} />
          <Route path="engine" element={<Engine />} />
          <Route path="broker" element={<BrokerRoute />} />
          <Route path="support" element={<Support />} />
          <Route path="support/:id" element={<Support />} />
          <Route path="content" element={<Content />} />
          <Route path="compliance" element={<Compliance />} />
          <Route path="audit" element={<AuditLog />} />
          <Route path="dev-outbox" element={<DevOutbox />} />
          <Route path="*" element={<AdminNotFound />} />
        </Route>
      </Routes>
    </div>
  );
}
