import { describe, expect, test } from "vitest";
import {
  resolveOpenTelemetryConfiguration,
  resolveOpenTelemetryResourceAttributes,
} from "../observability/otel.js";

describe("OpenTelemetry configuration", () => {
  test("does not create exporters without an explicit endpoint", () => {
    expect(resolveOpenTelemetryConfiguration({})).toEqual({ traces: false, metrics: false });
  });

  test("enables both supported signals for an explicit base endpoint", () => {
    expect(
      resolveOpenTelemetryConfiguration({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      }),
    ).toEqual({ traces: true, metrics: true });
  });

  test("supports per-signal endpoints and exporter selection", () => {
    expect(
      resolveOpenTelemetryConfiguration({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://phoenix:6006/v1/traces",
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_METRICS_EXPORTER: "none",
      }),
    ).toEqual({ traces: true, metrics: false });

    expect(
      resolveOpenTelemetryConfiguration({
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://collector.example/v1/metrics",
        OTEL_TRACES_EXPORTER: "none",
        OTEL_METRICS_EXPORTER: "otlp",
      }),
    ).toEqual({ traces: false, metrics: true });
  });

  test("disables unsupported protocols, invalid effective endpoints, and the whole SDK", () => {
    expect(
      resolveOpenTelemetryConfiguration({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
        OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "grpc",
      }),
    ).toEqual({ traces: false, metrics: true });

    expect(
      resolveOpenTelemetryConfiguration({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:secret@collector.example",
      }),
    ).toEqual({ traces: false, metrics: false });

    expect(
      resolveOpenTelemetryConfiguration({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "not a URL",
      }),
    ).toEqual({ traces: false, metrics: true });

    expect(
      resolveOpenTelemetryConfiguration({
        OTEL_SDK_DISABLED: "TRUE",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      }),
    ).toEqual({ traces: false, metrics: false });
  });
});

describe("OpenTelemetry resource privacy", () => {
  test("uses a minimal resource and allowlists standard safe attributes", () => {
    expect(
      resolveOpenTelemetryResourceAttributes({
        OTEL_SERVICE_NAME: "mikan-worker",
        OTEL_RESOURCE_ATTRIBUTES: [
          "openinference.project.name=support",
          "deployment.environment.name=staging",
          "service.version=1.2.3",
          "host.name=private-host",
          "process.command=/Users/alice/private/start.js",
          "token=secret",
        ].join(","),
      }),
    ).toEqual({
      "service.name": "mikan-worker",
      "openinference.project.name": "support",
      "deployment.environment.name": "staging",
      "service.version": "1.2.3",
    });
  });

  test("follows standard percent encoding for allowlisted resource attributes", () => {
    expect(
      resolveOpenTelemetryResourceAttributes({
        OTEL_RESOURCE_ATTRIBUTES:
          "openinference.project.name=support%20team,service.namespace=agents%3Dprimary",
      }),
    ).toEqual({
      "service.name": "mikan",
      "openinference.project.name": "support team",
      "service.namespace": "agents=primary",
    });
  });

  test("discards the whole resource attribute list when standard parsing fails", () => {
    expect(
      resolveOpenTelemetryResourceAttributes({
        OTEL_RESOURCE_ATTRIBUTES:
          "deployment.environment.name=staging,service.namespace=invalid=separator",
      }),
    ).toEqual({ "service.name": "mikan" });
  });

  test("rejects oversized, credential-bearing, and absolute-path resource values", () => {
    expect(
      resolveOpenTelemetryResourceAttributes({
        OTEL_SERVICE_NAME: "/home/alice/private/mikan",
        OTEL_RESOURCE_ATTRIBUTES: [
          `service.namespace=${"x".repeat(129)}`,
          "service.version=sk-abcdefghijklmnop",
          "deployment.environment.name=/etc/mikan/private",
          "openinference.project.name=safe-project",
        ].join(","),
      }),
    ).toEqual({
      "service.name": "mikan",
      "openinference.project.name": "safe-project",
    });
  });
});
