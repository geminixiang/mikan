import type { GcpTokenProvider } from "../../gcp/auth.js";

/**
 * Host-side Cloud Build log retrieval for `github_checks`. Cloud Build's
 * GitHub App reports check runs whose `external_id` is the build UUID and
 * whose `details_url` carries the GCP project; with ADC on the host (e.g. a
 * WIF external_account file) the build's log object can be read from GCS.
 *
 * Required IAM for the ADC principal: roles/cloudbuild.builds.viewer on the
 * project and roles/storage.objectViewer on the logs bucket.
 */

const CLOUDBUILD_API = "https://cloudbuild.googleapis.com/v1";
const GCS_API = "https://storage.googleapis.com/storage/v1";

/** Check runs reported by this app slug are Cloud Build builds. */
export const CLOUD_BUILD_APP_SLUG = "google-cloud-build";

const BUILD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCloudBuildId(value: string): boolean {
  return BUILD_ID_PATTERN.test(value);
}

/** GCP project (id or number) from a Cloud Build details_url, or null. */
export function projectFromDetailsUrl(detailsUrl: string | null | undefined): string | null {
  if (!detailsUrl) return null;
  try {
    const project = new URL(detailsUrl).searchParams.get("project");
    return project || null;
  } catch {
    return null;
  }
}

export interface CloudBuildLogOptions {
  tokenProvider: GcpTokenProvider;
  project: string;
  buildId: string;
  fetchImpl?: typeof fetch;
}

interface CloudBuildBuild {
  status?: string;
  logsBucket?: string;
  logUrl?: string;
}

export class CloudBuildLogUnavailableError extends Error {
  constructor(
    message: string,
    public readonly consoleUrl?: string,
  ) {
    super(message);
    this.name = "CloudBuildLogUnavailableError";
  }
}

/**
 * Fetch one build's log text: builds.get → the `log-<id>.txt` object in the
 * build's logs bucket. Throws CloudBuildLogUnavailableError (with the console
 * url when known) whenever the log cannot be read — access denied, build not
 * found, or CLOUD_LOGGING_ONLY builds that write no GCS object.
 */
export async function fetchCloudBuildLog(options: CloudBuildLogOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = await options.tokenProvider.getAccessToken();
  const authHeaders = { Authorization: `Bearer ${token}` };

  const buildResponse = await fetchImpl(
    `${CLOUDBUILD_API}/projects/${encodeURIComponent(options.project)}/builds/${encodeURIComponent(options.buildId)}`,
    { headers: authHeaders },
  );
  if (!buildResponse.ok) {
    throw new CloudBuildLogUnavailableError(
      `Cloud Build builds.get failed with ${buildResponse.status} — check that the ADC ` +
        `principal has roles/cloudbuild.builds.viewer on project ${options.project}.`,
    );
  }
  const build = (await buildResponse.json()) as CloudBuildBuild;

  if (!build.logsBucket) {
    throw new CloudBuildLogUnavailableError(
      "This build stores logs in Cloud Logging only (no GCS log object); read them in the console.",
      build.logUrl,
    );
  }
  // logsBucket may be spelled gs://bucket or gs://bucket/some/prefix.
  const bucketPath = build.logsBucket.replace(/^gs:\/\//, "");
  const [bucket, ...prefixParts] = bucketPath.split("/");
  const prefix = prefixParts.length > 0 ? `${prefixParts.join("/")}/` : "";
  const objectName = encodeURIComponent(`${prefix}log-${options.buildId}.txt`);

  const logResponse = await fetchImpl(`${GCS_API}/b/${bucket}/o/${objectName}?alt=media`, {
    headers: authHeaders,
  });
  if (!logResponse.ok) {
    throw new CloudBuildLogUnavailableError(
      `Cloud Build log object gs://${bucket}/${prefix}log-${options.buildId}.txt returned ` +
        `${logResponse.status} — the ADC principal may lack roles/storage.objectViewer on the ` +
        `logs bucket, or the build writes logs elsewhere.`,
      build.logUrl,
    );
  }
  return logResponse.text();
}
