---
status: accepted
---

# mikan keeps its Slack app configured

Each mikan release carries the Slack app manifest it needs, and the daemon applies it to the Slack app at startup, so an upgrade that adds a slash command, scope, or event needs no manual change in Slack's app settings. `mikan onboard` can also create the app.

## Context

Until now an operator copied `deploy/examples/slack-app-manifest.json` into Slack's settings page by hand, and repeated that on every release that changed it; `/pi-desktop` does not exist in an app nobody edited. Live apps also drift: one test app differed from every repository manifest by scopes, events, and features added by hand.

Slack's App Manifest API was tested on a test app:

| Call                                           | Result                                                                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps.manifest.export` / `validate` / `update` | Update replaces the whole manifest in about 0.6 s. A new slash command reached the running daemon at once, without reinstalling.                                             |
| Adding a bot scope                             | `permissions_updated: true`; the installed bot token keeps working and gains the scope only after someone reinstalls the app.                                                |
| `tooling.tokens.rotate`                        | The configuration token lasts 12 hours. Rotation returns a new token and refresh token and revokes the previous access token, including one held by another process.         |
| `apps.manifest.create`, then export            | Returns the app ID, secrets, and install URL. Slack adds `agent_tasks_enabled: true` to the App Home of new apps and ignores the value sent; older apps never get the field. |
| `bots.info` with the bot token                 | Returns the app ID, so the operator does not enter it.                                                                                                                       |

A configuration token belongs to the person who created it and to one workspace, not to the app.

## Decision

- **The desired manifest is code.** `src/adapters/slack/app-config.ts` owns one manifest per release for a classic Slack app (mentions and DMs, not the Agents & AI apps surface). Slash commands come from the command manifest, and `deploy/examples/slack-app-manifest.json` is tested to equal it.
- **Operator customization lives in `~/.mikan/slack.json`**, written by `mikan slack set`. It holds only Slack's `display_information` fields (name, description, long description, background color), validated with Slack's length limits. The applied manifest is the built-in one with those fields replaced.
- **The daemon syncs at startup** when `slack-config-token.json` exists: rotate the token and save the new pair first, find the app ID from the bot token, export the live manifest, and update when it differs from the desired one, ignoring key order and the fields Slack manages itself. The live app then matches mikan; settings added by hand in Slack are removed.
- **New scopes need a person.** When an update reports `permissions_updated` and the bot token lacks a desired scope, mikan DMs the token's owner a reinstall link once, and keeps running with the scopes it has.
- **Failures never stop startup.** Each Slack call has a 15 s timeout and no retries; a failure logs one warning and leaves the app as it was.
- **Without a configuration token nothing changes.**
- **`mikan onboard` creates new apps.** Picking Slack offers to create the app: onboarding asks for the configuration refresh token and the app name and description, and after confirmation creates the app with `apps.manifest.create`. It then prints the install link and where to create the app-level token, and asks for the bot token and the `xapp-` token, the two steps Slack offers no API for. If onboarding fails or is declined after that, it deletes the app.
- **Existing apps join through the CLI.** `mikan slack token` takes the refresh token, checks it by rotating, and stores the pair; the next start syncs the app.

## Not decided here

- The app icon: the manifest has no icon field; Slack's separate `apps.icon.set` works with the same token but is out of scope.

## Consequences

- Edits in Slack's settings pages are overwritten on the next start; `mikan slack set` is the supported way to customize.
- Every rotation revokes the previous access token, so one configuration token serves one mikan install.
- A configuration token stops working when its owner leaves the workspace or loses access to the app; sync then logs a warning, and the operator stores a token from another collaborator.
- An app built from the agent manifest loses the agent surface once a token is stored, because the built-in manifest is the classic app.
- Removing a scope from the manifest does not remove it from an installed token.
- Startup waits for about five Slack API calls, around 1 to 2 s.
