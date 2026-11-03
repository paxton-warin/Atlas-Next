import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./v21-tokens.css";
import "./hub-v21.css";
document.body.classList.add("hub-v21");
document.body.dataset.v21Theme = "forest";
document.body.dataset.v21Mode = "dark";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
