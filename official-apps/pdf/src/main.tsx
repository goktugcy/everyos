import "@everyos/app-ui/styles.css";
// pdf.js's page, text and form layers (loaded here: CSS of lazily loaded code is not injected).
import "pdfjs-dist/web/pdf_viewer.css";
import "./pdf.css";
import { boot } from "@everyos/app-ui";
import { PdfApp } from "./pdf-app.tsx";

void boot(PdfApp);
