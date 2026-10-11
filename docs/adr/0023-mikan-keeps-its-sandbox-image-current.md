---
status: accepted
---

# mikan keeps its sandbox image current

`--sandbox=oci` runs the image published for the running mikan version, `ghcr.io/geminixiang/mikan-sandbox:<version>`. On start the provisioner pulls its configured image in the background, whatever image that is. Offices move to the pulled image the next time they start after an idle stop (ADR 0014), and the last container replaced away from an older published image removes it.

## Context

ADR 0009 left pulling to deployments: mikan compared containers with the local image and never pulled. Deployments configured the mutable `:latest` tag and pulled by hand, if at all. One production deployment ran mikan 1.3.0 on an image pulled three weeks and seven releases earlier, with some offices on an image from four months before; offices failed when they used a browser that only the newer image contained. Each release also rebuilt the image from scratch, so even an unchanged Dockerfile meant a new 940 MB download.

## Decision

- **One image per release.** A release publishes `:<version>`; stable releases also move `:latest`. A release whose Dockerfile is unchanged and whose image is under 30 days old tags the previous image instead of rebuilding it, so most upgrades download nothing and replace no container, while tools still refresh about monthly.
- **The version picks the image.** `--sandbox=oci` resolves to that release's tag, so mikan and its sandbox upgrade and roll back together. `oci:<image>` keeps any other image.
- **mikan pulls.** A pull at start is a manifest check when nothing changed. A failed pull is a warning, and offices keep the local image; an image that exists only locally keeps working. Creating a container waits for the same pull rather than starting another.
- **mikan removes only what it stopped using.** After replacing a container for image drift, it runs `rmi` without force on the old container's published reference, or on its image ID otherwise. Engines refuse while any container uses the image, and an image ID while a name still points to it, so an operator's own images and tags stay.

## Considered options

- **Pull only the default image**: deployments pinned to `:latest` would stay stale until an operator edits their configuration.
- **Delete by repository name**: would remove images an operator built or tagged under that name.
- **Replace running containers once the image arrives**: an office could lose a command in flight; replacing at the next start after an idle stop reaches every active office within the idle timeout.

## Consequences

- Upgrading or rolling back mikan is the whole procedure; no `docker pull` step remains in onboarding or the deployment guide.
- A daemon start contacts the registry once. On a host without registry access the warning repeats on each start.
- A version with no published image, such as a build from an unreleased commit, fails to create new offices until it is given `oci:<image>`.
- Offices that never start again keep their container and its image until removed.
- Point 5 of ADR 0009, that mikan never pulls, no longer holds.
