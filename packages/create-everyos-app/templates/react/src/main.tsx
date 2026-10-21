import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Notes } from "./notes.tsx";
import { app } from "./everyos.ts";
import "./styles.css";

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <Notes />
  </StrictMode>,
);
await app.lifecycle.ready();
