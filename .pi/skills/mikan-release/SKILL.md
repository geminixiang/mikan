---
name: mikan-release
description: Prepare and publish a new mikan release. Use when bumping the version, committing and pushing it, and creating a GitHub release in the style of earlier mikan releases.
---

# Mikan Release

Repo defaults:

- branch: `main`
- remote: `origin`
- repo: `geminixiang/mikan`
- use `package.json` version as the git tag and GitHub release title
- versions with `-alpha.`, `-beta.`, or `-rc.` are prereleases by default

## Version rules

Examples:

- stable: `0.2.1`, `0.3.0`, `1.0.0`
- prerelease: `0.2.0-beta.8`, `0.3.0-rc.1`, `1.0.0-alpha.2`

Guidance:

- `patch` = bugfix / small maintenance
- `minor` = backward-compatible features
- `major` = breaking changes
- prerelease numbers increase within the same line, e.g. `beta.8 -> beta.9`
- promote prerelease to stable by dropping the suffix, e.g. `0.2.0-beta.8 -> 0.2.0`

## Flow

### 1. Check state

```bash
git status --short
git branch --show-current
git remote -v
git tag --list | tail -20
```

Read `package.json` and `package-lock.json`. If unrelated files are modified, ask before committing.

### 2. Sync version files

Preferred:

```bash
npm version <version> --no-git-tag-version
```

Use this to sync `package.json` and `package-lock.json` without creating an automatic commit or tag. If the user already edited `package.json`, just verify `package-lock.json` matches.

### 3. Update CHANGELOG

`CHANGELOG.md` follows Keep a Changelog with `### Added / Changed / Fixed / Removed / Security / Performance / Tests` subsections. The newest release sits at the top under an `## [Unreleased]` placeholder.

Gather user-visible changes since the previous tag:

```bash
git log --pretty=format:'%h %s' <previous-tag>..HEAD | grep -v "^[a-f0-9]* chore: bump version"
```

Then in `CHANGELOG.md`:

- Keep `## [Unreleased]` at the top as an empty placeholder.
- Insert a new section `## [<version>] - <YYYY-MM-DD>` (use today's date for stable, omit the date for prereleases to match the existing style).
- Group entries by subsection; one bullet per user-visible change, imperative voice, no commit hashes.
- Skip pure internal refactors that don't change behavior unless they affect contributors (then list under `### Changed`).

If you generated draft release notes in step 5 first, copy the same wording into CHANGELOG — they should match.

### 4. Commit and push

Stage version files and CHANGELOG together — the bump and the changelog entry belong in the same commit.

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: bump version to <version>"
git push origin main
```

### 5. Draft release notes

Use the previous GitHub release as the style reference.

```bash
gh release list --repo geminixiang/mikan --limit 10
gh release view <previous-tag> --repo geminixiang/mikan --json tagName,name,body,url,publishedAt
git log --pretty=format:'%h %s' <previous-tag>..HEAD
git diff --stat <previous-tag>..HEAD
```

Write concise notes focused on user-visible changes, usually with:

- `## What's changed`
- `### Highlights`
- `### Notable changes`
- `### Docs and maintenance`
- `### Verification`

Write notes to `/tmp/mikan-release-<version>.md`. Keep them consistent with the CHANGELOG entry from step 3.

### 6. Create or update release

Prerelease:

```bash
gh release create <version> \
  --repo geminixiang/mikan \
  --target main \
  --title <version> \
  --notes-file /tmp/mikan-release-<version>.md \
  --prerelease
```

Stable:

```bash
gh release create <version> \
  --repo geminixiang/mikan \
  --target main \
  --title <version> \
  --notes-file /tmp/mikan-release-<version>.md
```

If it already exists, use `gh release edit <version> ...` and keep prerelease/stable intent consistent.

## Report back

Return:

- released version
- stable or prerelease
- version-bump commit hash
- push status
- release URL

## Guardrails

- Always use `geminixiang/mikan`.
- Infer stable vs prerelease from the version, or ask.
- Do not include raw commit hashes in release notes unless requested.
- If hooks fail during commit, fix or report before retrying.
- Never publish a release without a corresponding CHANGELOG entry — the version bump commit must include the new CHANGELOG section.
