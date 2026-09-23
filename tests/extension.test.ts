import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BoardStore } from "../src/board.ts";
import { createIdentity } from "../src/identity.ts";
import swarmExtension from "../src/index.ts";
import { cultureName, shortIdentifier } from "../src/naming.ts";

test("extension registers tools and delivers between two Pi session facades", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-extension-"));
  const cwd = join(root, "project");
  await mkdir(cwd);
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldRoot = process.env.PI_SWARM_DIR;
  process.env.PI_SWARM_DIR = join(root, "state");
  t.after(() => {
    if (oldRoot === undefined) delete process.env.PI_SWARM_DIR;
    else process.env.PI_SWARM_DIR = oldRoot;
  });

  const seedIdentity = await createIdentity(cwd, "seed-session");
  const seedBoards = new BoardStore(join(root, "state"), seedIdentity.swarmId);
  await seedBoards.post("s/release/api", { peerId: "seed-peer", sessionId: "seed-session" }, "historical update");

  const a = fakePi("Alpha");
  const b = fakePi("Beta");
  swarmExtension(a.api);
  swarmExtension(b.api);
  const sessionA = "01a0c41e-b9ed-74fb-b71d-c4cf7b89237a";
  const sessionB = "01a0c41e-ef90-70de-9156-11f19214cb24";
  const ctxA = fakeContext(cwd, sessionA);
  const ctxB = fakeContext(cwd, sessionB);
  t.after(async () => {
    await a.emit("session_shutdown", { reason: "quit" }, ctxA);
    await b.emit("session_shutdown", { reason: "quit" }, ctxB);
  });
  await a.emit("session_start", { reason: "startup" }, ctxA);
  await b.emit("session_start", { reason: "startup" }, ctxB);
  assert.equal(ctxA.statuses.get("pi-swarm"), `${cultureName(sessionA)} ↑0 ↓0`);
  assert.equal(ctxB.statuses.get("pi-swarm"), `${cultureName(sessionB)} ↑0 ↓0`);
  const coordinatedPrompt = await a.emit("before_agent_start", { systemPrompt: "base prompt" }, ctxA);
  assert.match(coordinatedPrompt.systemPrompt, /Active swarm collaboration/);
  assert.match(coordinatedPrompt.systemPrompt, new RegExp(cultureName(sessionB)));
  assert.match(coordinatedPrompt.systemPrompt, /reach explicit consensus/i);
  assert.match(coordinatedPrompt.systemPrompt, /file and directory ownership/i);
  assert.match(coordinatedPrompt.systemPrompt, /only edit paths assigned/i);

  assert.deepEqual([...a.tools.keys()].sort(), [
    "swarm_board_list",
    "swarm_board_post",
    "swarm_board_read",
    "swarm_list",
    "swarm_send",
  ]);
  const list = await a.tools.get("swarm_list")!.execute("call-list", {}, undefined, undefined, ctxA);
  assert.match(list.content[0].text, new RegExp(cultureName(sessionB)));
  assert.match(list.content[0].text, new RegExp(shortIdentifier(sessionB)));
  const renderedList = a.tools.get("swarm_list")!.renderResult(
    list,
    { expanded: false, isPartial: false },
    fakeTheme,
  ).render(200).join("\n");
  assert.match(renderedList, new RegExp(cultureName(sessionB)));
  assert.match(renderedList, new RegExp(`<dim>${shortIdentifier(sessionB)}</dim>`));
  const sent = await a.tools.get("swarm_send")!.execute(
    "call-send",
    { to: "Beta", message: "coordinate this" },
    undefined,
    undefined,
    ctxA,
  );
  assert.match(sent.content[0].text, /accepted/);
  assert.equal(ctxA.statuses.get("pi-swarm"), `${cultureName(sessionA)} ↑1 ↓0`);
  assert.equal(ctxB.statuses.get("pi-swarm"), `${cultureName(sessionB)} ↑0 ↓1`);
  const outgoingCall = a.tools.get("swarm_send")!.renderCall(
    { to: "Beta", message: "coordinate this" },
    fakeTheme,
  ).render(200).join("\n");
  assert.equal(outgoingCall, "");
  const outgoing = a.tools.get("swarm_send")!.renderResult(
    sent,
    { expanded: false, isPartial: false },
    fakeTheme,
    { args: { to: "Beta", message: "coordinate this" } },
  ).render(200).join("\n");
  assert.match(outgoing, /swarm ↖/);
  assert.match(outgoing, new RegExp(cultureName(sessionB)));
  assert.match(outgoing, /coordinate this/);
  assert.equal(b.messages.length, 1);
  assert.match(b.messages[0].message.content, /coordinate this/);
  assert.deepEqual(b.messages[0].options, { triggerTurn: true });

  const renderer = b.messageRenderers.get("swarm:message")!;
  const rendered = renderer(
    b.messages[0].message,
    { expanded: false, outputPad: 0 },
    fakeTheme,
  ).render(200).join("\n");
  assert.match(rendered, /swarm ↙/);
  assert.match(rendered, new RegExp(cultureName(sessionA)));
  assert.match(rendered, new RegExp(`<dim>${shortIdentifier(sessionA)}</dim>`));

  const posted = await a.tools.get("swarm_board_post")!.execute(
    "call-post",
    { board: "s/release/api", message: "durable update" },
    undefined,
    undefined,
    ctxA,
  );
  assert.equal(ctxA.statuses.get("pi-swarm"), `${cultureName(sessionA)} ↑2 ↓0`);
  const renderedPost = a.tools.get("swarm_board_post")!.renderResult(
    posted,
    { expanded: false, isPartial: false },
    fakeTheme,
  ).render(200).join("\n");
  assert.match(renderedPost, /board ↖ s\/release\/api/);
  assert.match(renderedPost, /durable update/);

  const boards = await b.tools.get("swarm_board_list")!.execute("call-boards", {}, undefined, undefined, ctxB);
  assert.match(boards.content[0].text, /s\/release\/api · 1 unread/);
  const read = await b.tools.get("swarm_board_read")!.execute(
    "call-read-board",
    { board: "s/release/api" },
    undefined,
    undefined,
    ctxB,
  );
  assert.match(read.content[0].text, /durable update/);
  assert.match(read.content[0].text, new RegExp(cultureName(sessionA)));

  const boardRenderer = b.messageRenderers.get("swarm:board")!;
  const boardNotice = boardRenderer(
    { content: "", details: { thread: { address: "s/release/api", topic: "release", conversation: "api", messages: [posted.details.message] } } },
    { expanded: false, outputPad: 0 },
    fakeTheme,
  ).render(200).join("\n");
  assert.match(boardNotice, /board ↙ s\/release\/api/);
  assert.match(boardNotice, new RegExp(cultureName(sessionA)));
  assert.match(boardNotice, new RegExp(`<dim>${shortIdentifier(sessionA)}</dim>`));
});

