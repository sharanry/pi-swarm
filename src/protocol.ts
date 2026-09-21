import { randomUUID } from "node:crypto";

export const PROTOCOL = "pi-swarm/1" as const;
export const MAX_BODY_BYTES = 32 * 1024;
export const DEFAULT_TTL_MS = 5 * 60_000;

export interface EnvelopeSender {
  peerId: string;
  sessionId: string;
  name?: string;
}

export interface SwarmEnvelope {
  protocol: typeof PROTOCOL;
  id: string;
  swarmId: string;
  kind: "message";
  from: EnvelopeSender;
  to: string;
  body: string;
  replyTo?: string;
  delivery: "steer" | "followUp";
  createdAt: string;
  ttlMs: number;
}

export interface DeliveryAck {
  status: "accepted" | "duplicate" | "queued" | "rejected";
  message?: string;
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function createEnvelope(input: {
  swarmId: string;
  from: EnvelopeSender;
  to: string;
  body: string;
  replyTo?: string;
  delivery?: "steer" | "followUp";
  ttlMs?: number;
  now?: number;
  id?: string;
}): SwarmEnvelope {
  return parseEnvelope({
    protocol: PROTOCOL,
    id: input.id ?? randomUUID(),
    swarmId: input.swarmId,
    kind: "message",
    from: input.from,
    to: input.to,
    body: input.body,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    delivery: input.delivery ?? "steer",
    createdAt: new Date(input.now ?? Date.now()).toISOString(),
    ttlMs: input.ttlMs ?? DEFAULT_TTL_MS,
  }, { now: input.now });
}

export function parseEnvelope(value: unknown, options: { now?: number } = {}): SwarmEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProtocolError("Envelope must be an object");
  const item = value as Record<string, unknown>;
  if (item.protocol !== PROTOCOL) throw new ProtocolError("Unsupported swarm protocol");
  if (item.kind !== "message") throw new ProtocolError("Unsupported envelope kind");
  for (const field of ["id", "swarmId", "to", "body", "createdAt"] as const) {
    if (typeof item[field] !== "string" || item[field].length === 0) throw new ProtocolError(`Invalid ${field}`);
  }
  if (!/^[a-f0-9]{64}$/.test(item.swarmId as string)) throw new ProtocolError("Invalid swarmId");
  if (Buffer.byteLength(item.body as string, "utf8") > MAX_BODY_BYTES) throw new ProtocolError("Message body exceeds 32 KiB");
  if (!item.from || typeof item.from !== "object" || Array.isArray(item.from)) throw new ProtocolError("Invalid sender");
  const from = item.from as Record<string, unknown>;
  if (typeof from.peerId !== "string" || !from.peerId || typeof from.sessionId !== "string" || !from.sessionId) {
    throw new ProtocolError("Invalid sender identity");
  }
  if (from.name !== undefined && typeof from.name !== "string") throw new ProtocolError("Invalid sender name");
  if (item.replyTo !== undefined && (typeof item.replyTo !== "string" || !item.replyTo)) throw new ProtocolError("Invalid replyTo");
  if (item.delivery !== "steer" && item.delivery !== "followUp") throw new ProtocolError("Invalid delivery mode");
  if (!Number.isInteger(item.ttlMs) || (item.ttlMs as number) <= 0 || (item.ttlMs as number) > 24 * 60 * 60_000) {
    throw new ProtocolError("Invalid ttlMs");
  }
  const created = Date.parse(item.createdAt as string);
  if (!Number.isFinite(created)) throw new ProtocolError("Invalid createdAt");
  const now = options.now ?? Date.now();
  if (now > created + (item.ttlMs as number)) throw new ProtocolError("Envelope expired");
  return item as unknown as SwarmEnvelope;
}
