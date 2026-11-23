# Where the code is, and what could go (2026-11)

The owner's goal is a simpler codebase with a robust core. The changes of 2026-11-22 removed four features and added four, and production code shrank by about one percent. This survey asks where the remaining code is and which of it could be removed, so the next round is chosen from evidence.

## What the tools say

| Check                                   | Result                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `npm run duplication`                   | No clone of 70 tokens or more in production code.                                                              |
| `npm run knip`                          | No unused file, export, or dependency.                                                                         |
| `npm run knip:unused`                   | About fifty exports are used only by tests. Removing the `export` removes no code.                             |
| Tool calls in a deployment's daemon log | Every tool mikan offers was called in the last ten weeks. The least used is `generate_image`, about 100 lines. |

So there is no dead or duplicated code to collect. Lines leave only when a feature leaves, or when mikan hands a responsibility to a foundation.

## Where the lines are

Production TypeScript, tests excluded, is about 37,600 lines.

| Area                                             | Share | Notes                                                                                 |
| ------------------------------------------------ | ----- | ------------------------------------------------------------------------------------- |
| Web portals (`src/adapters/web`)                 | 23%   | Login, admin, session view, desktop: self-contained HTML pages behind one-time links. |
| Harness (`src/harness`)                          | 19%   | Session, presenter, runner, prompt, tools, MCP, skills.                               |
| Slack adapter                                    | 10%   | The platform every conversation of the measured deployment is on.                     |
| GitHub adapter                                   | 7%    | A handful of conversations on the measured deployment.                                |
| Sessions (`src/sessions`)                        | 6%    | Session store, chat history sync.                                                     |
| Discord and Telegram adapters                    | 4%    | No conversation on the measured deployment.                                           |
| Sandbox, commands, runtime, migrations, the rest | 31%   | Each under 4%.                                                                        |

## Candidates

| Candidate                                            | Size        | Evidence                                                                                                                          | What a person loses                                   | Verdict                                                                                                                                             |
| ---------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin portal                                         | about 3,800 | None. The web server logs no request, the reverse proxy keeps no access log, and commands are not in the daemon log.              | A page to edit settings, MCP servers, skills, events. | Undecided until measured. Settings are files and the agent edits them on request, so another path exists.                                           |
| Session view portal                                  | about 2,100 | None, for the same reason.                                                                                                        | A page showing a session's transcript and tool calls. | Undecided until measured.                                                                                                                           |
| Desktop                                              | about 350   | None. No desktop was running when the deployment was read.                                                                        | Watching the sandbox's screen in a browser.           | Undecided until measured.                                                                                                                           |
| Login portal                                         | about 1,900 | Vault files of the deployment are still being written.                                                                            | The way to hand mikan a credential.                   | Stays. The identity and credentials redesign replaces it; simplifying it first is work done twice.                                                  |
| Discord adapter                                      | about 900   | No conversation on the measured deployment. The repository is public, so an outside deployment may use it and cannot be measured. | The platform.                                         | Stays unless the owner narrows the platforms mikan supports. That is a product decision, not a maintenance one.                                     |
| Telegram adapter                                     | about 700   | As Discord. It gained suggested replies on 2026-11-23 at the owner's request.                                                     | The platform.                                         | Stays.                                                                                                                                              |
| `generate_image`                                     | about 100   | A few calls in ten weeks.                                                                                                         | Image generation without a skill.                     | Too small to matter; revisit with the tool counts of the next release.                                                                              |
| Session store, session, presenter, chat history sync | about 3,500 | These hold mikan's own session semantics beside pi-durable's.                                                                     | Nothing, if behaviour is kept.                        | The place a robust core is decided. Needs its own research against pi-durable's public interface at the installed version; not a deletion by count. |
| Migrations                                           | about 950   | ADR 0019 fixes the supported upgrade path.                                                                                        | The upgrade from 0.5.3.                               | Stays until 1.0.0 is released.                                                                                                                      |

## What was done

The three portals without evidence are a fifth of the code, and nothing records whether anyone opens them. The link stores now log one line when a portal link is created and one when it is first opened, naming the portal and nothing else (`src/adapters/web/token-store.ts`). After a release has run for thirty days, the daemon log answers the first three rows of the table.

## Order proposed

1. Release what is on `main`, so the removal checks of ADRs 0031, 0033, and 0034 and the portal counts start.
2. Research the session core against pi-durable: which of mikan's session code restates what Pi already keeps.
3. Identity and credentials redesign, which settles the login portal.
4. Decide the admin portal, session view, and desktop from thirty days of counts.
