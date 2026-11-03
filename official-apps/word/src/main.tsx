import "@everyos/office-core/styles.css";
import "@everyos/app-ui/styles.css";
import { boot } from "@everyos/app-ui";
import { WordApp } from "./word-app.tsx";
import { installDocumentDigest } from "./document-digest.ts";
installDocumentDigest();
void boot(WordApp);
