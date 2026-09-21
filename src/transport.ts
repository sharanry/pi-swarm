import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { type DeliveryAck, parseEnvelope, type SwarmEnvelope } from "./protocol.ts";

const MAX_FRAME_BYTES = 64 * 1024;

interface WireFrame {
  envelope: SwarmEnvelope;
  auth: string;
}

export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

export class LocalTransport {
  private server?: Server;
  private readonly options: { endpoint: string; secret: string; swarmId: string; peerId: string };

  constructor(options: { endpoint: string; secret: string; swarmId: string; peerId: string }) {
    this.options = options;
  }

  static endpointFor(root: string, swarmId: string, peerId: string): string {
    const key = createHash("sha256").update(`${root}\0${swarmId}\0${peerId}`).digest("hex").slice(0, 32);
    if (process.platform === "win32") return `\\\\.\\pipe\\pi-swarm-${key}`;
    const uid = typeof process.getuid === "function" ? process.getuid() : process.pid;
    return join(tmpdir(), `pi-swarm-${uid}`, `${key}.sock`);
  }

  async listen(handler: (envelope: SwarmEnvelope) => Promise<DeliveryAck>): Promise<void> {
    if (this.server) return;
    if (process.platform !== "win32") {
      await mkdir(dirname(this.options.endpoint), { recursive: true, mode: 0o700 });
      await rm(this.options.endpoint, { force: true });
    }
    this.server = createServer((socket) => this.handleSocket(socket, handler));
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.endpoint);
    });
    if (process.platform !== "win32") await chmod(this.options.endpoint, 0o600);
  }

  private handleSocket(socket: Socket, handler: (envelope: SwarmEnvelope) => Promise<DeliveryAck>): void {
    let buffer = Buffer.alloc(0);
    let done = false;
    const respond = (ack: DeliveryAck) => {
      if (done) return;
      done = true;
      socket.end(`${JSON.stringify(ack)}\n`);
    };
    socket.on("data", (chunk: Buffer) => {
      if (done) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) {
        respond({ status: "rejected", message: "Frame exceeds 64 KiB" });
        return;
      }
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      void (async () => {
        try {
          const frame = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as WireFrame;
          if (!frame || typeof frame !== "object" || !verify(this.options.secret, frame.envelope, frame.auth)) {
            throw new TransportError("Message authentication failed");
          }
          const envelope = parseEnvelope(frame.envelope);
          if (envelope.swarmId !== this.options.swarmId) throw new TransportError("Message belongs to another swarm");
          if (envelope.to !== this.options.peerId) throw new TransportError("Message addressed to another peer");
          respond(await handler(envelope));
        } catch (error) {
          respond({ status: "rejected", message: error instanceof Error ? error.message : String(error) });
        }
      })();
    });
    socket.on("error", () => { done = true; });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32") await rm(this.options.endpoint, { force: true });
  }

  static async send(endpoint: string, secret: string, envelope: SwarmEnvelope, options: { timeoutMs?: number } = {}): Promise<DeliveryAck> {
    const frame: WireFrame = { envelope, auth: sign(secret, envelope) };
    return this.sendRaw(endpoint, `${JSON.stringify(frame)}\n`, options);
  }

  static async sendRaw(endpoint: string, frame: string, options: { timeoutMs?: number } = {}): Promise<DeliveryAck> {
    return new Promise<DeliveryAck>((resolve, reject) => {
      const socket = createConnection(endpoint);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new TransportError("Delivery timed out"));
      }, options.timeoutMs ?? 2_000);
      let buffer = "";
      let settled = false;
      const finish = (error?: unknown, ack?: DeliveryAck) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        if (error) reject(error instanceof TransportError ? error : new TransportError(error instanceof Error ? error.message : String(error)));
        else resolve(ack!);
      };
      socket.on("connect", () => socket.write(frame));
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) return finish(new TransportError("Response frame exceeds 64 KiB"));
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const ack = JSON.parse(buffer.slice(0, newline)) as DeliveryAck;
          if (!ack || !["accepted", "duplicate", "queued", "rejected"].includes(ack.status)) throw new Error("Invalid acknowledgement");
          if (ack.status === "rejected") return finish(new TransportError(ack.message || "Delivery rejected"));
          finish(undefined, ack);
        } catch (error) {
          finish(error);
        }
      });
      socket.on("error", (error) => finish(error));
      socket.on("close", () => {
        if (!settled) finish(new TransportError("Connection closed without acknowledgement"));
      });
    });
  }
}

function sign(secret: string, envelope: SwarmEnvelope): string {
  return createHmac("sha256", secret).update(JSON.stringify(envelope)).digest("hex");
}

function verify(secret: string, envelope: SwarmEnvelope, signature: unknown): boolean {
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = Buffer.from(sign(secret, envelope), "hex");
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
