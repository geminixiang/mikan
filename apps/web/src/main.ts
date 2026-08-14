/**
 * Web application entry: thin bootstrap over the shell library. Everything —
 * boot-manifest parsing, router wiring, feature mounting — lives in
 * @geminixiang/mikan-web-client; this file only finds the mount point.
 */
import { AppWebEntry } from "@geminixiang/mikan-web-client";

const el = document.getElementById("root");
if (el === null) throw new Error("web app: missing #root");
void new AppWebEntry(el).run();
