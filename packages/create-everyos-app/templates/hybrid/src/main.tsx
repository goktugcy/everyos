import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Monitors } from "./monitors.tsx";
import { app } from "./everyos.ts";
import "./styles.css";

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <Monitors />
  </StrictMode>,
);
await app.lifecycle.ready();
