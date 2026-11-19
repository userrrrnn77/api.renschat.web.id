// src/services/llm/providers/nvidia.ts
import { chatStream } from "../nvidiaClient.js";
import { mapReasoning } from "../reasoningMap.js";
import type {
  LlmProvider,
  NormalizedChunk,
  StreamCompletionInput,
} from "../provider.js";

export class NvidiaProvider implements LlmProvider {
  name = "nvidia";

  async *streamCompletion(
    input: StreamCompletionInput,
  ): AsyncGenerator<NormalizedChunk, void, void> {
    const extra = mapReasoning("nvidia", input.model, input.reasoning);

    const stream = chatStream(
      {
        model: input.model,
        messages: input.messages,
        ...(input.tools?.length
          ? { tools: input.tools, tool_choice: input.toolChoice ?? "auto" }
          : {}),
        max_tokens: input.maxTokens,
        ...(Object.keys(extra).length > 0 ? { extra } : {}),
      },
      input.signal,
    );

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta;
      const finishReason = choice?.finish_reason ?? null;

      // Jangan skip kalau punya finishReason atau usage — chunk final
      // sering tidak punya `delta` tapi justru membawa finish_reason
      // (termasuk "length"). Skip hanya kalau benar-benar kosong.
      if (!delta && !finishReason && !chunk.usage) continue;

      yield {
        content: delta?.content ?? undefined,
        thinking: delta?.reasoning_content ?? delta?.reasoning ?? undefined,
        toolCalls: delta?.tool_calls,
        usage: chunk.usage,
        finishReason,
      };
    }
  }
}