test("compact swarm status restores session activity counts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-extension-status-"));
  const cwd = join(root, "project");
  await mkdir(cwd);
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldRoot = process.env.PI_SWARM_DIR;
  process.env.PI_SWARM_DIR = join(root, "state");
  t.after(() => {
    if (oldRoot === undefined) delete process.env.PI_SWARM_DIR;
    else process.env.PI_SWARM_DIR = oldRoot;
  });

  const sessionId = "01a0c41e-b9ed-74fb-b71d-c4cf7b89237a";
  const entries = [
    { type: "custom_message", customType: "swarm:message", details: {} },
    { type: "custom_message", customType: "swarm:board", details: { thread: { messages: [{}, {}] } } },
    { type: "message", message: { role: "toolResult", toolName: "swarm_send", details: { results: [{}, {}] } } },
    { type: "message", message: { role: "toolResult", toolName: "swarm_board_post", details: { message: {} } } },
  ];
  const pi = fakePi("Alpha");
  swarmExtension(pi.api);
  const ctx = fakeContext(cwd, sessionId, entries);
  t.after(() => pi.emit("session_shutdown", { reason: "quit" }, ctx));
  await pi.emit("session_start", { reason: "startup" }, ctx);

  assert.equal(ctx.statuses.get("pi-swarm"), `${cultureName(sessionId)} ↑3 ↓3`);
  assert.equal(await pi.emit("before_agent_start", { systemPrompt: "base prompt" }, ctx), undefined);
});

function fakePi(name: string) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const tools = new Map<string, any>();
  const messages: Array<{ message: any; options: any }> = [];
  const messageRenderers = new Map<string, any>();
  const api = {
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    registerMessageRenderer(type: string, renderer: any) { messageRenderers.set(type, renderer); },
    getSessionName() { return name; },
    sendMessage(message: any, options: any) { messages.push({ message, options }); },
  } as any;
  return {
    api,
    tools,
    messages,
    messageRenderers,
    async emit(event: string, payload: any, ctx: any) {
      let result: any;
      for (const handler of handlers.get(event) ?? []) {
        const value = await handler(payload, ctx);
        if (value !== undefined) result = value;
      }
      return result;
    },
  };
}

const fakeTheme = {
  fg(color: string, text: string) { return `<${color}>${text}</${color}>`; },
  bold(text: string) { return `<bold>${text}</bold>`; },
};

function fakeContext(cwd: string, sessionId: string, entries: any[] = []) {
  const statuses = new Map<string, string | undefined>();
  return {
    cwd,
    statuses,
    isIdle: () => true,
    ui: {
      setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
      notify() {},
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => entries,
    },
  } as any;
}
