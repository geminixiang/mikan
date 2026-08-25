import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWritePrivateFile, isRecord, readJsonFileIfExists } from "../utils/file-guards.js";
import { acquireFileLease } from "../utils/file-lease.js";

const STORE_VERSION = 1;

export interface ConnectorConnectionRecord {
  connectionName: string;
  connectedAt: string;
}

interface StoreFile {
  version: number;
  /** principal (vault key) → connector service → connection record */
  principals: Record<string, Record<string, ConnectorConnectionRecord>>;
}

/**
 * Host-only mapping from a mikan principal (the run's credential
 * authorization key — see `credentialAuthorizationKey`) to its connector
 * connection names, one per connector service.
 *
 * Deliberately NOT stored in the vault: vault entries are materialized into
 * guests, while this mapping — like the connector tokens themselves — must
 * never reach a sandbox. The model never sees or supplies a connection name;
 * the host resolves it from this store only.
 */
export class ConnectorConnectionStore {
  private readonly filePath: string;
  private readonly lockPath: string;

  constructor(stateDir: string) {
    this.filePath = join(stateDir, "connector", "connections.json");
    this.lockPath = join(stateDir, "connector", ".connections.lock");
  }

  get(principalKey: string, service: string): ConnectorConnectionRecord | undefined {
    return this.read().principals[principalKey]?.[service];
  }

  list(principalKey: string): Record<string, ConnectorConnectionRecord> {
    return { ...this.read().principals[principalKey] };
  }

  set(principalKey: string, service: string, record: ConnectorConnectionRecord): void {
    this.mutate((store) => {
      const services = store.principals[principalKey] ?? {};
      services[service] = record;
      store.principals[principalKey] = services;
    });
  }

  delete(principalKey: string, service: string): void {
    this.mutate((store) => {
      const services = store.principals[principalKey];
      if (!services) return;
      delete services[service];
      if (Object.keys(services).length === 0) delete store.principals[principalKey];
    });
  }

  private read(): StoreFile {
    const parsed = readJsonFileIfExists(
      this.filePath,
      isStoreFile,
      (detail) => `Malformed connector connection store at ${this.filePath}: ${detail}`,
    );
    return parsed ?? { version: STORE_VERSION, principals: {} };
  }

  private mutate(apply: (store: StoreFile) => void): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const release = acquireFileLease(this.lockPath);
    try {
      const store = this.read();
      apply(store);
      atomicWritePrivateFile(this.filePath, `${JSON.stringify(store, null, 2)}\n`);
    } finally {
      release();
    }
  }
}

function isStoreFile(value: unknown): value is StoreFile {
  if (!isRecord(value) || value.version !== STORE_VERSION || !isRecord(value.principals)) {
    return false;
  }
  return Object.values(value.principals).every(
    (services) =>
      isRecord(services) &&
      Object.values(services).every(
        (record) => isRecord(record) && typeof record.connectionName === "string",
      ),
  );
}
