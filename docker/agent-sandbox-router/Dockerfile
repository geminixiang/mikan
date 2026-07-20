FROM alpine/git:2.49.1 AS source

ARG AGENT_SANDBOX_COMMIT=9575043bdce1e4d9f6d485df814b583c207e9ce9
RUN git clone --filter=blob:none https://github.com/kubernetes-sigs/agent-sandbox.git /src \
  && cd /src \
  && git checkout --detach "$AGENT_SANDBOX_COMMIT"

FROM golang:1.26.2 AS builder

ENV GOPROXY=https://proxy.golang.org,direct
ENV GOSUMDB=sum.golang.org
ENV GOMAXPROCS=2

ARG TARGETARCH=amd64
ARG GIT_VERSION=v0.5.2
ARG GIT_SHA=9575043bdce1e4d9f6d485df814b583c207e9ce9
ARG BUILD_DATE=unknown

WORKDIR /workspace
COPY --from=source /src/go.mod /src/go.sum ./
RUN go mod download
COPY --from=source /src/sandbox-router/ ./sandbox-router/
COPY --from=source /src/api/ ./api/
COPY --from=source /src/extensions/api/ ./extensions/api/
COPY --from=source /src/internal/ ./internal/
RUN CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build \
  -ldflags="-s -w \
    -X sigs.k8s.io/agent-sandbox/internal/version.gitVersion=${GIT_VERSION} \
    -X sigs.k8s.io/agent-sandbox/internal/version.gitSHA=${GIT_SHA} \
    -X sigs.k8s.io/agent-sandbox/internal/version.buildDate=${BUILD_DATE}" \
  -o /sandbox-router ./sandbox-router/cmd

FROM gcr.io/distroless/static:nonroot
COPY --from=builder /sandbox-router /sandbox-router
EXPOSE 8080 8443 9090 8081
ENTRYPOINT ["/sandbox-router"]
