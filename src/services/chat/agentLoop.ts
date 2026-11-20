// src/services/chat/agentLoop.ts

import { Types } from "mongoose";
import {
  type ChatMessage,
  type Usage,
  type ToolDefinition,
  UpstreamError,
} from "../llm/nvidiaClient.js";
import { FenceParser } from "../llm/fenceParser.js";
import type { Block } from "../blocks/schemas.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { BlockEmitter } from "./blockEmitter.js";
import {
  StreamingResponseSanitizer,
  sanitizeFinalText,
} from "./responseSanitizer.js";
import type { ClarificationQuestion } from "../orchestrator/clarification.js";
import {
  ClarificationTimeoutError,
  ClarificationAbortedError,
} from "../orchestrator/clarificationStore.js";
import {
  getTool,
  errorResult,
  listToolNames,
  type ToolContext,
  type ToolResult,
  type ToolDef,
} from "../tools/registry.js";
import type { GenerationPlan } from "../generation/plan.js";
import { getProvider, type ReasoningEffort } from "../llm/provider.js";
import { classifyProviderError } from "../llm/errorClassify.js";
import { createThinkingForwarder } from "./thinkingStream.js";
import { makePublicLineFilter } from "./publicProse.js";
import type { FileAction } from "./fileIntent.js";

export interface AgentCallbacks {
  onToolStart: (callId: string, name: string) => void;
  onToolEnd: (callId: string, ok: boolean, summary: string) => void;
}

export interface AgentInput {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  messageId: Types.ObjectId;
  model: string;
  reasoning: ReasoningEffort;
  maxTokens: number;
  emitter: BlockEmitter;
  sseSend: (event: string, data: unknown) => void;
  callbacks: AgentCallbacks;
  signal: AbortSignal;
  /** Allowlist tool media untuk turn ini (tool non-media selalu boleh, §8.5). */
  allowedTools: ReadonlySet<string>;
  /** Plan generation turn ini; diteruskan ke ToolContext. */
  generation: GenerationPlan;
  resolveMediaAspect?: (
    kind: "image" | "video",
  ) => Promise<"1:1" | "16:9" | "9:16">;
  askClarification?: (q: ClarificationQuestion) => Promise<string[]>;
  fileAction?: FileAction;
  terminalIntent?: string;
}

export interface AgentResult {
  blocks: Block[];
  toolCalls: Array<{ id: string; name: string; argsJson: string }>;
  usage?: Usage;
  aborted: boolean;
  truncated: boolean;
  error?: string;
  /** Kode error publik (PROVIDER_ERROR, RATE_LIMITED, dst). */
  errorCode?: string;
  endTurnByChoices: boolean;
}
interface PartialToolCall {
  id?: string;
  name?: string;
  args: string;
}

const MAX_ITER = env.MAX_TOOL_ITERATIONS;
const MAX_ARG_REPAIR = 2;

function accumulate(
  acc: Map<number, PartialToolCall>,
  list: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>,
): void {
  for (const tc of list) {
    const cur = acc.get(tc.index) ?? { args: "" };
    if (tc.id) cur.id = tc.id;
    if (tc.function?.name) cur.name = tc.function.name;
    if (tc.function?.arguments) cur.args += tc.function.arguments;
    acc.set(tc.index, cur);
  }
}

function finalize(
  acc: Map<number, PartialToolCall>,
): Array<{ id: string; name: string; args: string }> {
  const out: Array<{ id: string; name: string; args: string }> = [];
  for (const [, v] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!v.id || !v.name) continue;
    out.push({ id: v.id, name: v.name, args: v.args });
  }
  return out;
}

