import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MAX_BODY_BYTES, type EnvelopeSender } from "./protocol.ts";

const BOARD_PROTOCOL = "pi-swarm-board/1" as const;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface BoardAddress {
  address: string;
  topic: string;
  conversation: string;
}

export interface BoardMessage {
  protocol: typeof BOARD_PROTOCOL;
  id: string;
  address: string;
  topic: string;
  conversation: string;
  from: EnvelopeSender;
  body: string;
  createdAt: string;
}

export interface BoardThread {
  address: string;
  topic: string;
  conversation: string;
  messages: BoardMessage[];
}

export interface BoardSummary extends BoardAddress {
  messageCount: number;
  unreadCount: number;
  updatedAt?: string;
}

interface ReadCursor {
  createdAt: string;
  idsAtTimestamp: string[];
}

export function parseBoardAddress(value: string): BoardAddress {
  const match = /^s\/([^/]+)\/([^/]+)$/.exec(value);
  if (!match || !SLUG.test(match[1]) || !SLUG.test(match[2])) {
    throw new Error(`Invalid board address "${value}"; expected s/<topic-slug>/<conv-slug>`);
  }
  return { address: value, topic: match[1], conversation: match[2] };
}

export class BoardStore {
  readonly root: string;
  readonly swarmId: string;
  readonly swarmDir: string;
  readonly boardsDir: string;
  readonly readsDir: string;

  constructor(root: string, swarmId: string) {
    this.root = root;
    this.swarmId = swarmId;
    this.swarmDir = join(root, swarmId);
    this.boardsDir = join(this.swarmDir, "boards");
    this.readsDir = join(this.swarmDir, "board-reads");
  }

