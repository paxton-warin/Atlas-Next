import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
const Screen = lazy(() =>
  location.pathname === "/popout" ? import("./Popout") : import("./App"),
);
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={<div role="status">Loading Atlas…</div>}>
      <Screen />
    </Suspense>
  </React.StrictMode>,
);
