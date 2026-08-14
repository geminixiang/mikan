/**
 * AppWebEntry — the SPA boot kernel (DSH AppWebEntry pattern, simplified):
 * read `window.__MIKAN_BOOT__`, parse the manifest, and mount the app shell.
 * Everything else lives in App.tsx; this class only finds the DOM node and
 * hands the manifest to the shell.
 */
import { createRoot, type Root } from "react-dom/client";
import { StrictMode } from "react";
import { App } from "./App.js";
import { parseBootManifest } from "./manifest.js";

export class AppWebEntry {
  private root: Root | undefined;

  constructor(private readonly el: HTMLElement) {}

  run(): void {
    const manifest = parseBootManifest(window["__MIKAN_BOOT__"]);
    this.root = createRoot(this.el);
    this.root.render(
      <StrictMode>
        <App manifest={manifest} />
      </StrictMode>,
    );
  }
}
