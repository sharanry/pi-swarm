import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DeliveryAck, SwarmEnvelope } from "./protocol.ts";
import { LocalTransport } from "./transport.ts";

export interface DeliveryPeer {
  peerId: string;
  endpoint: string;
}

export class DeliveryManager {
  private readonly options: { root: string; swarmId: string; secret: string };

  constructor(options: { root: string; swarmId: string; secret: string }) {
    this.options = options;
  }

  async deliver(peer: DeliveryPeer, envelope: SwarmEnvelope, options: { timeoutMs?: number } = {}): Promise<DeliveryAck> {
    const spool = await this.writeSpool(peer.peerId, envelope);
    try {
      const ack = await LocalTransport.send(peer.endpoint, this.options.secret, envelope, options);
      await rm(spool, { force: true });
      return ack;
    } catch (error) {
      return { status: "queued", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async retry(peer: DeliveryPeer, options: { timeoutMs?: number } = {}): Promise<DeliveryAck[]> {
    const envelopes = await this.listSpool(peer.peerId);
    const results: DeliveryAck[] = [];
    for (const envelope of envelopes) results.push(await this.deliver(peer, envelope, options));
    return results;
  }

  async listSpool(peerId: string): Promise<SwarmEnvelope[]> {
    const directory = this.spoolDir(peerId);
    try {
      const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
      const values: SwarmEnvelope[] = [];
      for (const name of names) {
        try { values.push(JSON.parse(await readFile(join(directory, name), "utf8")) as SwarmEnvelope); } catch { /* ignore invalid spool */ }
      }
      return values;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private spoolDir(peerId: string): string {
    const safe = Buffer.from(peerId).toString("base64url");
    return join(this.options.root, this.options.swarmId, "outbox", safe);
  }

  private async writeSpool(peerId: string, envelope: SwarmEnvelope): Promise<string> {
    const directory = this.spoolDir(peerId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, `${envelope.id}.json`);
    const temporary = `${target}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    await rename(temporary, target);
    return target;
  }
}
