import { App } from "./App";
import "./styles.css";

/**
 * Client Mode entry. The renderer shell (`src/renderer/src/App.tsx`) imports
 * this module as `ClientApp` and mounts it inside its own chrome — this
 * component must NOT mount itself or own the document root.
 */
export default function ClientApp() {
  return <App />;
}
