import "@fontsource-variable/inter";
import "./styles/globals.css";
import "./app/i18n.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/app.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("Root element missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
