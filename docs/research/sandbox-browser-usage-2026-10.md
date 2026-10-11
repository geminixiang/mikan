# Should offices share one browser?

Date: 2026-10-11. Question: every office sandbox carries Chromium and agent-browser; would one shared browser service be more efficient? Answered from one production deployment's session records (2026-05-19 to 2026-10-09, 302 offices, a 2-vCPU 8 GB VM) and a local measurement of the sandbox image.

## What one browser costs

Measured with `mikan-sandbox` (agent-browser 0.38.1, Chromium 154) under nerdctl:

| State                                                | Container memory |
| ---------------------------------------------------- | ---------------- |
| No browser started                                   | 0.5 MB           |
| One tab                                              | 242 MB           |
| Four tabs                                            | 367 MB           |
| A second agent-browser session in the same container | +230 MB          |

A cold start takes 6.7–7.1 s. The browser files are image layers, stored once on the host however many containers use them, so a container that never opens the browser costs nothing. Memory and start-up are per agent-browser session, which `jev_browser` keys to a thread, so moving every browser into one container would not reduce them; only sharing one Chromium process across offices would.

## How much production uses it

Browser calls are `jev_browser` tool calls plus `bash` calls whose command runs `agent-browser`, matched to their results:

| Measure                                                                                                    | Value                                                         |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Calls in the whole period                                                                                  | 621 (156 `jev_browser`, 465 `bash`)                           |
| Last 30 days                                                                                               | 236 calls from 24 offices and 76 threads; at most 63 in a day |
| Since 2026-10-01                                                                                           | 69 `jev_browser`, 1 `bash`                                    |
| Minutes with N browsers alive, assuming a browser lives until 15 idle minutes after its thread's last call | 0: 97.2%, 1: 2.4%, 2: 0.3%, 3: 0.04%                          |
| Most browsers alive at once                                                                                | 3 (about 1 GB of the VM's 8 GB)                               |

## Where the waste was

Failed browser calls, classified by their output:

| Period                   | Main failures                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05 to 2026-09       | agent-browser not found (158) and Chrome not found (86); outputs show agents running `apt-get install` and `npm install` for a browser inside their container |
| 2026-09-23 to 2026-09-30 | `jev_browser` reporting agent-browser unavailable (23), from containers created before the image shipped the browser                                          |
| Since 2026-10-04         | 5 failures in 44 calls, none about installation                                                                                                               |

Per-container browser installs were real while the image lacked a browser; shipping it in the image and replacing containers on image drift ended them.

## Decision

Keep one browser per thread inside the office sandbox. At this usage a shared browser would save little memory or start-up time, and it would cost:

- isolation: whoever holds a CDP connection controls every browser context in that Chromium, including other offices' cookies and logins (ADR 0016 treats the agent as untrusted), and agent-browser cannot scope it without a mikan-owned proxy;
- network policy: page traffic would leave from the browser service, not the office's network;
- licensing: the Browserless image is SSPL-1.0 or commercial.

Reconsider when several browsers are alive most of the time; the analysis above is the measure to repeat.
