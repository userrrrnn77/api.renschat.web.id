// tests/unit/agentLoopAllowlist.test.ts
import { describe, test, expect, beforeAll, beforeEach, mock } from "bun:test";
import { Types } from "mongoose";
import type { ToolDef } from "../../src/services/tools/registry.js";

// ── Mock provider BEFORE importing agentLoop ──────────────────────────────
let toolCallQueue: Array<{ id: string; name: string; args: string }> = [];
let runCalled = 0;

mock.module("../../src/services/llm/provider.js", () => ({
  getProvider: () => ({
    name: "mock",
    async *streamCompletion() {
      const next = toolCallQueue.shift();
      if (next) {
        yield {
          toolCalls: [
            {
              index: 0,
              id: next.id,
              function: { name: next.name, arguments: next.args },
            },
          ],
        };
        return;
      }
      yield { content: "done" };
    },
  }),
}));

// Dynamic imports so the mock applies.
const { runAgent } = await import("../../src/services/chat/agentLoop.js");
const { BlockEmitter } =
  await import("../../src/services/chat/blockEmitter.js");
const { registerTool, getTool } =
  await import("../../src/services/tools/registry.js");

const TEST_TOOL = "test_media_tool_for_allowlist";

const tool: ToolDef = {
  name: TEST_TOOL,
  kind: "media",
  description: "test",
  schema: { parse: (x: unknown) => x } as unknown as ToolDef["schema"],
  async run() {
    runCalled += 1;
    return { ok: true, content: "{}" };
  },
};

interface ToolEndCall {
  callId: string;
  ok: boolean;
  summary: string;
}

interface DriveResult {
  toolEndCalls: ToolEndCall[];
  accumulated: Array<{ id: string; name: string }>;
}

async function drive(allowed: ReadonlySet<string>): Promise<DriveResult> {
  const toolEndCalls: ToolEndCall[] = [];
  const emitter = new BlockEmitter(() => {});

  const result = await runAgent({
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    userId: new Types.ObjectId(),
    sessionId: new Types.ObjectId(),
    messageId: new Types.ObjectId(),
    model: "mock",
    reasoning: "off",
    maxTokens: 100,
    emitter,
    sseSend: () => {},
    callbacks: {
      onToolStart: () => {},
      onToolEnd: (callId, ok, summary) => {
        toolEndCalls.push({ callId, ok, summary });
      },
    },
    signal: new AbortController().signal,
    allowedTools: allowed,
    generation: {
      mode: "auto",
      imageModel: "flux2-klein",
      videoAspect: "16:9",
      videoEngine: "python",
      allowedMediaTools: allowed,
    },
  });

  return {
    toolEndCalls,
    accumulated: result.toolCalls.map((c) => ({ id: c.id, name: c.name })),
  };
}

describe("agentLoop TOOL_NOT_ALLOWED guard", () => {
  beforeAll(() => {
    if (!getTool(TEST_TOOL)) registerTool(tool);
  });

  beforeEach(() => {
    toolCallQueue = [];
    runCalled = 0;
  });

  test("media tool outside allowlist is not executed (guard fires)", async () => {
    toolCallQueue = [{ id: "call1", name: TEST_TOOL, args: "{}" }];

    const { toolEndCalls, accumulated } = await drive(new Set<string>());

    // Guard short-circuits before tool.run() — this is the whole point.
    expect(runCalled).toBe(0);

    // Model DID request the tool, and the agent accumulated it.
    expect(accumulated).toHaveLength(1);
    expect(accumulated[0].name).toBe(TEST_TOOL);
    expect(accumulated[0].id).toBe("call1");

    // Guard surfaces through onToolEnd with ok=false + TOOL_NOT_ALLOWED
    // in the summary (errorResult's content carries the code as `error`).
    expect(toolEndCalls).toHaveLength(1);
    expect(toolEndCalls[0].callId).toBe("call1");
    expect(toolEndCalls[0].ok).toBe(false);
    expect(toolEndCalls[0].summary).toContain("TOOL_NOT_ALLOWED");
  });

  test("media tool inside allowlist IS executed (positive control)", async () => {
    toolCallQueue = [{ id: "call2", name: TEST_TOOL, args: "{}" }];

    const { toolEndCalls } = await drive(new Set<string>([TEST_TOOL]));

    expect(runCalled).toBe(1);
    expect(toolEndCalls).toHaveLength(1);
    expect(toolEndCalls[0].callId).toBe("call2");
    expect(toolEndCalls[0].ok).toBe(true);
  });
});
