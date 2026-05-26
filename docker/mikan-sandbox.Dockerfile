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
  curl \
  fd-find \
  ffmpeg \
  file \
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

ARG NODE_VERSION=22

RUN curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash \
  && source "$NVM_DIR/nvm.sh" \
  && nvm install "$NODE_VERSION" \
  && nvm alias default "$NODE_VERSION" \
  && NODE_BIN_DIR="$NVM_DIR/versions/node/$(nvm version "$NODE_VERSION")/bin" \
  && ln -sf "$NODE_BIN_DIR/node" /usr/local/bin/node \
  && ln -sf "$NODE_BIN_DIR/npm" /usr/local/bin/npm \
  && ln -sf "$NODE_BIN_DIR/npx" /usr/local/bin/npx \
  && ln -sf "$NODE_BIN_DIR/corepack" /usr/local/bin/corepack \
  && npm install -g yarn @googleworkspace/cli \
  && ln -sf "$NODE_BIN_DIR/yarn" /usr/local/bin/yarn \
  && (ln -sf "$NODE_BIN_DIR/yarnpkg" /usr/local/bin/yarnpkg 2>/dev/null || true) \
  && ln -sf "$NODE_BIN_DIR/gws" /usr/local/bin/gws

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