async function executeWithRepair(
  tool: ToolDef,
  argsStr: string,
  ctx: ToolContext,
  fileAction?: FileAction,
  resolveMediaAspect?: AgentInput["resolveMediaAspect"],
): Promise<ToolResult> {
  // Tidak ada retry args yang sama: kalau tool.run side-effect (R2/DB)
  // sukses tapi langkah berikutnya gagal, retry bikin orphan. Model
  // yang akan retry di iterasi berikut via loop utama.
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsStr || "{}");
  } catch (e) {
    return errorResult(
      "INVALID_JSON",
      `Args bukan JSON valid: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    if (
      fileAction === "create_file" &&
      tool.name === "create_file" &&
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return await tool.run({ ...parsed, present: true }, ctx);
    }

    if (tool.kind === "media") {
      if (
        !resolveMediaAspect ||
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        return errorResult(
          "INVALID_ARGS",
          "Tidak dapat menentukan format media.",
        );
      }

      const kind = tool.name === "generate_image" ? "image" : "video";
      const aspect = await resolveMediaAspect(kind);

      if (ctx.abortSignal.aborted) {
        throw new ClarificationAbortedError();
      }

      return await tool.run({ ...parsed, aspect_ratio: aspect }, ctx);
    }

    return await tool.run(parsed, ctx);
  } catch (err) {
    // Error klarifikasi harus propagate ke agentLoop (bukan diubah jadi
    // tool error) — agar turn bisa diakhiri / di-abort dengan benar.
    if (
      err instanceof ClarificationTimeoutError ||
      err instanceof ClarificationAbortedError
    ) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult("INVALID_ARGS", `Args tidak sesuai schema: ${msg}`, {
      tool: tool.name,
    });
  }
}

function commandFailureCode(code: string | undefined): string {
  switch (code) {
    case "INVALID_ARGS":
    case "INVALID_JSON":
    case "INVALID_EXPRESSION":
      return "COMMAND_INVALID_INPUT";
    case "TIMEOUT":
      return "COMMAND_TIMEOUT";
    case "RATE_LIMIT":
      return "COMMAND_RATE_LIMIT";
    case "COMMAND_NOT_ALLOWED":
      return "COMMAND_NOT_ALLOWED";
    default:
      return "COMMAND_FAILED";
  }
}

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const emitter = input.emitter;
  const accumulatedToolCalls: Array<{
    id: string;
    name: string;
    argsJson: string;
  }> = [];
  let usage: Usage | undefined;
  let aborted = false;
  let error: string | undefined;
  let errorCode: string | undefined;
  let truncated = false;
  let endTurnByChoices = false;
  let natural = false;

  const workingMessages: ChatMessage[] = [...input.messages];
  let currentTools = input.fileAction
    ? input.tools.filter((tool) => tool.function.name === input.fileAction)
    : input.tools;

  const fileBlockCountAtStart = emitter.blocks.filter(
    (block) => block.type === "file",
  ).length;

  const provider = getProvider();

  agentIterations: for (let iter = 0; iter < MAX_ITER; iter++) {
    const terminalFirstStep = iter === 0 && Boolean(input.terminalIntent);
    const requiredTool =
      input.fileAction ?? (terminalFirstStep ? "run_command" : undefined);
    if (input.signal.aborted) {
      aborted = true;
      break;
    }

    // Sanitizer per-iterasi: mencegah raw tool-call XML dari model
    // pernah mencapai parser → emitter → SSE → TextBlock.
    const sanitizer = new StreamingResponseSanitizer();

    const publicLine = makePublicLineFilter(listToolNames());

    let inText = false;
    let textStarted = false;
    let pendingLine = "";
    let visibleText = "";

    function publishLine(index: number, raw: string) {
      const cleaned = publicLine(raw);
      if (!cleaned) return;

      // Simpan whitespace antarbait, tapi jangan buka bubble untuk baris kosong.
      if (!textStarted && !cleaned.trim()) return;

      if (!textStarted) {
        emitter.start({ type: "text", markdown: "" });
        textStarted = true;
      }

      visibleText += cleaned;
      emitter.delta(index, cleaned);
    }

    const parser = new FenceParser({
      start: (_index, block) => {
        inText = block.type === "text";

        if (inText) {
          textStarted = false;
          pendingLine = "";
          visibleText = "";
        } else {
          emitter.start(block);
        }
      },

      delta: (index, delta) => {
        if (!inText) {
          emitter.delta(index, delta);
          return;
        }

        const lines = (pendingLine + delta).split("\n");
        pendingLine = lines.pop() ?? "";

        for (const line of lines) {
          publishLine(index, `${line}\n`);
        }
      },

      end: (index, block) => {
        if (block.type !== "text") {
          emitter.end(index, block);
          return;
        }

        if (pendingLine) publishLine(index, pendingLine);

        if (textStarted) {
          emitter.end(index, {
            type: "text",
            markdown: sanitizeFinalText(visibleText),
          });
        }

        inText = false;
        pendingLine = "";
      },
    });

    const toolCallAcc = new Map<number, PartialToolCall>();
    const thinking = createThinkingForwarder(input.sseSend, {
      enabled: env.SHOW_REASONING,
    });

    let iterError: string | undefined;
    let iterErrorCode: string | undefined;
    let iterContent = "";
    let firstContentOrToolSeen = false;
    let iterFinishReason: string | null = null;

    try {
      const stream = provider.streamCompletion({
        model: input.model,
        messages: workingMessages,
        ...(currentTools.length > 0
          ? {
              tools: currentTools,
              toolChoice: requiredTool
                ? {
                    type: "function" as const,
                    function: { name: requiredTool },
                  }
                : ("auto" as const),
            }
          : {}),
        maxTokens: input.maxTokens,
        reasoning: input.reasoning,
        signal: input.signal,
      });

      for await (const chunk of stream) {
        if (input.signal.aborted) {
          aborted = true;
          break;
        }

        if (chunk.thinking && !input.fileAction && !firstContentOrToolSeen) {
          thinking.push(chunk.thinking);
        }

        if (chunk.content && !requiredTool) {
          if (!firstContentOrToolSeen) {
            firstContentOrToolSeen = true;
            thinking.end();
          }
          const safe = sanitizer.push(chunk.content);
          if (safe) {
            parser.feed(safe);
            iterContent += safe;
          }
        }

        if (chunk.toolCalls) {
          if (!firstContentOrToolSeen) {
            firstContentOrToolSeen = true;
            thinking.end();
          }
          accumulate(toolCallAcc, chunk.toolCalls);
        }

        if (chunk.usage) usage = chunk.usage;
        if (chunk.finishReason) iterFinishReason = chunk.finishReason;
      }
    } catch (err) {
      if (input.signal.aborted) aborted = true;
      else {
        logger.error(
          {
            err,
            sessionId: input.sessionId.toString(),
            iteration: iter,
          },
          "agent loop stream error",
        );
        const classified = classifyProviderError(err);
        iterError = classified.message;
        iterErrorCode = classified.code;
      }
    }

    thinking.end();

    const tail = sanitizer.finish();
    if (tail) {
      parser.feed(tail);
      iterContent += tail;
    }
    parser.finish();

    logger.debug(
      {
        iter,
        finishReason: iterFinishReason,
        completionTokens: usage?.completion_tokens,
        callsCount: finalize(toolCallAcc).length,
        contentLen: iterContent.length,
      },
      "[diag] iteration end",
    );

    if (aborted) break;
    if (iterError) {
      error = iterError;
      errorCode = iterErrorCode ?? "STREAM_ERROR";
      break;
    }

    const calls = finalize(toolCallAcc);

    if (iterFinishReason === "length") {
      const invalidArgsCount = calls.reduce((n, c) => {
        try {
          JSON.parse(c.args || "{}");
          return n;
        } catch {
          return n + 1;
        }
      }, 0);

      logger.warn(
        {
          iter,
          finishReason: iterFinishReason,
          completionTokens: usage?.completion_tokens,
          promptTokens: usage?.prompt_tokens,
          totalToolCalls: calls.length,
          invalidArgsCalls: invalidArgsCount,
          textLen: iterContent.length,
          sessionId: input.sessionId.toString(),
          model: input.model,
          maxTokens: input.maxTokens,
        },
        "output truncated by max_tokens (finish_reason=length)",
      );

      const hasPartialAnswer = emitter.blocks.some((block) => {
        if (block.type === "text") return block.markdown.trim().length > 0;
        if (block.type === "code") return block.content.trim().length > 0;
        return true;
      });

      let notice = "Jawaban terpotong karena mencapai batas token output.";

      if (calls.length > 0) {
        notice =
          "Batas token tercapai saat menyusun permintaan tool. Operasi terakhir belum dijalankan.";
      } else if (!hasPartialAnswer) {
        notice =
          "Batas token tercapai sebelum jawaban bisa ditampilkan. Coba pecah permintaan menjadi bagian yang lebih kecil.";
      }

      truncated = true;

      if (calls.length > 0 || !hasPartialAnswer) {
        error = notice;
        errorCode = "OUTPUT_TRUNCATED";
      }

      emitter.emitAtomic({
        type: "text",
        markdown: `_⚠️ ${notice}_`,
      });

      break;
    }

    if (terminalFirstStep) {
      const call = calls[0];
      let matchesRequest = calls.length === 1 && call?.name === "run_command";

      if (matchesRequest && call && input.terminalIntent !== "run_command") {
        try {
          const args: unknown = JSON.parse(call.args);

          matchesRequest =
            typeof args === "object" &&
            args !== null &&
            "command" in args &&
            args.command === input.terminalIntent;
        } catch {
          matchesRequest = false;
        }
      }

      if (!matchesRequest) {
        errorCode = "COMMAND_NOT_EXECUTED";
        error = "The requested command was not executed.";
        break;
      }
    }

    if (calls.length === 0) {
      if (input.fileAction) {
        errorCode = "FILE_ACTION_INCOMPLETE";
        error =
          input.fileAction === "create_file"
            ? "File belum berhasil dibuat. Silakan coba lagi."
            : "File belum berhasil ditampilkan. Coba sebutkan nama filenya.";
      } else {
        natural = true;
      }

      break;
    }

    if (
      input.fileAction &&
      calls.some((call) => call.name !== input.fileAction)
    ) {
      errorCode = "FILE_ACTION_INCOMPLETE";
      error = "Permintaan file belum berhasil diproses. Silakan coba lagi.";
      break;
    }

    workingMessages.push({
      role: "assistant",
      content: iterContent,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.args },
      })),
    });

    let shouldBreak = false;
    let fileActionFailed = false;

    for (const call of calls) {
      if (input.signal.aborted) {
        aborted = true;
        break;
      }

      accumulatedToolCalls.push({
        id: call.id,
        name: call.name,
        argsJson: call.args,
      });

      input.callbacks.onToolStart(call.id, call.name);

      const tool = getTool(call.name);
      let toolResult: ToolResult;

      try {
        if (
          tool &&
          tool.kind === "media" &&
          !input.allowedTools.has(tool.name)
        ) {
          // §8.5: tool media di luar allowlist turn ini tidak dijalankan.
          toolResult = errorResult(
            "TOOL_NOT_ALLOWED",
            `Tool ${tool.name} is not allowed for this request`,
          );
        } else if (!tool) {
          toolResult = errorResult(
            "TOOL_NOT_FOUND",
            `Tool ${call.name} does not exist`,
            { available: listToolNames() },
          );
        } else {
          toolResult = await executeWithRepair(
            tool,
            call.args,
            {
              userId: input.userId,
              sessionId: input.sessionId,
              messageId: input.messageId,
              abortSignal: input.signal,
              emit: input.sseSend,
              emitBlock: (b) => emitter.emitAtomic(b),
              iteration: iter,
              generation: input.generation,
              askClarification: input.askClarification,
            },
            input.fileAction,
            input.resolveMediaAspect,
          );
        }
      } catch (err) {
        if (err instanceof ClarificationTimeoutError) {
          emitter.emitAtomic({
            type: "text",
            markdown:
              "_Pertanyaan klarifikasi tidak dijawab dan dibatalkan. Kirim pesan lagi kapan saja._",
          });
          input.callbacks.onToolEnd(call.id, false, "clarification timeout");
          natural = true;
          shouldBreak = true;
          break;
        }
        if (err instanceof ClarificationAbortedError) {
          input.callbacks.onToolEnd(call.id, false, "aborted");
          aborted = true;
          break;
        }
        throw err;
      }

      if (input.signal.aborted) {
        input.callbacks.onToolEnd(call.id, false, "aborted");
        aborted = true;
        break;
      }

      if (terminalFirstStep && call.name === "run_command" && !toolResult.ok) {
        const code = commandFailureCode(toolResult.errorCode);

        input.callbacks.onToolEnd(call.id, false, code);
        errorCode = code;
        error = code;
        break agentIterations;
      }

      if (input.fileAction && !toolResult.ok) {
        fileActionFailed = true;
      }

      input.callbacks.onToolEnd(
        call.id,
        toolResult.ok,
        toolResult.ok
          ? `${call.name} ok`
          : `error: ${toolResult.content.slice(0, 120)}`,
      );

      workingMessages.push({
        role: "tool",
        content: toolResult.content,
        tool_call_id: call.id,
      });

      // Kalau tool media gagal (misal API key mati/limit), buang semua tool
      // di iterasi berikutnya supaya model terpaksa minta maaf/jawab teks,
      // bukan nge-loop manggil tool yang sama 8x.
      if (!toolResult.ok && tool?.kind === "media") {
        currentTools = [];
        // Inject system message tegas agar model tidak nge-print XML mentah
        workingMessages.push({
          role: "system",
          content: `Operasi ${call.name} gagal dengan error: ${toolResult.content}. 
JANGAN pernah menulis kode XML atau JSON tool-call di dalam jawabanmu. 
Balas user dengan sopan, jelaskan secara singkat dalam bahasa manusia bahwa operasinya gagal (misal karena server sibuk), lalu minta maaf. Jangan sebut nama tool, parameter, atau detail teknis apa pun.`,
        });
      }

      if (toolResult.endTurn) {
        endTurnByChoices = true;
        shouldBreak = true;
      }
    }

    if (aborted) break;

    if (input.fileAction) {
      const fileBlockCount = emitter.blocks.filter(
        (block) => block.type === "file",
      ).length;

      const presented = fileBlockCount > fileBlockCountAtStart;

      if (presented && !fileActionFailed) {
        natural = true;
      } else {
        errorCode = "FILE_ACTION_INCOMPLETE";
        error = presented
          ? "Sebagian file sudah tersedia. Ada file lain yang belum berhasil diproses."
          : input.fileAction === "create_file"
            ? "File belum berhasil dibuat. Silakan coba lagi."
            : "File belum tersedia untuk ditampilkan. Coba sebutkan nama file yang dimaksud.";
      }

      break;
    }

    if (shouldBreak) {
      natural = true;
      break;
    }
  }

  if (!natural && !aborted && !error && !truncated) {
    emitter.emitAtomic({
      type: "text",
      markdown: "_Aku mencapai batas langkah, ini hasil sejauh ini._",
    });
  }

  return {
    blocks: emitter.blocks,
    toolCalls: accumulatedToolCalls,
    ...(usage !== undefined ? { usage } : {}),
    aborted,
    truncated,
    ...(error !== undefined ? { error } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    endTurnByChoices,
  };
}
