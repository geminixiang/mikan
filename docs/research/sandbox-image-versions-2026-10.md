# Keeping the sandbox image in step with mikan

Date: 2026-10-11. Question: why do offices keep running an old sandbox image after mikan upgrades, and how can mikan move them to the image of its own release without operator steps?

## What happens today

- The provisioner pulls the configured image only when no local image has that reference (`pulledImageId`), and only while creating a container.
- Image drift compares a stopped container's `mikan.image-id` label with the **local** image ID (`hasImageDrift`). An image that was never pulled is not drift, so the container is started again unchanged.
- onboarding, the pm2 template, and the documentation configure `oci:ghcr.io/geminixiang/mikan-sandbox:latest`, a tag that moves on the registry without the host noticing.

One production deployment, inspected on 2026-10-11, ran mikan 1.3.0 with a local `:latest` pulled on 2026-09-23. Of its 56 office containers, 35 used that image, 16 an image from June, and 5 others; seven releases had published newer images in between. Offices that used the browser in late September failed 23 times because their containers predated the image that added it.

## How releases publish the image

Each release publishes `ghcr.io/geminixiang/mikan-sandbox:<version>`, and stable releases also move `:latest`. Since #174 a release whose Dockerfile is unchanged and whose image is under 30 days old tags the previous image instead of rebuilding it, so consecutive versions usually share one digest: upgrading mikan then downloads nothing and leaves containers alone. Before #174 every release rebuilt the image and 936 of its 1,013 compressed MB were new layers.

## Engine behavior the design relies on

| Behavior                                                                               | Result                                                                                            |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pull` of a reference already present and current                                      | completes after a manifest check and changes nothing                                              |
| `pull` of a reference the registry lacks                                               | fails; a local image with that reference stays usable                                             |
| `rmi <reference>` without `-f` while any container, running or stopped, uses the image | refused (nerdctl: "image is being used by stopped container"; Docker when it is the only name)    |
| `rmi <image ID>`                                                                       | Docker refuses while several names point to the image; nerdctl answers "no such image" for any ID |
| a tag moved by a pull or `tag` on nerdctl                                              | leaves no unnamed image behind                                                                    |

## Design

1. `--sandbox=oci` without an image means `ghcr.io/geminixiang/mikan-sandbox:<mikan version>`; `oci:<image>` stays for any other image.
2. At startup the provisioner pulls the configured image in the background. A failed pull is logged as a warning, and offices keep the local image if there is one. Creating a container waits for that same pull instead of starting a second one.
3. Drift then compares against the freshly pulled image, so each office moves to it the next time it starts after an idle stop; a running office is never replaced.
4. After replacing a container for image drift, the provisioner removes the image the old container used, by ID and without force. The engine refuses while another container still uses it, so the last office to move releases the old image.

Because step 2 applies to any image, deployments pinned to `:latest` also follow the registry from their next restart; switching them to `--sandbox=oci` additionally keeps the image matched to the running mikan.

Rejected:

- **Pull only the default image**: deployments configured with `:latest` would stay stale until an operator edits their configuration.
- **Delete images by repository name**: it would remove images an operator built or tagged under that name; removing by the replaced container's image ID touches only what mikan itself stopped using.
- **Replace running containers at startup**: an office could lose a command in flight; replacement at the next start after an idle stop already reaches every active office within the idle timeout.

## Acceptance eval

`.workspace/versioned-image/upgrade.eval.ts`, against a local `registry:2` holding two images that differ only in `/sandbox-version`, on nerdctl:

| Case                                                         | main                        |
| ------------------------------------------------------------ | --------------------------- |
| C1 `--sandbox=oci`                                           | error: invalid sandbox type | `ghcr.io/geminixiang/mikan-sandbox:1.3.0` |
| C2 stopped office after upgrading to an image not yet pulled | stays on 1.0.0              | moves to 1.1.0                            |
| C3 old image after its only office moved                     | kept                        | removed                                   |
| C4 old image while a second office still uses it             | kept, kept                  | kept, then removed                        |
| C5 upgraded to a version the registry lacks                  | office runs 1.0.0           | office runs 1.0.0                         |
| C6 local-only image                                          | office runs                 | office runs                               |
| C7 running office during an upgrade                          | stays on 1.0.0              | stays on 1.0.0                            |
| C8 new office after upgrading                                | 1.1.0                       | 1.1.0                                     |
| C9 `:latest` moved on the registry, daemon restarted         | stays on 1.0.0              | moves to 1.1.0                            |
