---
title: Make mikan a GitHub teammate
description: Bind a GitHub account to mikan with a fine-grained PAT and a webhook so your team can mention, assign, and ask it for review.
---

After this guide, your team can type `@` in an issue or PR and pick mikan from autocomplete, assign an issue or PR to it, or request its review. mikan acts on GitHub only as that account.

Below, `acme` is your organization, `acme-agent` is the account, and `https://mikan.example.com` is mikan's `LINK_URL`. Replace them with your real names.

## Before you start

- mikan runs with the link server (`LINK_PORT`) behind a public HTTPS address (`LINK_URL`), so GitHub can reach `<LINK_URL>/github/webhook`.
- You are an organization owner, or can ask one to approve requests and add the webhook.

## 1. Create the account

1. Sign up a new GitHub account, such as `acme-agent`, with a shared team mailbox such as `agent@example.com`. GitHub allows machine accounts; the person who creates one is responsible for it.
2. Enable two-factor authentication. GitHub requires it for contributors, and because the team shares this account, make sure everyone who needs to sign in can complete it.
3. Set an avatar, display name, and bio (for example, "mikan AI teammate") so people recognize it.

## 2. Give the account repository access

As an owner, invite `acme-agent` at `https://github.com/orgs/acme/people`, then accept the invitation while signed in as the account. Then give it a role in the repositories where mikan works, through a team or directly:

| Role       | What mikan can do there                                     |
| ---------- | ----------------------------------------------------------- |
| **Read**   | Be mentioned and assigned, comment, react, read code and CI |
| **Triage** | Also manage labels, assignees, and close issues             |
| **Write**  | Also push branches and open pull requests                   |

The role is an upper bound. mikan's own settings (step 5) decide what it actually does.

## 3. Create a fine-grained PAT

Do every step **signed in as the account**.

1. Open `https://github.com/settings/personal-access-tokens/new`.
2. Set **Token name** to `mikan` and describe its purpose and owner in **Description**.
3. Set **Resource owner** to `acme`, not the personal account. Otherwise the token only sees the account's own repositories. If the organization is missing from the list, an owner enables fine-grained PATs under **Organization settings** → **Personal access tokens** → **Settings**.
4. Set **Expiration** per company policy and schedule a reminder a week before it.
5. Under **Repository access**, choose **All repositories** or the ones mikan works in.
6. Under **Repository permissions**, add exactly these:

   | Permission          | Access         | Used for                                 |
   | ------------------- | -------------- | ---------------------------------------- |
   | **Contents**        | Read and write | Cloning and pushing from the sandbox     |
   | **Issues**          | Read and write | Comments, reactions, labels, assignees   |
   | **Pull requests**   | Read and write | PR comments, review replies, opening PRs |
   | **Actions**         | Read-only      | CI jobs and their logs                   |
   | **Commit statuses** | Read-only      | Results from CI outside GitHub Actions   |

   **Metadata: Read-only** is added automatically. There is no Checks permission for fine-grained PATs.

7. Click **Generate token** and copy the token starting with `github_pat_`. It is shown only once.
8. If the organization requires approval, the token page says it is waiting for approval and lists no access. An owner approves it under **Organization settings** → **Personal access tokens** → **Pending requests**.

## 4. Verify the token

```bash
read -rs GITHUB_AGENT_TOKEN && export GITHUB_AGENT_TOKEN

# Prints the account's login, such as "acme-agent"
curl -s -H "Authorization: Bearer $GITHUB_AGENT_TOKEN" https://api.github.com/user | jq -r .login

# Prints 200; 404 means the token is not approved, the resource owner is wrong, or the account has no access
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $GITHUB_AGENT_TOKEN" \
  "https://api.github.com/repos/acme/widgets/issues?per_page=1"
```

## 5. Add the webhook

As an organization owner, open `https://github.com/organizations/acme/settings/hooks/new`:

