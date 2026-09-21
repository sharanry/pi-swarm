import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PROTOCOL } from "./protocol.ts";

export type PeerState = "idle" | "running" | "waiting-for-user" | "shutting-down";

export interface PeerPresence {
  protocol: typeof PROTOCOL;
  peerId: string;
  sessionId: string;
  name?: string;
  pid: number;
  cwd: string;
  swarmId: string;
  endpoint: string;
  state: PeerState;
  capabilities: string[];
  updatedAt: number;
}

export class PresenceStore {
  readonly root: string;
  readonly swarmId: string;
  readonly swarmDir: string;
  readonly peersDir: string;
  private readonly staleAfterMs: number;

  constructor(root: string, swarmId: string, options: { staleAfterMs?: number } = {}) {
    this.root = root;
    this.swarmId = swarmId;
    this.swarmDir = join(root, swarmId);
    this.peersDir = join(this.swarmDir, "peers");
    this.staleAfterMs = options.staleAfterMs ?? 15_000;
  }

  async init(): Promise<void> {
    await mkdir(this.peersDir, { recursive: true, mode: 0o700 });
    await Promise.all([chmod(this.swarmDir, 0o700), chmod(this.peersDir, 0o700)]);
  }

  pathFor(peerId: string): string {
    const safe = /^[A-Za-z0-9._-]+$/.test(peerId) ? peerId : Buffer.from(peerId).toString("base64url");
    return join(this.peersDir, `${safe}.json`);
  }

  async write(presence: PeerPresence): Promise<void> {
    if (presence.swarmId !== this.swarmId) throw new Error("Presence belongs to another swarm");
    await this.init();
    const target = this.pathFor(presence.peerId);
    const temporary = `${target}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(presence)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }

  async remove(peerId: string): Promise<void> {
    await rm(this.pathFor(peerId), { force: true });
  }

  async list(now = Date.now()): Promise<PeerPresence[]> {
    await this.init();
    const names = await readdir(this.peersDir);
    const peers: PeerPresence[] = [];
    await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      try {
        const value = JSON.parse(await readFile(join(this.peersDir, name), "utf8")) as PeerPresence;
        if (!isPresence(value) || value.swarmId !== this.swarmId) return;
        if (now - value.updatedAt > this.staleAfterMs || value.state === "shutting-down") return;
        peers.push(value);
      } catch {
        // A partially written or foreign record is not a peer.
      }
    }));
    return peers.sort((a, b) => a.peerId.localeCompare(b.peerId));
  }

  resolve(peers: PeerPresence[], target: string): PeerPresence {
    const exactPeer = peers.filter((peer) => peer.peerId === target);
    if (exactPeer.length === 1) return exactPeer[0];
    const exactSession = peers.filter((peer) => peer.sessionId === target);
    if (exactSession.length === 1) return exactSession[0];
    const short = peers.filter((peer) => peer.peerId.startsWith(target) || peer.sessionId.startsWith(target));
    if (short.length === 1) return short[0];
    const named = peers.filter((peer) => peer.name?.toLocaleLowerCase() === target.toLocaleLowerCase());
    if (named.length === 1) return named[0];
    const matches = [...new Set([...exactPeer, ...exactSession, ...short, ...named])];
    if (matches.length > 1) throw new Error(`Target "${target}" is ambiguous (${matches.map((peer) => peer.peerId).join(", ")})`);
    throw new Error(`No live swarm peer matches "${target}"`);
  }
}

export async function getOrCreateSecret(swarmDir: string): Promise<string> {
  await mkdir(swarmDir, { recursive: true, mode: 0o700 });
  const path = join(swarmDir, "secret");
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(existing)) throw new Error(`Invalid swarm secret at ${path}`);
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const secret = randomBytes(32).toString("hex");
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${secret}\n`, { mode: 0o600 });
  try {
    await link(temporary, path);
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = (await readFile(path, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(winner)) throw new Error(`Invalid swarm secret at ${path}`);
    return winner;
  } finally {
    await rm(temporary, { force: true });
  }
}

function isPresence(value: unknown): value is PeerPresence {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.protocol === PROTOCOL
    && typeof item.peerId === "string"
    && typeof item.sessionId === "string"
    && typeof item.pid === "number"
    && typeof item.cwd === "string"
    && typeof item.swarmId === "string"
    && typeof item.endpoint === "string"
    && ["idle", "running", "waiting-for-user", "shutting-down"].includes(item.state as string)
    && Array.isArray(item.capabilities)
    && typeof item.updatedAt === "number";
}
