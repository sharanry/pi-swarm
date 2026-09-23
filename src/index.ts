import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { cultureName, shortIdentifier } from "./naming.ts";
import type { BoardMessage, BoardSummary, BoardThread } from "./board.ts";
import type { PeerPresence } from "./presence.ts";
import { SwarmRuntime, type SendResult, type SwarmActivity } from "./runtime.ts";

const DeliveryMode = StringEnum(["steer", "followUp"] as const);

export default function swarmExtension(pi: ExtensionAPI): void {
  let runtime: SwarmRuntime | undefined;
  let currentCtx: ExtensionContext | undefined;

  const requireRuntime = (): SwarmRuntime => {
    if (!runtime) throw new Error("Pi swarm is not ready for this session");
    return runtime;
  };

  pi.on("session_start", async (event, ctx) => {
    await runtime?.stop();
    currentCtx = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    runtime = new SwarmRuntime({
      cwd: ctx.cwd,
      sessionId,
      name: pi.getSessionName(),
      isIdle: () => currentCtx?.isIdle() ?? false,
      sendMessage: (message, options) => pi.sendMessage(message, options),
      seenIds: restoredMessageIds(ctx),
      initialActivity: restoredActivity(ctx),
      onActivity: (activity) => setSwarmStatus(ctx, sessionId, activity),
      baselineBoardsOnStart: event.reason === "new"
        || event.reason === "fork"
        || (event.reason === "startup" && ctx.sessionManager.getEntries().length === 0),
    });
    try {
      await runtime.start();
    } catch (error) {
      runtime = undefined;
      ctx.ui.setStatus("pi-swarm", "swarm: error");
      ctx.ui.notify(`Pi swarm failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    const active = runtime;
    runtime = undefined;
    currentCtx = undefined;
    await active?.stop();
  });

  pi.on("session_info_changed", async (event) => runtime?.updateName(event.name));
  pi.on("agent_start", async () => runtime?.updateState("running"));
  pi.on("agent_settled", async () => runtime?.updateState("idle"));
  pi.on("ui_prompt_start", async () => runtime?.updateState("waiting-for-user"));
  pi.on("ui_prompt_end", async (_event, ctx) => runtime?.updateState(ctx.isIdle() ? "idle" : "running"));

  pi.on("before_agent_start", async (event) => {
    if (!runtime) return;
    const peers = await runtime.listPeers().catch(() => []);
    if (peers.length === 0) return;
    const roster = peers.map((peer) => (
      `- ${cultureName(peer.sessionId)} (${shortIdentifier(peer.sessionId)}; ${peer.state})`
    )).join("\n");
    const collaboration = [
      "## Active swarm collaboration",
      "Other live sessions are working in this project:",
      roster,
      "",
      "Before changing code, use swarm_send to propose responsibilities and file and directory ownership to the relevant peers, then reach explicit consensus. An accepted delivery is not consensus; wait for and account for their replies.",
      "Only edit paths assigned to this session. If work overlaps, requirements change, or another path becomes necessary, renegotiate ownership before touching it.",
      "Use swarm_board_post for durable decisions that future or temporarily offline sessions must see. Report blockers, interface changes, and completed work so peers can coordinate safely.",
    ].join("\n");
    return { systemPrompt: `${event.systemPrompt}\n\n${collaboration}` };
  });

  pi.registerTool({
    name: "swarm_list",
    label: "Swarm Peers",
    description: "List live Pi sessions in the exact same canonical working directory.",
    promptSnippet: "List other live Pi sessions in this project",
    promptGuidelines: ["Use swarm_list before swarm_send when the intended target is unclear."],
    parameters: Type.Object({
      includeSelf: Type.Optional(Type.Boolean({ description: "Include this Pi session in the result" })),
    }),
    async execute(_toolCallId, params) {
      const peers = await requireRuntime().listPeers(params.includeSelf ?? false);
      return {
        content: [{ type: "text", text: formatPeers(peers) }],
        details: { peers },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("Swarm Peers")), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const peers = (result.details as { peers?: PeerPresence[] } | undefined)?.peers ?? [];
      if (peers.length === 0) return new Text(theme.fg("muted", "No other live peers"), 0, 0);
      const lines = peers.map((peer) => renderPeer(peer, theme, expanded));
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  pi.registerTool({
    name: "swarm_board_list",
    label: "Swarm Boards",
    description: "List persistent message boards for this working directory, including per-session unread counts.",
    promptSnippet: "List project-scoped persistent message boards and unread counts",
    promptGuidelines: ["Use swarm_board_list to discover board addresses before reading or posting when the address is unknown."],
    parameters: Type.Object({}),
    async execute() {
      const boards = await requireRuntime().listBoards();
      return {
        content: [{ type: "text", text: formatBoardSummaries(boards) }],
        details: { boards },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("Swarm Boards")), 0, 0);
    },
    renderResult(result, _options, theme) {
      const boards = (result.details as { boards?: BoardSummary[] } | undefined)?.boards ?? [];
      if (boards.length === 0) return new Text(theme.fg("muted", "No message boards"), 0, 0);
      return new Text(boards.map((board) => {
        const unread = board.unreadCount > 0 ? theme.fg("warning", `${board.unreadCount} unread`) : theme.fg("dim", "read");
        return `${theme.fg("accent", board.address)} ${theme.fg("dim", "·")} ${unread} ${theme.fg("dim", `· ${board.messageCount} total`)}`;
      }).join("\n"), 0, 0);
    },
  });

  pi.registerTool({
    name: "swarm_board_read",
    label: "Read Swarm Board",
    description: "Read and mark as read up to 200 recent messages from a project-scoped board addressed as s/<topic-slug>/<conv-slug>.",
    promptSnippet: "Read messages from a persistent project board",
    parameters: Type.Object({
      board: Type.String({ pattern: "^s/[a-z0-9]+(?:-[a-z0-9]+)*/[a-z0-9]+(?:-[a-z0-9]+)*$", description: "Board address, e.g. s/release-planning/api-review" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Most recent messages to return (default 100)" })),
    }),
    async execute(_toolCallId, params) {
      const messages = await requireRuntime().readBoard(params.board, { limit: params.limit ?? 100 });
      return {
        content: [{ type: "text", text: formatBoardMessages(params.board, messages) }],
        details: { board: params.board, messages },
      };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("Read Board"))} ${theme.fg("accent", args.board)}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as { board?: string; messages?: BoardMessage[] } | undefined;
      return new Text(renderBoardMessages(details?.board ?? "s/?/?", details?.messages ?? [], theme), 0, 0);
    },
  });

  pi.registerTool({
    name: "swarm_board_post",
    label: "Post Swarm Board",
    description: "Post a persistent message to a project-scoped board addressed as s/<topic-slug>/<conv-slug>. Active sessions and sessions opened later receive it once as unread.",
    promptSnippet: "Post a persistent message to a project board",
    promptGuidelines: ["Use swarm_board_post for durable project coordination that offline or active sessions should receive once."],
    parameters: Type.Object({
      board: Type.String({ pattern: "^s/[a-z0-9]+(?:-[a-z0-9]+)*/[a-z0-9]+(?:-[a-z0-9]+)*$", description: "Board address, e.g. s/release-planning/api-review" }),
      message: Type.String({ minLength: 1, maxLength: 32768, description: "Persistent board message" }),
    }),
    async execute(_toolCallId, params) {
      const message = await requireRuntime().postBoard(params.board, params.message);
      return {
        content: [{ type: "text", text: `posted: ${params.board} · message ${message.id}` }],
        details: { message },
      };
    },
    renderCall() {
      return new Container();
    },
    renderResult(result, _options, theme) {
      const message = (result.details as { message?: BoardMessage } | undefined)?.message;
      if (!message) return new Text(theme.fg("error", "Board post failed"), 0, 0);
      const header = theme.fg("accent", theme.bold(`board ↖ ${message.address}`));
      return new Text(`${header} ${theme.fg("dim", shortIdentifier(message.id))}\n${message.body}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "swarm_send",
    label: "Swarm Send",
    description: "Send a message to a live Pi session in this working directory. Target a peer/session ID, an unambiguous session name, or * to broadcast. The receiver is awakened when idle.",
    promptSnippet: "Send an attributed message to another live Pi session and wake it when idle",
    promptGuidelines: [
      "Use swarm_send only for useful cross-session coordination, and include enough context for the receiving session to act independently.",
      "Treat swarm_send accepted as delivery, not proof that the receiving agent completed the request.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Peer ID, session ID, unambiguous session name, or * for all peers" }),
      message: Type.String({ minLength: 1, maxLength: 32768, description: "Message for the receiving Pi session" }),
      replyTo: Type.Optional(Type.String({ description: "Message ID this responds to" })),
      delivery: Type.Optional(DeliveryMode),
    }),
    async execute(_toolCallId, params) {
      const results = await requireRuntime().send(params.to, params.message, {
        replyTo: params.replyTo,
        delivery: params.delivery,
      });
      return {
        content: [{ type: "text", text: formatResults(results) }],
        details: { results },
      };
    },
    renderCall() {
      return new Container();
    },
    renderResult(result, _options, theme, context) {
      const results = (result.details as { results?: SendResult[] } | undefined)?.results ?? [];
      const body = typeof context.args.message === "string" ? context.args.message : "";
      const blocks = results.map((item) => {
        const color = item.status === "accepted" || item.status === "duplicate" ? "success" : "warning";
        const header = theme.fg("accent", theme.bold(`swarm ↖ ${cultureName(item.sessionId)}`));
        const identifier = theme.fg("dim", shortIdentifier(item.sessionId));
        const status = theme.fg(color, item.status);
        return `${header} ${identifier} ${theme.fg("dim", "·")} ${status}\n${body}`;
      });
      return new Text(blocks.join("\n\n"), 0, 0);
    },
  });

  pi.registerCommand("swarm-board", {
    description: "List boards or read one: /swarm-board [s/<topic>/<conversation>]",
    handler: async (args, ctx) => {
      const address = args.trim();
      try {
        if (address) {
          const messages = await requireRuntime().readBoard(address, { limit: 100 });
          ctx.ui.notify(renderBoardMessages(address, messages, ctx.ui.theme), "info");
        } else {
          const boards = await requireRuntime().listBoards();
          ctx.ui.notify(formatBoardSummaries(boards), "info");
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("swarm-post", {
    description: "Post to a board: /swarm-post s/<topic>/<conversation> <message>",
    handler: async (args, ctx) => {
      const match = args.trim().match(/^(s\/[^/\s]+\/[^/\s]+)\s+([\s\S]+)$/);
      if (!match) {
        ctx.ui.notify("Usage: /swarm-post s/<topic>/<conversation> <message>", "warning");
        return;
      }
      try {
        const message = await requireRuntime().postBoard(match[1], match[2]);
        ctx.ui.notify(`Posted to ${message.address}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("swarm", {
    description: "List live Pi sessions in this working directory",
    handler: async (_args, ctx) => {
      const peers = await requireRuntime().listPeers();
      const text = peers.length === 0
        ? "No other live Pi sessions in this working directory."
        : peers.map((peer) => renderPeer(peer, ctx.ui.theme, false)).join("\n");
      ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("swarm-status", {
    description: "Show this session's swarm identity and transport state",
    handler: async (_args, ctx) => {
      const active = requireRuntime();
      const identity = active.ownIdentity;
      const peers = await active.listPeers();
      const alias = ctx.ui.theme.fg("accent", ctx.ui.theme.bold(cultureName(identity.sessionId)));
      const identifiers = ctx.ui.theme.fg("dim", `${shortIdentifier(identity.sessionId)} · swarm ${identity.swarmId.slice(0, 12)}`);
      ctx.ui.notify(`${alias} · ${identifiers} · ${peers.length} live peer(s)`, "info");
    },
  });

  pi.registerCommand("swarm-send", {
    description: "Send to a peer: /swarm-send <target> <message>",
    handler: async (args, ctx) => {
      const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
      if (!match) {
        ctx.ui.notify("Usage: /swarm-send <target> <message>", "warning");
        return;
      }
      try {
        const results = await requireRuntime().send(match[1], match[2]);
        ctx.ui.notify(formatResults(results), results.every((item) => item.status === "accepted" || item.status === "duplicate") ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerMessageRenderer("swarm:board", (message, options, theme) => {
    const thread = (message.details as { thread?: BoardThread } | undefined)?.thread;
    if (!thread) return new Text(textContent(message.content), options.outputPad, 0);
    const count = thread.messages.length;
    const header = `${theme.fg("accent", theme.bold(`board ↙ ${thread.address}`))} ${theme.fg("dim", `· ${count} unread`)}`;
    return new Text(`${header}\n${renderBoardMessages(thread.address, thread.messages, theme, false)}`, options.outputPad, 0);
  });

  pi.registerMessageRenderer("swarm:message", (message, options, theme) => {
    const details = message.details as { envelope?: { from?: { sessionId?: string }; id?: string; body?: string; replyTo?: string } } | undefined;
    const envelope = details?.envelope;
    const sessionId = envelope?.from?.sessionId;
    const sender = sessionId ? cultureName(sessionId) : "Unknown Peer";
    const identifier = sessionId ? shortIdentifier(sessionId) : "????????";
    const body = envelope?.body || textContent(message.content);
    const messageId = options.expanded && envelope?.id ? theme.fg("dim", ` · message ${shortIdentifier(envelope.id)}`) : "";
    const reply = envelope?.replyTo ? theme.fg("dim", `\n↳ reply to ${shortIdentifier(envelope.replyTo)}`) : "";
    const header = `${theme.fg("accent", theme.bold(`swarm ↙ ${sender}`))} ${theme.fg("dim", identifier)}${messageId}`;
    return new Text(`${header}\n${body}${reply}`, options.outputPad, 0);
  });
}

function setSwarmStatus(ctx: ExtensionContext, sessionId: string, activity: SwarmActivity): void {
  ctx.ui.setStatus("pi-swarm", `${cultureName(sessionId)} ↑${activity.outgoing} ↓${activity.incoming}`);
}

function restoredActivity(ctx: ExtensionContext): SwarmActivity {
  const activity: SwarmActivity = { incoming: 0, outgoing: 0 };
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom_message" && entry.customType === "swarm:message") {
      activity.incoming += 1;
      continue;
    }
    if (entry.type === "custom_message" && entry.customType === "swarm:board") {
      const details = entry.details as { thread?: { messages?: unknown[] } } | undefined;
      activity.incoming += details?.thread?.messages?.length ?? 0;
      continue;
    }
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    if (entry.message.toolName === "swarm_send") {
      const details = entry.message.details as { results?: unknown[] } | undefined;
      activity.outgoing += details?.results?.length ?? 0;
    } else if (entry.message.toolName === "swarm_board_post") {
      const details = entry.message.details as { message?: unknown } | undefined;
      if (details?.message) activity.outgoing += 1;
    }
  }
  return activity;
}

function restoredMessageIds(ctx: ExtensionContext): string[] {
  const ids: string[] = [];
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom_message" || entry.customType !== "swarm:message") continue;
    const details = entry.details as { envelope?: { id?: unknown } } | undefined;
    if (typeof details?.envelope?.id === "string") ids.push(details.envelope.id);
  }
  return ids;
}

function formatPeers(peers: PeerPresence[]): string {
  if (peers.length === 0) return "No other live Pi sessions in this working directory.";
  return peers.map((peer) => (
    `${cultureName(peer.sessionId)} · ${shortIdentifier(peer.sessionId)} · ${peer.state} · peer ${peer.peerId}`
  )).join("\n");
}

function formatResults(results: SendResult[]): string {
  return results.map((result) => {
    const note = result.message ? ` (${result.message})` : "";
    return `${result.status}: ${cultureName(result.sessionId)} · ${shortIdentifier(result.sessionId)} · message ${result.id}${note}`;
  }).join("\n");
}

function formatBoardSummaries(boards: BoardSummary[]): string {
  if (boards.length === 0) return "No message boards in this working directory.";
  return boards.map((board) => `${board.address} · ${board.unreadCount} unread · ${board.messageCount} total`).join("\n");
}

function formatBoardMessages(address: string, messages: BoardMessage[]): string {
  if (messages.length === 0) return `${address}: no messages`;
  const entries = messages.map((message) => (
    `[${cultureName(message.from.sessionId)} · ${shortIdentifier(message.from.sessionId)} · ${message.createdAt}]\n${message.body}`
  ));
  return `${address}\n${entries.join("\n\n")}`;
}

function renderBoardMessages(
  address: string,
  messages: BoardMessage[],
  theme: { fg: (color: any, text: string) => string; bold: (text: string) => string },
  includeAddress = true,
): string {
  if (messages.length === 0) return theme.fg("muted", `${address}: no messages`);
  const entries = messages.map((message) => {
    const sender = theme.fg("accent", theme.bold(cultureName(message.from.sessionId)));
    const identifier = theme.fg("dim", shortIdentifier(message.from.sessionId));
    const timestamp = theme.fg("dim", `· ${message.createdAt}`);
    return `${sender} ${identifier} ${timestamp}\n${message.body}`;
  }).join("\n\n");
  return includeAddress ? `${theme.fg("accent", theme.bold(address))}\n${entries}` : entries;
}

function renderPeer(
  peer: PeerPresence,
  theme: { fg: (color: any, text: string) => string; bold: (text: string) => string },
  expanded: boolean,
): string {
  const alias = theme.fg("accent", theme.bold(cultureName(peer.sessionId)));
  const identifier = theme.fg("dim", shortIdentifier(peer.sessionId));
  const state = theme.fg("muted", peer.state);
  const fullId = expanded ? theme.fg("dim", ` · peer ${peer.peerId}`) : "";
  return `${alias} ${identifier} · ${state}${fullId}`;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((item): item is { type: "text"; text: string } => (
    Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string"
  )).map((item) => item.text).join("\n");
}
