# How GitHub-resident AI agents receive events and establish identity (2026-09)

Question: how do AI coding agents that work inside GitHub issues and pull requests receive events, and which identity do they act as? The answer informs mikan's GitHub adapter intake design ([ADR 0015](../adr/0015-github-agent-account-and-webhooks.md), proposed).

Sources were read on 2026-09-30. Documentation pages were fetched as Markdown (`docs.github.com/api/article/body`, `*.md` variants of vendor docs). Source code was cloned at the commits noted.

## Summary

Every hosted product verified here is a GitHub App, and webhooks deliver to the vendor's own public endpoint: Codex, Jules, Cursor, Devin, CodeRabbit, OpenHands Cloud, and the Claude app. Open-source, self-run agents avoid needing an endpoint by running inside GitHub Actions: the workflow's `on:` events are the intake, and the agent runs on a GitHub runner (`claude-code-action`, Factory `droid-action`, `openai/codex-action`). hermes-agent offers both cron polling with a watermark and a self-hosted webhook server. No verified agent uses the user Notifications API or email notifications for intake.

Identity is almost always `slug[bot]`, triggered by a text phrase such as `@codex`, `@cursor`, or `@claude`, which GitHub does not autocomplete. Only three things can be assigned or appear in autocomplete:

- Copilot, which is first-party.
- GitHub-run third-party agents (Claude and Codex through Agent HQ).
- "Agent apps", in public preview and available by waitlist. They run on Copilot's runtime and are billed to the user's Copilot subscription.

Everything else that wants to be assignable is a regular user account with repository access.

## Comparison

| Agent                                              | Identity                                                                                        | Trigger                                                                                           | Event intake                                                                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Copilot cloud agent (formerly coding agent) | First-party; App `copilot-swe-agent` subscribes to no webhooks                                  | Issue assignment, `@copilot` in PRs (write access), Agents tab, automations, REST agent tasks API | Internal to GitHub; runs on Actions-powered runners                                                                                   |
| Claude, Codex via Agent HQ                         | Hidden GitHub-installed Apps                                                                    | Assignment, `@AGENT_NAME` in PR comments, Agents tab                                              | Run by GitHub, not by the vendor                                                                                                      |
| OpenAI Codex (GitHub integration)                  | App `chatgpt-codex-connector`                                                                   | `@codex review`, `@codex <task>`, optional auto-review                                            | App webhooks to OpenAI (inferred from subscribed events)                                                                              |
| `openai/codex-action`                              | Workflow token                                                                                  | Workflow `on:` events                                                                             | GitHub Actions                                                                                                                        |
| Google Jules                                       | App `google-labs-jules`; can commit as the user                                                 | Label `jules`, `@Jules` on its own PRs, CI failures                                               | App webhooks (inferred from subscribed events)                                                                                        |
| Cursor cloud agents and Bugbot                     | App `cursor`; user-run automations open PRs as the user                                         | `@cursor`, `cursor review` / `bugbot run`, automatic on PR updates, event automations             | App webhooks to Cursor; self-hosted workers dial out over a long-lived HTTPS connection                                               |
| Devin                                              | App `devin-ai-integration`; users can link their own account so PRs and comments appear as them | Web app, automations on GitHub events, review comments on its PRs                                 | App webhooks to Devin                                                                                                                 |
| CodeRabbit                                         | App `coderabbitai`                                                                              | Automatic on PRs, `@coderabbitai` commands                                                        | App webhooks to `https://app.coderabbit.ai/githubHandler`                                                                             |
| OpenHands Cloud                                    | GitHub App with 8-hour user tokens                                                              | Label `openhands`, comment starting `@openhands`                                                  | App webhooks to `/integration/github/events` (self-hosted enterprise needs public TLS hostnames)                                      |
| `anthropics/claude-code-action`                    | `claude[bot]` by default, a custom App, or any `github_token`                                   | `trigger_phrase` (default `@claude`), `assignee_trigger` (a username), `label_trigger`            | GitHub Actions workflow per repository                                                                                                |
| Factory `droid-action`, Factory automations        | Workflow or App token                                                                           | `@droid`, assignee, label `droid`; automations on schedules, Slack, GitHub events, webhooks       | GitHub Actions; Factory cloud for automations                                                                                         |
| nousresearch/hermes-agent                          | Configured `GITHUB_TOKEN`                                                                       | Cron watchers; webhook routes                                                                     | Polling `repos/{repo}/{issues,pulls,…}` or search with a watermark; or a self-hosted HMAC webhook server with delivery-ID idempotency |
| openclaw                                           | Per-agent managed GitHub identity                                                               | None: GitHub is a reader and tool, not a chat surface                                             | None                                                                                                                                  |

