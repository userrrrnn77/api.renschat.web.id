import { chatStream, UpstreamError } from "../nvidiaClient.js";
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

    let receivedChoice = false;
    let chunkCount = 0;

    for await (const chunk of stream) {
      chunkCount++;

      const choice = chunk.choices?.[0];
      if (choice) receivedChoice = true;

      const delta = choice?.delta;
      const finishReason = choice?.finish_reason ?? null;

      if (!delta && !finishReason && !chunk.usage) continue;

      yield {
        content: delta?.content ?? undefined,
        thinking: delta?.reasoning_content ?? delta?.reasoning ?? undefined,
        toolCalls: delta?.tool_calls,
        usage: chunk.usage,
        finishReason,
      };
    }

    // Baru periksa setelah chatStream selesai diiterasi.
    if (!receivedChoice && !input.signal?.aborted) {
      throw new UpstreamError(
        502,
        `NVIDIA stream ended without choices (parsedChunks=${chunkCount})`,
      );
    }
  }
}
