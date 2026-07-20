FROM ghcr.io/astral-sh/uv:0.8.22 AS uv

FROM mcr.microsoft.com/playwright:v1.55.1-noble

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
  apt-transport-https \
  bash \
  ca-certificates \
  curl \
  fd-find \
  ffmpeg \
  gh \
  git \
  gnupg \
  jq \
  python3 \
  python3-pip \
  ripgrep \
  tini \
  xvfb \
  && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
    | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
    > /etc/apt/sources.list.d/google-cloud-sdk.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-cloud-cli \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && ln -s /ms-playwright/chromium-1193/chrome-linux/chrome /usr/local/bin/chromium \
  && npm install --global playwright@1.55.1 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /uvx /usr/local/bin/

RUN pip3 install --break-system-packages --no-cache-dir \
  fastapi==0.116.1 \
  python-multipart==0.0.20 \
  uvicorn==0.35.0

COPY server.py /opt/mikan-runtime/server.py
COPY entrypoint.sh /usr/local/bin/mikan-runtime-entrypoint
RUN chmod 755 /usr/local/bin/mikan-runtime-entrypoint \
  && mkdir -p /workspace \
  && chmod 1777 /workspace

WORKDIR /workspace
EXPOSE 8888
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/mikan-runtime-entrypoint"]
