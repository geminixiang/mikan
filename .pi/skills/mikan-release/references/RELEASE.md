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

### 7. Watch the npm publish

Publishing the GitHub release is what ships the package: `.github/workflows/publish.yml`
runs on `release: published` and does `npm ci` → `npm run build` → `npm test` →
`node scripts/check-npm-package.mjs` → `npm publish --ignore-scripts --provenance --access public`,
adding `--tag beta` when the version contains a `-`. Lifecycle scripts are skipped at publish
because the workflow has already built and verified `dist`. A red workflow means the
release exists but nothing reached npm.

```bash
gh run list --repo geminixiang/mikan --workflow publish.yml --limit 3
```

## Report back

Return:

- released version
- stable or prerelease
- version-bump commit hash
- push status
- release URL
- npm publish workflow status

## Guardrails

- Always use `geminixiang/mikan`.
- Infer stable vs prerelease from the version, or ask.
- Do not include raw commit hashes in release notes unless requested.
- If hooks fail during commit, fix or report before retrying.
- Never publish a release without a corresponding CHANGELOG entry — the version bump commit must include the new CHANGELOG section.

## PM2 pitfalls when redeploying a local/production mikan

These apply to any PM2-supervised mikan (deploy/pm2/ecosystem.config.cjs or a
personal ecosystem file) after editing secrets, not to the GitHub release flow
itself — relevant whenever a release or hotfix requires restarting a running
instance.

- **`pm2 restart <app> --update-env` does not reliably pick up new values
  from an env file loaded via a custom `loadEnvFile()` in the ecosystem
  file.** The `env` object PM2 has cached in its own daemon memory from the
  original `pm2 start` is what gets reapplied; `--update-env` refreshes PM2's
  own process env, not a fresh `require()` of the ecosystem config. After
  rotating a secret (API key, bot token) in the env file, `pm2 restart
--update-env` can silently keep serving the old value — confirm with
  `pm2 env <id>` (or diff a hash of the file value vs the env value) before
  trusting it, or skip the ambiguity entirely:

  ```bash
  pm2 delete <app> && pm2 start <ecosystem-file> --only <app>
  ```

  This forces PM2 to `require()` the ecosystem file again and recompute
  `loadEnvFile()` from disk.

- **Verify a secret rotation actually took effect** before declaring it done:
  compare a short hash (not the raw value) of the env-file value against what
  the running process reports via `pm2 env <id>`, or watch the log for the
  provider's own auth confirmation (e.g. a successful connect banner) rather
  than assuming the restart alone was sufficient.
- **A stale-env crash loop can look unrelated to the secret you just
  rotated.** `pm2 restart --update-env` reusing a cached env silently for one
  variable can surface as an `invalid_auth` failure on a _different_
  variable that was never touched, because the whole cached `env` object —
  not just the one key you changed — may be stale. Don't assume the error is
  about the most recently edited secret; check every credential the process
  loads before chasing the wrong one. `pm2 delete && pm2 start
<ecosystem-file>` resolves both at once by reloading the full env from
  disk.
- **`pm2 stop`/`pm2 start` by bare app name does not reload the ecosystem
  file**, so it cannot pick up ecosystem-file changes (env loading, args,
  `cwd`) either — only `pm2 start <ecosystem-file> ...` does. Keep the
  ecosystem file path handy when redeploying, not just the app name.
