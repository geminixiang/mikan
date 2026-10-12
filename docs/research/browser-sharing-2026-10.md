# Sharing the sandbox browser with the user (2026-10)

Question: how can a person see and operate the browser that `jev_browser` drives, through mikan's existing web server, and is a full remote desktop worth its cost?

Sources: the sandbox image (`deploy/docker/mikan-sandbox.Dockerfile`), `src/harness/tools/jev-browser.ts`, `agent-browser --help` (0.38.1), vendor docs read on 2026-10-11, and a POC on 2026-10-11 on a local colima Docker VM (arm64). POC files are in `.workspace/browser-view/`.

## How the browser runs today

| Fact                                                                                                  | Source                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `jev_browser` runs `agent-browser --session mikan-jb-<uuid> … --json` inside the office container     | `jev-browser.ts`                                                                                                                        |
| Chromium runs headless with a fresh profile per session; no cookies or profile persist                | `~/.agent-browser/` in 56 production containers held only `.pid`, `.sock`, `.version` files; `~/.config/chromium/` only `Crash Reports` |
| A replaced container therefore loses no login state, and a new thread never has any                   | same                                                                                                                                    |
| agent-browser binds its stream, dashboard, and Chrome debugging ports to `127.0.0.1` in the container | `/proc/net/tcp` in the POC container                                                                                                    |

## Two ways to show the browser

|                    | CDP screencast                                                                                              | Remote desktop (VNC)                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Mechanism          | agent-browser `stream`: JPEG frames from `Page.startScreencast`, `input_mouse` / `input_keyboard` JSON back | Xvfb virtual display, headed Chromium, x11vnc, websockify, noVNC in the user's browser                  |
| What the user sees | the active page only                                                                                        | the whole display: browser UI, other windows, a terminal                                                |
| Image change       | none                                                                                                        | +77 MB (`xvfb x11vnc novnc websockify openbox xterm`, apt lists removed)                                |
| jev_browser change | none                                                                                                        | none: `DISPLAY=:99` and `AGENT_BROWSER_HEADED=1` in the container environment make every session headed |

Both reach the container the same way: one WebSocket per viewer, which the host tunnels over `<engine> exec -i <container> node -e <tcp bridge>` to a `127.0.0.1` port inside the container. No container port is published, so it works on Docker, Podman, and nerdctl and fits behind mikan's web server.

## Measurements

Same container image, same page (en.wikipedia.org/wiki/Taiwan), one tab, host proxy on one machine, viewer driven by a browser on the same network.

| Metric                                                 | CDP screencast | VNC      |
| ------------------------------------------------------ | -------------- | -------- |
| Remote login on a test form (click, type, Enter)       | works          | works    |
| First frame after opening the view                     | 288 ms         | 2,062 ms |
| Key press to screen change, median of 5                | 55 ms          | 69 ms    |
| Bytes until logged in                                  | 233 KB         | 318 KB   |
| Continuous scroll, bandwidth                           | 711 KB/s       | 807 KB/s |
| Continuous scroll, container CPU (one core)            | 11%            | 23%      |
| Idle bandwidth                                         | 0              | 0        |
| Container memory (PSS), desktop stack idle, no browser | 1 MB           | 57 MB    |
| Container memory (PSS), browser open, fresh containers | 395 MB         | 504 MB   |
| Container CPU idle with the browser open, 30 s         | 1.9%           | 1.9%     |

An earlier reading of 1.1 GB for headed Chromium came from a session that had been used for several pages, with the password manager prompt open, and a process classification that attributed child processes by ancestry; the fresh side-by-side containers above are the comparable numbers.

## What the screencast cannot show

| Item                                               | Status                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Chrome DevTools                                    | available: headless Chrome serves `/devtools/inspector.html` on its debugging port         |
| `chrome://settings`, `chrome://extensions`         | render in headless Chrome                                                                  |
| Tab list                                           | sent by the stream (`type: "tabs"`); switching needs `agent-browser tab`                   |
| Address bar, back, tab strip                       | absent; would be mikan UI calling agent-browser                                            |
| Native `<select>` popup, context menu              | drawn outside the page; Browserbase reported the `<select>` gap and fixed it on 2025-04-25 |
| Permission and save-password bubbles, file chooser | absent                                                                                     |
| CJK input method composition                       | keys are sent one by one; a text box sending whole strings would be needed                 |

## What others ship

| Product                         | Kind                              | Notes                                                                                            |
| ------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| Browserbase Live View           | page view, interactive iframe     | agent on CDP; `debuggerFullscreenUrl`; per-tab URLs                                              |
| Steel Session Viewer            | page view                         | `interactive=true/false`; the URL is a secret                                                    |
| Browserless Hybrid Automation   | page view                         | built for handing login and 2FA to a person                                                      |
| Hyperbrowser Live View          | page view                         | token in the URL expires after 12 hours                                                          |
| Kernel (`kernel/kernel-images`) | headful Chromium + desktop stream | WebRTC adapted from Neko (needs UDP 56000–56100 or ICE servers) or noVNC; automation on CDP 9222 |
| Anthropic computer-use demo     | Xvfb + noVNC desktop              | single-session reference, not production                                                         |
| E2B Desktop                     | desktop stream                    | `view_only` option; one stream at a time                                                         |
| Neko                            | shared browser over WebRTC        | multi-user; no agent built in                                                                    |

