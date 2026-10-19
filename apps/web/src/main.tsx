import "@fontsource-variable/inter";
import "./styles/globals.css";
import { i18nReady } from "./app/i18n.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/app.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("Root element missing");

// The first screen waits for its language (English is bundled; others are a small download).
void i18nReady.finally(() =>
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