Not included: Sweep, which pivoted to a JetBrains assistant (`sweepai/sweep` README, `a8b8b67`), and SWE-agent, which is a CLI pointed at an issue URL rather than a resident bot (`SWE-agent/SWE-agent` README, `3ea751c`).

## Evidence per agent

### GitHub Copilot cloud agent

- `gh api apps/copilot-swe-agent` lists `events: []` and permissions including `agent_tasks`. GitHub drives it internally.
- Triggers include assignment and `@copilot` on PRs from users with write access. After assignment it does not react to later issue comments; follow-ups go to the PR. The agent tasks API rejects GitHub App installation tokens.
  - https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github
  - https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api
  - https://github.blog/changelog/2025-12-03-assign-issues-to-copilot-using-the-api

### OpenAI Codex

- App `chatgpt-codex-connector` subscribes to `issues`, `issue_comment`, `pull_request*`, `check_*`, and more (`gh api apps/chatgpt-codex-connector`). Triggers are `@codex review`, `@codex security review`, and `@codex <task>`; it reacts with 👀. https://learn.chatgpt.com/docs/third-party/github.md
- `openai/codex-action` runs `codex exec` in a workflow. https://learn.chatgpt.com/docs/github-action.md

### Google Jules

- App `google-labs-jules`. Applying the label `jules` starts a task. In Reactive Mode it responds only to `@Jules` on its own PRs. The CI Fixer reacts to failed checks. Commit authorship can be the user's (changelog 2026-02-19).
  - https://jules.google/docs/running-tasks.md
  - https://jules.google/docs/changelog.md
  - https://jules.google/docs/changelog/2026-02-19.md

### Cursor

- Comments, approvals, and reviewer requests run as `cursor`. User-run automations open PRs as the user. https://cursor.com/docs/cloud-agent/automations.md
- Webhooks are delivered to Cursor, which then calls REST and GraphQL to read state. https://cursor.com/docs/integrations/github.md
- Self-hosted workers open "a long-lived outbound HTTPS connection to Cursor's backend… No inbound ports, public IPs, or VPN tunnels are required". Webhooks terminate at Cursor's central service. https://cursor.com/docs/cloud-agent/self-hosted.md

### Devin

- An organization-wide GitHub App. Individual users can link their account so that "pull requests Devin opens in their sessions are authored by them". Automations start sessions from GitHub webhooks, Slack, Linear, schedules, and custom webhooks. For verified commits, the docs suggest creating "a dedicated GitHub user account".
  - https://docs.devin.ai/integrations/gh.md
  - https://docs.devin.ai/product-guides/automations.md

### CodeRabbit

- A GitHub App with webhooks. For GitHub Enterprise Server, the App's webhook URL is `https://app.coderabbit.ai/githubHandler`, and missed events are fixed with **Redeliver**.
  - https://docs.coderabbit.ai/platforms/github-com.md
  - https://docs.coderabbit.ai/platforms/github-enterprise-server.md

### OpenHands

- Cloud: labeling an issue `openhands` or commenting `@openhands` starts work. The App requests 8-hour tokens. `OpenHands/docs` `openhands/usage/cloud/github-installation.mdx` (`98b53b2`).
- Self-hosted enterprise: a private GitHub App whose webhook URL is `https://app.<base-domain>/integration/github/events` on publicly trusted TLS. `OpenHands/docs` `enterprise/integrations/github.mdx`.

### anthropics/claude-code-action

