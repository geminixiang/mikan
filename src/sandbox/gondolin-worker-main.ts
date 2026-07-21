// Entry point for the detached Gondolin worker process. Spawned by mikan with
// one JSON argv (the GondolinWorkerConfig); survives the spawning mikan so the
// VM keeps running across mikan restarts and deploys.
import { runGondolinWorker, type GondolinWorkerConfig } from "./gondolin-worker.js";

// The spawning mikan may be gone when we write; a broken pipe must not crash
// a worker that is otherwise healthy.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

let config: GondolinWorkerConfig;
try {
  config = JSON.parse(process.argv[2] ?? "") as GondolinWorkerConfig;
} catch {
  process.stdout.write(JSON.stringify({ ready: false, error: "invalid worker config" }) + "\n");
  process.exit(2);
}

runGondolinWorker(config).catch((err: unknown) => {
  const error = err instanceof Error ? err.message : String(err);
  process.stdout.write(JSON.stringify({ ready: false, error }) + "\n");
  process.exit(1);
});
