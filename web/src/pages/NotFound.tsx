import { Link } from "react-router-dom";
import { Wordmark } from "../components/Logo";
import { useDocumentTitle } from "../components/hooks";

export function NotFound({ inApp = false }: { inApp?: boolean }) {
  useDocumentTitle("Not found · Tudumm");
  return (
    <div className={`nf ${inApp ? "nf--app" : ""}`}>
      {!inApp && <Wordmark height={30} />}
      <p className="eyebrow">404 · no such page</p>
      <h1 className="nf__title serif">
        Nothing to reveal <em>here.</em>
      </h1>
      <p className="t2">The page you asked for doesn’t exist in this prototype.</p>
      <div className="nf__act">
        <Link to="/app" className="btn btn--primary">
          Open the terminal
        </Link>
        <Link to="/" className="btn">
          Home
        </Link>
      </div>
    </div>
  );
}
