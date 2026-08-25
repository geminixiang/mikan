import { AppWebEntry } from "@geminixiang/mikan-web-client";

const element = document.getElementById("root");
if (!element) throw new Error("Web Harness Client: missing #root");
new AppWebEntry(element).run();
