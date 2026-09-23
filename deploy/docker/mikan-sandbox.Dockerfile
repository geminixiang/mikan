ARG NODE_VERSION=24
ARG BUN_VERSION=1.4
ARG UV_VERSION=0.9

FROM node:${NODE_VERSION}-trixie-slim AS node
FROM oven/bun:${BUN_VERSION}-debian AS bun
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

FROM debian:13-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Taipei
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.local/bin
ENV NPM_CONFIG_PREFIX=/root/.local
ENV CLOUDSDK_CORE_DISABLE_PROMPTS=1
ENV CLOUDSDK_CORE_DISABLE_USAGE_REPORTING=true
ENV CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK=true

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update && apt-get install -y --no-install-recommends \
  apt-transport-https \
  bash \
  bash-completion \
  build-essential \
  ca-certificates \
  chromium \
  curl \
  fd-find \
  ffmpeg \
  file \
  fonts-liberation \
  git \
  gnupg \
  imagemagick \
  jq \
  less \
  lsb-release \
  nano \
  openssh-client \
  python-is-python3 \
  python3-pip \
  python3-venv \
  ripgrep \
  tini \
  unzip \
  vim \
  wget \
  xz-utils \
  zip \
  && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

ARG AGENT_BROWSER_VERSION=0.38.1
ARG GWS_VERSION=0.22.5

COPY --from=node /usr/local/bin/ /usr/local/bin/
COPY --from=node /usr/local/lib/node_modules/ /usr/local/lib/node_modules/
COPY --from=node /usr/local/include/node/ /usr/local/include/node/
COPY --from=node /opt/ /opt/
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=uv /uv /uvx /usr/local/bin/
RUN ln -s bun /usr/local/bin/bunx && rm -f /usr/local/bin/docker-entrypoint.sh

RUN curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
    | gpg --dearmor -o /etc/apt/keyrings/cloud.google.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
    > /etc/apt/sources.list.d/google-cloud-sdk.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-cloud-cli \
  && rm -rf /var/lib/apt/lists/*

# The gws npm postinstall downloads its native binary with Node fetch, which can
# terminate on slow GitHub release streams. Install the pinned, checksummed
# native release directly so multi-architecture image builds can retry safely.
RUN case "$(dpkg --print-architecture)" in \
    amd64) GWS_ARCH=x86_64 ;; \
    arm64) GWS_ARCH=aarch64 ;; \
    *) echo "Unsupported gws architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac \
  && GWS_ARTIFACT="google-workspace-cli-${GWS_ARCH}-unknown-linux-gnu.tar.gz" \
  && GWS_URL="https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}/${GWS_ARTIFACT}" \
  && GWS_TMP="$(mktemp -d)" \
  && wget -q --no-hsts --timeout=30 --tries=10 --retry-connrefused -O "$GWS_TMP/$GWS_ARTIFACT" "$GWS_URL" \
  && wget -q --no-hsts --timeout=30 --tries=10 --retry-connrefused -O "$GWS_TMP/$GWS_ARTIFACT.sha256" "$GWS_URL.sha256" \
  && (cd "$GWS_TMP" && sha256sum -c "$GWS_ARTIFACT.sha256") \
  && tar -xzf "$GWS_TMP/$GWS_ARTIFACT" -C "$GWS_TMP" \
  && install -m 0755 "$GWS_TMP/gws" /usr/local/bin/gws \
  && rm -rf "$GWS_TMP"

RUN npm install -g --prefix /usr/local --cache /tmp/npm-cache "agent-browser@$AGENT_BROWSER_VERSION" \
  && test "$(agent-browser --version)" = "agent-browser $AGENT_BROWSER_VERSION" \
  && rm -rf /tmp/npm-cache

RUN export UV_TOOL_DIR=/opt/uv/tools UV_TOOL_BIN_DIR=/usr/local/bin \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python UV_CACHE_DIR=/tmp/uv-cache \
  && uv tool install keyring --with keyrings.google-artifactregistry-auth \
  && uv tool install yt-dlp \
  && rm -rf /tmp/uv-cache

RUN curl -fsSL https://sentry.io/get-cli/ | INSTALL_DIR=/usr/local/bin sh

RUN rmdir /root/.ssh 2>/dev/null; test "$(ls -A /root | tr "\n" " ")" = ".bashrc .profile " || (ls -la /root && exit 1)

WORKDIR /workspace

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
