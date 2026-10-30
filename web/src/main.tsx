import "./profile-client";
import HubGate from "./HubGate";
import { AtlasEntryFrame } from "./AtlasEntryFrame";
import EntryLaunchLinkNotice from "./EntryLaunchLink";
import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./v21-tokens.css";
import "./atlas-v21.css";
import "./sidebar-responsive.css";
const Screen = lazy(() =>
  location.pathname === "/popout" ? import("./Popout") : import("./App"),
);
document.body.classList.add("atlas-v21");
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HubGate>
      <EntryLaunchLinkNotice />
      <Suspense fallback={<AtlasEntryFrame message="Opening your browser…" />}>
        <Screen />
      </Suspense>
    </HubGate>
  </React.StrictMode>,
);