1. **Payload URL**: `https://mikan.example.com/github/webhook`
2. **Content type**: `application/json`
3. **Secret**: a long random string, for example from `openssl rand -hex 32`.
4. **Which events**: choose **Let me select individual events** and check **Issues**, **Issue comments**, **Pull requests**, and **Pull request review comments**.
5. Click **Add webhook**. GitHub sends a ping; **Recent Deliveries** shows a green check once mikan runs with the same secret.

A GitHub App webhook works the same way if you prefer one, for example for repositories outside an organization.

## 6. Configure mikan

Put the two secrets in `~/.mikan/mikan.env`:

```bash
GITHUB_AGENT_TOKEN=github_pat_...
GITHUB_WEBHOOK_SECRET=<the webhook secret>
```

Then list where mikan answers in `~/.mikan/settings.json`, and restart it:

```json
{
  "github": {
    "repos": ["acme/*"]
  }
}
```

`github.repos` takes `owner/repo` or `owner/*` entries. By default mikan answers only in private repositories, only to people with write permission, and can only comment and read. Loosen or tighten that with more `github` settings:

| Setting                | Example                 | Effect                                         |
| ---------------------- | ----------------------- | ---------------------------------------------- |
| `github.capabilities`  | `["triage", "push"]`    | Also manage labels and assignees, and open PRs |
| `github.triggers`      | `["mention", "assign"]` | Only react to mentions and assignments         |
| `github.users`         | `["alice", "bob"]`      | Only these people can trigger it               |
| `github.minPermission` | `"maintain"`            | Only maintainers and admins can trigger it     |
| `github.publicRepos`   | `true`                  | Also answer in public repositories             |

The startup log shows:

```text
GitHub bot started as @acme-agent, answering in acme/*
```

An invalid token makes startup fail.

mikan itself never runs git. The agent clones and pushes inside its sandbox, which gets GitHub credentials the same way Slack conversations do: through `sandbox.defaultSharedVault` or a conversation vault with `GH_TOKEN`. See [Vault](/sandbox/vault/). Without them the agent can still read public repositories and answer through the API. Protect the default branch so that the agent's changes land only through reviewed pull requests.

## 7. Try it

Use an account with the required permission on the repository.

1. In a test issue, type `@acme`, check that autocomplete offers `acme-agent`, and send `@acme-agent hello`.
2. `acme-agent` reacts with 👀, then replies when done.
3. In another issue, pick `acme-agent` under **Assignees**. mikan starts from the issue title and body.

## Troubleshooting

| Symptom                                               | Likely cause                                                                                                          | Fix                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Startup fails with `GET /user failed with 401`        | The token is mistyped, expired, or revoked                                                                            | Create a new token and update the environment                     |
| Webhook deliveries show a red cross with 401          | `GITHUB_WEBHOOK_SECRET` differs from the webhook's secret                                                             | Set the same secret on both sides                                 |
| Webhook deliveries fail to connect                    | mikan's `LINK_URL` is not reachable from the internet                                                                 | Check the reverse proxy and `LINK_PORT`                           |
| Deliveries succeed but mikan stays silent             | Repository not in `github.repos`, public repository, trigger or user disabled, or sender below the minimum permission | Check the settings in step 6; mikan logs why it ignored a trigger |
| Cloning or commenting fails with 404                  | Token pending approval, wrong resource owner, or the account lacks access                                             | Recheck steps 2 and 3                                             |
| The account is missing from autocomplete or Assignees | The account has no access to that repository                                                                          | Adjust as in step 2                                               |

mikan does not replay missed deliveries. If it was down when someone mentioned it, mention it again.

## Rotating and revoking the token

- **Before expiry**: create a new token as in step 3 → update the environment → restart mikan → confirm replies work → delete the old token.
- **If leaked**: sign in as the account and revoke it under **Settings** → **Developer settings** → **Fine-grained tokens**, then create a new one. An organization owner can also revoke it under **Organization settings** → **Personal access tokens** → **Active tokens**.
