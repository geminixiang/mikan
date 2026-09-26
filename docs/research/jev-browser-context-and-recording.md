# `jev_browser` context and recording investigation

Date: 2026-09-22

## Question

What is the smallest robust design for mikan to preserve one browser context across navigation, actions, screenshots, HAR, and recording, especially when a site's video player requires a non-headless user agent?

## Evidence inspected

- mikan `src/harness/tools/jev-browser.ts`, tool assembly, runner disposal, sandbox `Executor`, and conversation/thread resource identity.
- Installed `agent-browser 0.27.0` and upstream tag [`v0.27.0`](https://github.com/vercel-labs/agent-browser/tree/v0.27.0), commit `c830d1b67dc18b754e305859f0ae587f858a1447`.
- Installed `agent-browser 0.38.1` and upstream tag [`v0.38.1`](https://github.com/vercel-labs/agent-browser/tree/v0.38.1), commit `aff6125c023b810ea3f2e5deec5379e9a4270bdc`.
- [`browser-use/jev-ultrafast`](https://github.com/browser-use/jev-ultrafast/tree/1231850a0bf1a0c0341fe408ef1668dbbfdfac46) and `browser-harness 0.1.13`.
- Real Slack → mikan → sandbox Chromium tests on a publisher site with a floating video player.

## Historical finding: what fails in agent-browser 0.27.0

> Status: resolved upstream by 0.38.1; see the verified update below.

In 0.27.0, `agent-browser record start` intentionally creates a fresh browser context and page. In upstream `cli/src/native/actions.rs`, `handle_recording_start`:

1. reads the current URL and cookies;
2. calls `Target.createBrowserContext`;
3. creates and attaches a new page;
4. copies cookies;
5. reapplies download behavior, HTTPS-ignore, and viewport;
6. navigates the new page;
7. starts recording that new CDP session.

It does **not** reapply the configured user agent. `BrowserManager` retains download path and HTTPS-ignore state, but does not retain the user agent or color scheme for later contexts. `set_user_agent` applies `Emulation.setUserAgentOverride` only to the currently active session.

This matches the real failure:

- before recording: Mac Chrome UA, video player occupied/floating/playing;
- immediately after `record start`: Linux HeadlessChrome UA, empty slot, no player;
- the WebM contains no player even though the pre-record screenshot does.

Changing command order does not solve it:

- UA/open before `record start`: recording context loses UA;
- `record start` before UA/open: the later open operates on a different context and the recording receives almost no frames;
- passing `--user-agent` on the `record start` invocation: 0.27.0 still creates the recording page with the default UA.

Long native waits during recording are also unsafe for mikan's current command model: a `wait 32000` call exceeded the 90-second executor timeout while recording continued in the daemon until a later explicit stop.

## What Jev Ultrafast does differently

`Agent.__enter__` / `__exit__` only provide deterministic cleanup. The context stability comes from stronger ownership:

- one `Browser` object;
- one owned target;
- one attached CDP session used for all observations and actions;
- continuous recording via `Page.startScreencast` on that exact session;
- `Page.stopScreencast` in cleanup.

See:

- [`jev_ultrafast/agent.py`](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/agent.py)
- [`jev_ultrafast/browser.py`](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/browser.py)
- [`scripts/record_flights.py`](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/scripts/record_flights.py)

The demo video is rendered later from CDP screencast frames and original timestamps. It does not invoke a second browser recording context.

## Historical options considered for 0.27.0

These options document the decision process before the upstream fix. With 0.38.1, mikan should use the native current-page recorder rather than implement B, C, or D itself.

### A. Keep mikan CLI-only and accept 0.27.0 recording semantics

Pros:

- zero new browser code;
- all behavior remains supported by `agent-browser`.

Cons:

- cannot reliably record sites that reject the recording context's default UA;
- state transfer is incomplete;
- timeout does not imply recording stopped;
- user prompts cannot repair the lifecycle.

Use only if mikan clearly reports this limitation and does not claim recording evidence it has not visually verified.

### B. Fix `agent-browser` upstream — preferred at the time, now delivered

The strongest fix is not to copy more state into another context. `agent-browser`
already contains an internal `handle_video_start` path that starts the same
recording task against `mgr.active_session_id()` without creating a new
BrowserContext or Page. It is used by the stream/dashboard protocol but is not
exposed by the documented CLI.

Upstream should expose this as an additive public mode such as:

```text
agent-browser record start <path> --current
```

or a similarly explicit command. This matches Jev Ultrafast's single-target CDP
screencast ownership and preserves UA, sessionStorage, JS state, active media,
refs, frames, and the exact visible page. Existing `record start` behavior can
remain for callers that intentionally want a clean recording context.

The existing fresh-context mode should also be fixed:

1. retain effective emulation/session settings in `BrowserManager` or daemon state;
2. update retained state when `set useragent`, media, headers, geo, or related supported settings change;
3. reapply those settings to the recording session before navigation;
4. define and test which storage state transfers to the recording context;
5. make recording stop/restore semantics explicit;
6. add a regression test showing the UA before and after `record start` is identical.

For the observed bug, the minimum fresh-context patch is to retain the effective
UA and call `Emulation.setUserAgentOverride` on `new_session_id` inside
`handle_recording_start`, before `Page.navigate`. A complete patch should audit
every session-scoped emulation option, not only UA. Even a complete transfer
cannot preserve arbitrary in-memory page state as reliably as current-target
recording.

Pros:

- fixes the behavior at its owner;
- keeps mikan thin;
- benefits all CLI users;
- preserves native snapshots, refs, frames, HAR, and recording.

Cons:

- requires an upstream release or a temporary fork;
- a mikan-maintained native fork would add multi-architecture build and release cost.

Historical recommendation: open an upstream issue/PR and pin the first released version containing the fix. Version 0.38.1 now contains the required behavior, so no fork or compatibility shim is needed.

### C. Public-CDP compatibility shim — acceptable temporary fallback

`agent-browser get cdp-url` is a public command. mikan could use it from inside the authorized sandbox, then use a narrowly scoped CDP helper to:

1. identify the page target created by `record start`;
2. attach to it;
3. call `Emulation.setUserAgentOverride` and other required emulation commands;
4. reload that same recording page;
5. leave snapshots/actions/recording owned by `agent-browser`.

This must run through the actor-resolved `Executor`; the host must never connect to the sandbox browser.

Pros:

- no private daemon socket/protocol;
- does not replace native snapshot/action/frame behavior;
- can unblock mikan before an upstream release.

Cons:

- mikan owns a small CDP client and target-selection logic;
- target identification must be race-safe (capture target IDs before and after start, not URL guessing);
- remote backends need runtime verification;
- it is a compatibility shim that should be version-gated and removed after upstream support.

Do not connect to `~/.agent-browser/<session>.sock`; that protocol is private. Do not locate Chrome by `/proc` or `DevToolsActivePort`; those are implementation details and backend-specific.

### D. Replace browser ownership with `browser-harness` / custom CDP

This reproduces Jev Ultrafast's strongest model: one target/session and direct screencast.

Pros:

- most deterministic context and recording behavior;
- direct control of cleanup and timestamps.

Cons:

- adds a Python/browser-harness runtime dependency or a substantial TypeScript CDP layer;
- duplicates responsibility already owned by `agent-browser`;
- risks divergence in snapshots, refs, frames, tabs, downloads, and future CLI behavior;
- conflicts with mikan's thin-wrapper objective.

Reject unless browser recording becomes a core product subsystem and upstream/native seams prove insufficient.

## mikan lifecycle changes that are useful independently

Even with an upstream recording fix, mikan should make browser lifetime an explicit runner resource:

- a runner-owned coordinator serializes `jev_browser` calls;
- named sessions remain native `agent-browser` sessions;
- launch/profile options are declarative and immutable after session creation;
- active recording/HAR state is tracked so timeout/error cleanup can issue bounded stop attempts;
- runner disposal closes sessions it owns;
- tool assembly exposes an async disposer and runner disposal awaits it;
- top-level and Slack threads remain separate runners, while all execution stays inside the same conversation sandbox.

This improves cleanup and controllability but does **not** by itself repair the recording UA bug.

Likely files:

- `src/harness/tools/jev-browser.ts`
- `src/harness/tools/index.ts`
- `src/harness/runner.ts`
- `src/test/jev-browser-tool.test.ts`

Changing these ownership boundaries should follow the mikan architecture update workflow.

## Update: agent-browser 0.38.1 resolves the recording-context defect

Upstream tag [`v0.38.1`](https://github.com/vercel-labs/agent-browser/tree/v0.38.1),
commit `aff6125c023b810ea3f2e5deec5379e9a4270bdc`, changed the public `record start`
semantics to record the current active page as-is. `handle_recording_start` now
uses `mgr.active_session_id()` directly: no BrowserContext, Page, or cold
navigation is created unless the caller explicitly supplies a URL.

The release also added daemon-owned `SessionSetup`, which retains and replays
UA, media, timezone, locale, geolocation, headers, offline mode, and init
scripts when a new page session genuinely must be created. Its ignored E2E test
`e2e_recording_default_records_active_page` verifies that record start preserves
one tab, the same URL, in-memory JS heap state, and viewport.

A disposable sandbox was upgraded to Node `24.21.0` and agent-browser `0.38.1`.
The real Slack → mikan → sandbox video-player regression verified:

- custom Mac Chrome UA remained unchanged after `record start`;
- `window.__recordMarker` remained present;
- `data-gc-slot-occupied` remained true;
- the player stayed `floating` at a `300 × 168.75` fixed rect;
- video remained `paused: false` and `currentTime` advanced;
- screenshot after record start visibly contained the player;
- WebM was 34.8 seconds, 348 frames at 10 fps, 1310 × 1002;
- independently extracted frames visibly contained the floating player;
- native `--contact-sheet` output was produced.

Named-session resource behavior did not materially change: two concurrent named
sessions still created two native daemon roots and two Chromium profile/process
trees with isolated page state. `close` removed its daemon asynchronously; the
session disappeared from `session list` within about one second. Mikan should
therefore keep runner serialization and avoid unnecessary named sessions.

The provisioning compatibility blocker has been addressed in the standard
sandbox Dockerfile: it now installs Node 24, Debian Chromium, ffmpeg, and pinned
`agent-browser 0.38.1`. A clean image build and a capability-constrained
container smoke test verified `agent-browser doctor`, custom-UA current-page
recording, contact-sheet output, ffprobe-readable video, and session cleanup.
The host-side mikan package can retain its existing Node `>=22.19.0` contract;
the Node 24 requirement belongs to the separate sandbox tool image.

## Recommended sequence

1. Publish and deploy the rebuilt managed sandbox image containing Node 24 and agent-browser 0.38.1.
2. Keep mikan's CLI integration; do not add a CDP compatibility shim or browser-harness dependency for this issue.
3. Update tool guidance/tests for current-page recording, `--fps`, cursor, and contact-sheet output.
4. Keep the independent mikan runner-owned cleanup/state work: active recording/HAR tracking, timeout cleanup, and runner disposal.
5. Never auto-upload a recording until duration and extracted frames prove it contains the requested target.
6. Validate with a short natural-language prompt, not diagnostic command choreography.

## Acceptance test

A real Slack prompt should be no more complex than:

> Check the video player on https://example.com, capture its floating behavior for 30 seconds, inspect the ad traffic, and send me the evidence.

Completion requires:

1. one named native browser session is used;
2. custom UA and viewport are effective after recording begins;
3. `data-gc-slot-occupied` is present;
4. screenshot visibly contains the player;
5. extracted WebM frames visibly contain loading and/or floating playback;
6. actual WebM duration is at least 30 seconds;
7. HAR distinguishes GAM, GPT, IMA, AdSense, and GTM;
8. screenshot, verified video, and HAR are attached to Slack;
9. timeout/error paths stop capture and leave no native session/process;
10. the agent does not require the user to provide CLI syntax, session names, selectors, paths, or UA strings.
