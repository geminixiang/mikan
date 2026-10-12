---
status: accepted
---

# People share the office's desktop with the agent

A Conversation office's Sandbox runtime is the agent's computer. mikan lets the members of the conversation see and operate it from a browser: a Wayland desktop in the office container, shown through noVNC behind mikan's web server, where the browser that `jev_browser` drives appears as an ordinary window.

## Context

`jev_browser` runs headless Chromium through agent-browser with a fresh profile per thread, so nobody can watch it, log it into a site, or solve a challenge for it, and no login state survives. The research in [`docs/research/browser-sharing-2026-10.md`](../research/browser-sharing-2026-10.md) compared a page-only CDP screencast with a full remote desktop and measured three prototypes:

|                              | Wayland (Sway + wayvnc)                                                   | X11 (Xvfb + x11vnc) | Page-only CDP screencast |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------- | ------------------------ |
| Shows                        | the whole desktop: browser UI, tabs, DevTools, a terminal, other programs | the whole desktop   | the active page only     |
| Image growth                 | +3 MB                                                                     | +77 MB              | 0                        |
| Memory with the browser open | +93 MB over headless                                                      | +132 MB             | 0                        |
| First frame                  | 290 ms                                                                    | 2,685 ms            | 288 ms                   |
| Key to screen, median        | 58 ms                                                                     | 77 ms               | 55 ms                    |
| Frame updates                | 60 fps                                                                    | about 40 fps        | on change                |

Hosted and open-source agent browsers split the same way: page views for handing a step to a person (Browserbase, Steel, Browserless, Hyperbrowser) and full desktops for sharing (Kernel, Anthropic's computer-use demo, E2B Desktop, Neko).

## Decision

- **Desktop.** The sandbox image ships `sway`, `wayvnc`, and `foot`. The desktop is not running by default; it starts in the office container when a member first asks for a link, and it stops when the container stops for idleness. Sway runs headless with the pixman renderer and needs no GPU; the image's `mikan-desktop` script starts it and is the only in-container contract. wayvnc serves WebSocket itself, at most 60 fps, and leaves the pointer to the client. While the desktop is up, `jev_browser` launches Chromium headed on Wayland (`AGENT_BROWSER_HEADED`, `--ozone-platform=wayland`); without the desktop it stays headless, because a headed launch fails when no compositor is running.
- **Access.** Like `/session`, a member of the conversation asks for a link and receives it privately; a shared conversation on a platform without private replies is told to ask in a direct message. The token is bound to that person and that office and expires. The desktop belongs to the office's Sandbox runtime, so Office visibility, which governs only what other offices may read, does not apply; a link never reaches another office's desktop.
- **Transport.** mikan's web server serves the noVNC client and forwards one WebSocket per viewer to wayvnc inside the container through `<engine> exec -i`, the same path as the pi-env connection. No container port is published. An open viewer counts as use of the container, so the container is not stopped while someone is watching.
- **Browser control.** Modeled on ego-browser: the agent owns the browser by default and a person may watch. A person who takes control stops `jev_browser`, which reports that the person has control and does not retry. The agent may hand control to the person, explaining the step and posting the link, and end its round; a page the agent opened headless is reopened on the desktop first, without its cookies. It resumes after the person hands control back, and control returns to the agent when the last viewer disconnects. The agent never closes a tab a person opened. Control covers the browser only, not other commands in the sandbox.
- **Mobile** is out of scope for now: a phone can view the desktop and tap, but the soft keyboard does not open.

## Consequences

- A thread whose browser started headless before the desktop came up keeps it until the browser restarts or the agent hands off, which reopens the page on the desktop without its cookies.
- The web server serves noVNC from `@novnc/novnc` (MPL-2.0, 0.6 MB, no dependencies).
- Every image is 3 MB larger; an office pays the desktop's memory only while its desktop runs.
- A member with a link can operate the whole sandbox, including credentials mounted from the Vault. Members could already make the agent do so; the link turns indirect control into direct control.
- Host and existing-container sandbox modes have no managed container to start the desktop in; the link command reports that.
- VNC sends changed pixels, so video-heavy pages cost more bandwidth than a video stream would. KasmVNC and Selkies stream video but replace wayvnc.