- `action.yml` (`8ce9314`) exposes `trigger_phrase` (default `@claude`), `assignee_trigger` ("The assignee username that triggers the action"), and `label_trigger`. The example workflows listen on `issue_comment` and `issues: [opened, assigned]`.
- Comments appear as `claude[bot]` unless a custom `github_token` is passed; sticky comments then break (`docs/faq.md`). A custom GitHub App is supported (`docs/setup.md`).

### Factory

- `Factory-AI/droid-action` `action.yml` (`812429d`) mirrors claude-code-action: `@droid`, an assignee trigger, and the label `droid`. Factory automations start from schedules, Slack, GitHub events, or inbound webhooks. https://docs.factory.ai/software-factory/automations.md

### nousresearch/hermes-agent

- `optional-skills/devops/watchers` (`99721dca`): "Poll RSS, JSON APIs, and GitHub with watermark dedup". `watch_github.py` polls `repos/{repo}/{issues,pulls,releases,commits}` or issue search, records a baseline on first run, and bounds the ID set.
- `website/docs/user-guide/messaging/webhooks.md`: a self-hosted webhook server with HMAC validation, filters, `X-GitHub-Delivery` idempotency cached for one hour, coalescing of bursts, and `deliver: github_comment`.

### openclaw

- `extensions/github` (`78f042e6`) is a reader for issues, PRs, and commits beside chat. It "does not register agent tools… does not change issues, post comments". Agents can have a managed GitHub identity for API reads.

## GitHub's official mechanisms for assignable or mentionable agents

1. **Assignees**: "yourself, anyone who has commented on the issue or pull request, anyone with write permissions to the repository, and organization members with read permissions… You may also be able to assign Copilot." Ordinary Apps cannot be assigned. https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/assigning-issues-and-pull-requests-to-other-github-users
2. **Third-party agents in Agent HQ** (public preview): Claude and Codex only. They are enabled by Copilot policy as hidden Apps, and GitHub runs them.
   - https://docs.github.com/en/copilot/concepts/agents/about-third-party-agents
   - https://github.blog/changelog/2026-02-04-claude-and-codex-are-now-available-in-public-preview-on-github
3. **Agent apps** (public preview since 2026-06-02): a Marketplace GitHub App configured as an agent can be assigned and appears in the `@` autocomplete picker. It is "powered by Copilot cloud agent": the partner supplies an agent definition and MCP servers, which are authorized with a GitHub-issued JWT, and usage bills the user's Copilot. Access is limited to partners and a waitlist for now.
   - https://github.blog/changelog/2026-06-02-extend-github-with-agent-apps
   - https://docs.github.com/en/copilot/concepts/agents/agent-apps
   - https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-agent-apps

## Webhook delivery facts

- A delivery fails without a 2XX response within 10 seconds, and "GitHub does not automatically redeliver failed deliveries". Failed deliveries can be listed and redelivered through the REST API. Use `X-GitHub-Delivery` to deduplicate.
  - https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries
  - https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
- The redelivery window is stated as both 3 and 7 days on the same page. https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks

## Patterns against mikan's constraints

| Pattern                                                                       | Needs a public endpoint    | Scales to hundreds of repositories        | Assignable or autocompleted                  |
| ----------------------------------------------------------------------------- | -------------------------- | ----------------------------------------- | -------------------------------------------- |
| App webhooks to own service (hosted products)                                 | Yes                        | Yes (one App installation)                | No, except through agent apps                |
| Central webhook receiver plus outbound long-lived worker (Cursor self-hosted) | Only the central service   | Yes                                       | Depends on identity                          |
| GitHub Actions workflow per repository                                        | No                         | Needs a workflow file in every repository | Through `assignee_trigger` on a user account |
| Per-repository polling with a watermark (hermes watchers, mikan today)        | No                         | No (requests grow with repositories)      | Depends on identity                          |
| User Notifications API or email                                               | No                         | Yes (one account inbox)                   | Yes, with a user account                     |
| GitHub agent apps                                                             | No (GitHub runs the agent) | Yes                                       | Yes, but the agent runs on Copilot's runtime |

Unverified: the webhook delivery internals of Codex, Jules, and Devin, which are inferred from the webhook events each App subscribes to, and CodeRabbit's own intake beyond its documented webhook URL.
