export class SandboxError extends Error {
  readonly details: string[];

  constructor(message: string, details?: string[]) {
    super(message);
    this.name = "SandboxError";
    this.details = details ?? [];
  }

  formatForCli(): string[] {
    return [this.message, ...this.details];
  }
}
