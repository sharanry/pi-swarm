import { createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";

export interface SwarmIdentity {
  cwd: string;
  swarmId: string;
  sessionId: string;
  peerId: string;
  name?: string;
  pid: number;
}

export async function createIdentity(
  cwd: string,
  sessionId: string,
  name?: string,
  pid = process.pid,
): Promise<SwarmIdentity> {
  const canonicalCwd = await realpath(cwd);
  const swarmId = createHash("sha256").update(canonicalCwd).digest("hex");
  const nonce = randomBytes(4).toString("hex");
  return {
    cwd: canonicalCwd,
    swarmId,
    sessionId,
    peerId: `${sessionId}-${pid}-${nonce}`,
    name: name || undefined,
    pid,
  };
}
