// src/services/llm/reasoningMap.ts
import type { ReasoningEffort } from "./provider.js";

export function mapReasoning(
  provider: "nvidia" | "openai_compat",
  model: string,
  effort: ReasoningEffort,
): Record<string, unknown> {
  if (provider === "nvidia") {
    // Nemotron reasoning models default to enable_thinking=true even
    // without explicit chat_template_kwargs. Returning {} for "off" is
    // NOT sufficient — model keeps reasoning and burns the entire
    // max_tokens budget on reasoning_content (contentLen=0).
    if (effort === "off") {
      return { chat_template_kwargs: { enable_thinking: false } };
    }
    const budget = effort === "low" ? 1024 : effort === "medium" ? 4096 : 16384;
    return {
      chat_template_kwargs: { enable_thinking: true },
      reasoning_budget: budget,
    };
  }

  if (effort === "off") return {};

  if (provider === "openai_compat") {
    if (model.match(/^o[1-9]/) || model.startsWith("gpt-5")) {
      return { reasoning_effort: effort };
    }
    // deepseek-reasoner / deepseek-chat: otomatis dari model
  }

  return {};
}