Common practice: the view URL is a credential, short-lived, issued per person, with view-only and interactive modes, and the agent pauses while a person operates.

WebRTC is smoother than noVNC but needs UDP ports or a TURN server; noVNC is the option that fits through mikan's single HTTP port.

## Wayland desktop (Sway + wayvnc)

Debian trixie packages `sway` 1.10, `wayvnc` 0.9.1, and `foot`; Hyprland is not packaged. The POC image adds those three packages and runs Sway headless with the pixman renderer (`WLR_BACKENDS=headless`, `WLR_RENDERER=pixman`), which needs no GPU. wayvnc serves WebSocket itself (`--websocket`), so noVNC connects without websockify. Chromium draws on Wayland with `AGENT_BROWSER_ARGS=--ozone-platform=wayland` and `AGENT_BROWSER_HEADED=1`; `jev_browser` needs no code change.

| Metric                                                       | Wayland (Sway + wayvnc)                     | X11 (Xvfb + openbox + x11vnc + websockify) | No desktop |
| ------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------ | ---------- |
| Image growth                                                 | +3 MB                                       | +77 MB                                     | 0          |
| Container memory (PSS), browser open                         | 416 MB                                      | 455 MB                                     | 323 MB     |
| Desktop processes                                            | Sway 18 MB, wayvnc 29 MB                    | about 57 MB                                | —          |
| First frame in noVNC                                         | 290 ms                                      | 2,685 ms                                   | —          |
| Key press to screen change in a terminal, median / p90 of 10 | 58 / 67 ms                                  | 77 / 97 ms                                 | —          |
| Frame updates delivered through the exec tunnel, 60 fps page | 60 fps with `--max-fps=60` (default cap 30) | about 40 fps                               | —          |
| Container CPU idle with the browser open                     | 1.5%                                        | 1.1%                                       | 0.3%       |

Chromium rendered the animation at 60 fps in both desktops. Two settings mattered to the person using it: wayvnc's default 30 fps cap, and `--render-cursor`, which draws the pointer into the framebuffer so every pointer move waits for a round trip; without it noVNC draws the pointer locally.

The tiling layout of Sway resembles Hyprland-based desktops such as Omarchy. Remote access to those uses wayvnc on the running Hyprland session; no maintained container image for Hyprland with software rendering was found.

VNC sends changed pixels, so motion-heavy content costs more bandwidth than a video stream. Newer browser desktops move to video: KasmVNC (its own web client, WebCodecs H.264/H.265/AV1, not compatible with standard VNC viewers) and Selkies 2.0 (released 2026-09, H.264 or JPEG over one WebSocket port by default).

## Candidate: an optional desktop per office

Default offices stay as today (headless, no desktop). An office with the desktop enabled starts a headless Wayland compositor and wayvnc with the container, `jev_browser` sessions appear on the display, and a person opens noVNC through a portal link bound to them. With the Wayland desktop the cost in the POC is +3 MB image and about +90 MB per running office with a browser open.

Open decisions:

| Decision        | Options                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image           | decided 2026-10-11: one image ships `sway`, `wayvnc`, and `foot` (+3 MB) and starts the desktop only in offices that enable it, so enabling it needs no container replacement and releases build one image                                                                                                                                                                                                                                                                      |
| Switch          | decided 2026-10-11: no switch; the desktop starts when a person first asks for a link and stops with the container's idle stop                                                                                                                                                                                                                                                                                                                                                  |
| Who gets a link | decided 2026-10-11: like `/session`, any member of the conversation gets a link for themselves, sent privately and bound to that person, the office, and a TTL. The desktop is the office's Sandbox runtime, so Office visibility, which governs only what other offices may read, does not apply; other offices never get a link                                                                                                                                               |
| Handoff         | decided 2026-10-11: browser control ownership modeled on ego-browser. The agent owns the browser by default and a person may watch; a person who takes control stops `jev_browser`, which reports it and does not retry; the agent may hand off (explain the step and post the link, then end its round) and resumes only after the person hands back; tabs a person opened are never closed by the agent. Ownership covers the browser only, not other commands in the sandbox |
| Mobile          | decided 2026-10-11: later. On a phone, noVNC with `resize=remote` makes wayvnc resize the headless output to the phone (390x760 in the POC), and Sway's tabbed layout shows one window at a time; tapping works but the soft keyboard did not open. Community options to revisit: noVNC's keyboard button and gestures, Apache Guacamole (works with standard VNC; adds `guacd` and a Java web app)                                                                             |
