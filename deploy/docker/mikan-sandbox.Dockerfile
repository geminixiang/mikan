FROM debian:13-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Taipei
ENV NVM_DIR=/root/.nvm
ENV CLOUDSDK_CORE_DISABLE_PROMPTS=1

SHELL ["/bin/bash", "-lc"]

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

ARG NODE_VERSION=24
ARG AGENT_BROWSER_VERSION=0.38.1
ARG GWS_VERSION=0.22.5

RUN curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash \
  && source "$NVM_DIR/nvm.sh" \
  && nvm install "$NODE_VERSION" \
  && nvm alias default "$NODE_VERSION" \
  && NODE_BIN_DIR="$NVM_DIR/versions/node/$(nvm version "$NODE_VERSION")/bin" \
  && ln -sf "$NODE_BIN_DIR/node" /usr/local/bin/node \
  && ln -sf "$NODE_BIN_DIR/npm" /usr/local/bin/npm \
  && ln -sf "$NODE_BIN_DIR/npx" /usr/local/bin/npx \
  && ln -sf "$NODE_BIN_DIR/corepack" /usr/local/bin/corepack \
  && npm install -g yarn \
  && ln -sf "$NODE_BIN_DIR/yarn" /usr/local/bin/yarn \
  && (ln -sf "$NODE_BIN_DIR/yarnpkg" /usr/local/bin/yarnpkg 2>/dev/null || true)

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
  && wget -q --timeout=30 --tries=10 --retry-connrefused -O "$GWS_TMP/$GWS_ARTIFACT" "$GWS_URL" \
  && wget -q --timeout=30 --tries=10 --retry-connrefused -O "$GWS_TMP/$GWS_ARTIFACT.sha256" "$GWS_URL.sha256" \
  && (cd "$GWS_TMP" && sha256sum -c "$GWS_ARTIFACT.sha256") \
  && tar -xzf "$GWS_TMP/$GWS_ARTIFACT" -C "$GWS_TMP" \
  && install -m 0755 "$GWS_TMP/gws" /usr/local/bin/gws \
  && rm -rf "$GWS_TMP"

RUN source "$NVM_DIR/nvm.sh" \
  && NODE_BIN_DIR="$NVM_DIR/versions/node/$(nvm version "$NODE_VERSION")/bin" \
  && npm install -g "agent-browser@$AGENT_BROWSER_VERSION" \
  && ln -sf "$NODE_BIN_DIR/agent-browser" /usr/local/bin/agent-browser \
  && test "$(agent-browser --version)" = "agent-browser $AGENT_BROWSER_VERSION"

RUN curl -fsSL https://bun.sh/install | bash \
  && ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
  && ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx

RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
  && ln -sf /root/.local/bin/uv /usr/local/bin/uv \
  && ln -sf /root/.local/bin/uvx /usr/local/bin/uvx

RUN uv tool install keyring --with keyrings.google-artifactregistry-auth \
  && ln -sf /root/.local/bin/keyring /usr/local/bin/keyring

RUN uv tool install yt-dlp \
  && ln -sf /root/.local/bin/yt-dlp /usr/local/bin/yt-dlp

RUN curl -fsSL https://sentry.io/get-cli/ | sh

RUN curl -fsSL https://sdk.cloud.google.com | bash -s -- --disable-prompts --install-dir=/root \
  && ln -sf /root/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud \
  && ln -sf /root/google-cloud-sdk/bin/gsutil /usr/local/bin/gsutil \
  && ln -sf /root/google-cloud-sdk/bin/bq /usr/local/bin/bq \
  && gcloud config set core/disable_usage_reporting true \
  && gcloud config set component_manager/disable_update_check true

RUN printf '\n# nvm\nexport NVM_DIR="%s"\n[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\n[ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"\n' \
  "$NVM_DIR" >> /root/.bashrc

WORKDIR /workspace

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
