import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App.js";
import { HarnessClient } from "./client.js";
import { HttpHarnessHostPort } from "./transport.js";

/** Fixed first-party application entry; Vite owns code arrival and caching. */
export class AppWebEntry {
  private root: Root | undefined;
  private readonly client = new HarnessClient(new HttpHarnessHostPort());

  constructor(private readonly element: HTMLElement) {}

  run(): void {
    this.root = createRoot(this.element);
    this.root.render(
      <StrictMode>
        <App client={this.client} />
      </StrictMode>,
    );
  }
}