  async init(): Promise<void> {
    await Promise.all([
      mkdir(this.boardsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.readsDir, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      chmod(this.swarmDir, 0o700),
      chmod(this.boardsDir, 0o700),
      chmod(this.readsDir, 0o700),
    ]);
  }

  async post(
    addressValue: string,
    from: EnvelopeSender,
    body: string,
    options: { now?: number; id?: string } = {},
  ): Promise<BoardMessage> {
    const address = parseBoardAddress(addressValue);
    if (!body) throw new Error("Board message must not be empty");
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new Error("Board message exceeds 32 KiB");
    if (!from.peerId || !from.sessionId) throw new Error("Board message requires a sender identity");
    const message: BoardMessage = {
      protocol: BOARD_PROTOCOL,
      id: options.id ?? randomUUID(),
      ...address,
      from: { peerId: from.peerId, sessionId: from.sessionId, ...(from.name ? { name: from.name } : {}) },
      body,
      createdAt: new Date(options.now ?? Date.now()).toISOString(),
    };
    const directory = this.messagesDir(address);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = `${Buffer.from(message.id).toString("base64url")}.json`;
    await writeFile(join(directory, filename), `${JSON.stringify(message)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return message;
  }

  async list(sessionId: string): Promise<BoardSummary[]> {
    const addresses = await this.addresses();
    const summaries = await Promise.all(addresses.map(async (address) => {
      const [messages, cursor] = await Promise.all([this.messages(address), this.readCursor(sessionId, address)]);
      const unread = this.afterCursor(messages, cursor).filter((message) => message.from.sessionId !== sessionId);
      return {
        ...address,
        messageCount: messages.length,
        unreadCount: unread.length,
        ...(messages.at(-1) ? { updatedAt: messages.at(-1)!.createdAt } : {}),
      };
    }));
    return summaries.sort((a, b) => a.address.localeCompare(b.address));
  }

  async read(addressValue: string, sessionId: string, options: { limit?: number } = {}): Promise<BoardMessage[]> {
    const address = parseBoardAddress(addressValue);
    const messages = await this.messages(address);
    await this.markRead(sessionId, address, messages);
    const limit = options.limit;
    return limit === undefined ? messages : messages.slice(-Math.max(0, limit));
  }

  async drainUnread(sessionId: string): Promise<BoardThread[]> {
    const addresses = await this.addresses();
    const threads: BoardThread[] = [];
    for (const address of addresses) {
      const [messages, cursor] = await Promise.all([this.messages(address), this.readCursor(sessionId, address)]);
      const unseen = this.afterCursor(messages, cursor);
      if (unseen.length === 0) continue;
      await this.markRead(sessionId, address, messages);
      const fromOthers = unseen.filter((message) => message.from.sessionId !== sessionId);
      if (fromOthers.length > 0) threads.push({ ...address, messages: fromOthers });
    }
    return threads;
  }

  private messagesDir(address: BoardAddress): string {
    return join(this.boardsDir, address.topic, address.conversation, "messages");
  }

  private async addresses(): Promise<BoardAddress[]> {
    await this.init();
    const result: BoardAddress[] = [];
    for (const topic of await readdir(this.boardsDir, { withFileTypes: true })) {
      if (!topic.isDirectory() || !SLUG.test(topic.name)) continue;
      const topicDir = join(this.boardsDir, topic.name);
      for (const conversation of await readdir(topicDir, { withFileTypes: true })) {
        if (!conversation.isDirectory() || !SLUG.test(conversation.name)) continue;
        result.push(parseBoardAddress(`s/${topic.name}/${conversation.name}`));
      }
    }
    return result.sort((a, b) => a.address.localeCompare(b.address));
  }

  private async messages(address: BoardAddress): Promise<BoardMessage[]> {
    const directory = this.messagesDir(address);
    let files: string[];
    try {
      files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const messages: BoardMessage[] = [];
    await Promise.all(files.map(async (filename) => {
      try {
        const value = JSON.parse(await readFile(join(directory, filename), "utf8"));
        if (isBoardMessage(value, address)) messages.push(value);
      } catch {
        // Ignore partial, malformed, or foreign records.
      }
    }));
    return messages.sort(compareMessages);
  }

  private cursorPath(sessionId: string, address: BoardAddress): string {
    const session = Buffer.from(sessionId).toString("base64url");
    return join(this.readsDir, session, address.topic, `${address.conversation}.json`);
  }

  private async readCursor(sessionId: string, address: BoardAddress): Promise<ReadCursor | undefined> {
    try {
      const value = JSON.parse(await readFile(this.cursorPath(sessionId, address), "utf8")) as Partial<ReadCursor>;
      if (typeof value.createdAt !== "string" || !Array.isArray(value.idsAtTimestamp)) return undefined;
      return { createdAt: value.createdAt, idsAtTimestamp: value.idsAtTimestamp.filter((id): id is string => typeof id === "string") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  private afterCursor(messages: BoardMessage[], cursor?: ReadCursor): BoardMessage[] {
    if (!cursor) return messages;
    const seenAtBoundary = new Set(cursor.idsAtTimestamp);
    return messages.filter((message) => (
      message.createdAt > cursor.createdAt
      || (message.createdAt === cursor.createdAt && !seenAtBoundary.has(message.id))
    ));
  }

  private async markRead(sessionId: string, address: BoardAddress, messages: BoardMessage[]): Promise<void> {
    const latest = messages.at(-1);
    if (!latest) return;
    const cursor: ReadCursor = {
      createdAt: latest.createdAt,
      idsAtTimestamp: messages.filter((message) => message.createdAt === latest.createdAt).map((message) => message.id),
    };
    const target = this.cursorPath(sessionId, address);
    await mkdir(join(this.readsDir, Buffer.from(sessionId).toString("base64url"), address.topic), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(cursor)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }
}

function compareMessages(a: BoardMessage, b: BoardMessage): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function isBoardMessage(value: unknown, address: BoardAddress): value is BoardMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const from = item.from as Record<string, unknown> | undefined;
  return item.protocol === BOARD_PROTOCOL
    && typeof item.id === "string"
    && item.address === address.address
    && item.topic === address.topic
    && item.conversation === address.conversation
    && typeof item.body === "string"
    && typeof item.createdAt === "string"
    && Number.isFinite(Date.parse(item.createdAt))
    && Boolean(from)
    && typeof from!.peerId === "string"
    && typeof from!.sessionId === "string"
    && (from!.name === undefined || typeof from!.name === "string");
}
