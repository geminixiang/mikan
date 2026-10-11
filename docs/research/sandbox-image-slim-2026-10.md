# What the sandbox image needs

Date: 2026-10-11. `deploy/docker/mikan-sandbox.Dockerfile` at `47aeb084`, built for arm64 with nerdctl 2.3.1 (BuildKit in Colima). Sizes are the unpacked image as `nerdctl images` reports it.

## Which parts mikan depends on

Read from the source, the system prompt, and the vault presets:

| Part                                                           | Depended on by                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `tini` as PID 1                                                | reaping commands orphaned when a pi-env daemon dies                                             |
| `bash`, coreutils                                              | copying the pi-env daemon in (`uname`, `cat`, `chmod`, `mv`); string commands                   |
| `APT::Sandbox::User "root"`                                    | `apt-get install` under `--cap-drop ALL`; the prompt tells the agent to use the package manager |
| `chromium`, `agent-browser`, Node.js, CJK and Liberation fonts | the `jev_browser` tool                                                                          |
| `gh`                                                           | the git credential helper (`gh auth git-credential`) and GitHub write flows                     |
| `google-cloud-cli`, `gws`, `sentry-cli`, `openssh-client`      | vault credential presets                                                                        |
| `uv` and the `EXTERNALLY-MANAGED` file                         | Python packages; `pip install` answers with the `uv run --with` hint                            |

Nothing reads `vim`, `nano`, `less`, `bash-completion`, `lsb-release`, `apt-transport-https` (apt has served HTTPS itself since 1.5), `python3-venv` (uv creates environments), or `gnupg`, which only dearmored the Google apt key at build time; apt accepts the armored key as a `.asc` file. `python3-pip` stays because it is how a `pip install` reaches the uv hint. `ENV TZ=Asia/Taipei` fixed one deployment's zone in a public image.

## Where the size is

| Part                                                    | MB    |
| ------------------------------------------------------- | ----- |
| Whole image (`/`)                                       | 2,730 |
| `/usr/lib/google-cloud-sdk`                             | 694   |
| of which `.pyc` written by the package's install script | 254   |
| Chromium                                                | 374   |
| GCC toolchain (`build-essential`)                       | 199   |
| Node.js and npm                                         | 138   |
| agent-browser                                           | 114   |
| Fonts                                                   | 94    |
| bun                                                     | 76    |

The Cloud SDK's own `.py` sources are 248 MB, gsutil 81 MB, and bq 22 MB; the generated API clients are 278 MB with their bytecode, and `compute` alone is 52 MB.

## Removing the Cloud SDK bytecode

Deleting every `__pycache__` under the SDK in the install layer, measured in a container (ms):

| Command                    | With bytecode | Without, first run | Without, second run |
| -------------------------- | ------------- | ------------------ | ------------------- |
| `gcloud version`           | 190–245       | 601–790            | 175–188             |
| `gcloud storage ls --help` | 252–307       | 411–471            | 251–280             |
| `bq version`               | 349           | 619                | —                   |
| `gsutil version`           | 573           | 946                | —                   |

Python writes the bytecode it needs back on first use (24 MB after the commands above), so a new container pays the extra time once per command family. With `PYTHONDONTWRITEBYTECODE=1` every run would pay it (600–820 ms), so that variable is not set.

## Result

Both images built from the same base on the same day:

|                                  | main                                           | this change        |
| -------------------------------- | ---------------------------------------------- | ------------------ |
| Image size                       | 2,878 MB                                       | 2,489 MB (−389 MB) |
| Cloud SDK                        | 696 MB                                         | 415 MB             |
| `scripts/smoke-sandbox-image.sh` | fails the new UTC check (the image fixed `TZ`) | passes             |
| Slack E2E, `oci:` on nerdctl     | —                                              | 26 of 26           |

Without `TZ` in the image, the provisioner passes the mikan host's IANA zone to each container (`--env TZ=…`), which matches the system prompt's instruction to assume the host zone for events; `tzdata` is now listed explicitly.

Not changed: removing gsutil (deprecated in favor of `gcloud storage`, 81 MB) or bq (22 MB) would break commands agents and skills may call, and pruning API clients would break those command groups.
