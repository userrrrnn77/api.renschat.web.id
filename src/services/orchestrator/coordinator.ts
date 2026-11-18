// src/services/orchestrator/coordinator.ts

import { Types } from "mongoose";
import { SessionModel } from "../../models/Session.js";
import { MessageModel } from "../../models/Message.js";
import { UserModel } from "../../models/User.js";
import { FileDocModel } from "../../models/FileDoc.js";
import { AppError } from "../../middleware/error.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import {
  buildContext,
  blocksToText,
  estimateTokens,
} from "../chat/contextBuilder.js";
import { generateTitle } from "../chat/titler.js";
import { buildToolDefinitions, listTools } from "../tools/index.js";
import { resolveGenerationPlan } from "../generation/plan.js";
import { maybeSummarize } from "../chat/summarizer.js";
import { checkSafety } from "../safety/guard.js";
import { BlockEmitter } from "../chat/blockEmitter.js";
import { waitForReady } from "../ingest/index.js";
import { detectClarification } from "./clarification.js";
import {
  createPending,
  ClarificationTimeoutError,
  ClarificationAbortedError,
} from "./clarificationStore.js";
import type { ClarificationQuestion } from "./clarification.js";
import type { Phase, RunTurnInput, RunTurnResult } from "./types.js";
import type { Block } from "../blocks/schemas.js";
import type { Usage, ChatMessage } from "../llm/nvidiaClient.js";
import { retrieveRelevantChunks, shouldRetrieve } from "../rag/retriever.js";
import { buildGroundedMessage, toSourcesPayload } from "../rag/generator.js";
import type { RetrievedChunk, SourcePayload } from "../rag/types.js";
import { embedTexts, EmbeddingError } from "../ingest/embedder.js";
import { classifyTurn } from "../harness/harness.js";
import { runAgent } from "../chat/agentLoop.js";
import {
  buildCacheKey,
  getCachedTurn,
  setCachedTurn,
  fingerprintString,
} from "../cache/promptCache.js";
import {
  computeStyleProfileUpdate,
  type PersistedStyleProfile,
} from "../chat/styleProfile.js";
import {
  classifyPromptComplexity,
  decideRetrieval,
} from "../rag/promptComplexity.js";

const LEGAL: Record<Phase, Phase[]> = {
  IDLE: ["CLARIFYING", "RETRIEVING", "GENERATING", "DONE", "ABORTED", "ERROR"],
  CLARIFYING: ["RETRIEVING", "GENERATING", "DONE", "ABORTED", "ERROR"],
  RETRIEVING: ["GENERATING", "ABORTED", "ERROR"],
  GENERATING: ["CLARIFYING", "DONE", "ABORTED", "ERROR"],
  DONE: [],
  ABORTED: [],
  ERROR: [],
};

function makeTransition(
  sseSend: (event: string, data: unknown) => void,
): (next: Phase) => void {
  let current: Phase = "IDLE";
  return (next: Phase): void => {
    if (current === next) return;
    if (!LEGAL[current].includes(next)) {
      throw new Error(`Illegal phase transition: ${current} → ${next}`);
    }
    current = next;
    if (
      next === "CLARIFYING" ||
      next === "RETRIEVING" ||
      next === "GENERATING"
    ) {
      sseSend("status", { phase: next.toLowerCase() });
    }
  };
}

const ATTACHMENT_WAIT_MS = 90_000;

async function saveAssistantMessage(
  messageId: Types.ObjectId,
  sessionId: Types.ObjectId,
  userId: Types.ObjectId,
  blocks: Block[],
  status: "done" | "aborted" | "error",
  extras: {
    usage?: Usage;
    toolCalls?: Array<{ id: string; name: string; argsJson: string }>;
    sources?: SourcePayload[];
  } = {},
): Promise<void> {
  const text = blocks.map((b) => blocksToText([b])).join("");
  await MessageModel.create({
    _id: messageId,
    sessionId,
    userId,
    role: "assistant",
    blocks,
    attachmentIds: [],
    status,
    ...(extras.usage !== undefined ? { usage: extras.usage } : {}),
    ...(extras.sources !== undefined ? { sources: extras.sources } : {}),
    ...(extras.toolCalls !== undefined
      ? { llm: { toolCalls: extras.toolCalls } }
      : {}),
    tokenEstimate: estimateTokens(text),
  });
  await SessionModel.updateOne(
    { _id: sessionId },
    { $set: { lastMessageAt: new Date() } },
  );
}

export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  const {
    userId,
    sessionId,
    messageId,
    userMessageId,
    text,
    attachmentIds,
    generation,
    sseSend,
    signal,
  } = input;

  const transition = makeTransition(sseSend);
  const emitter = new BlockEmitter(sseSend);

  // ── Phase 9: pra-klasifikasi prompt (regex murni, sinkron) ──────
  // Dipakai untuk memutuskan apakah pre-embed perlu dijalankan di
  // Stage A. Keputusan retrieval final dibuat SETELAH klarifikasi
  // (augmentedText final + files ter-load).
  const textOnlyComplexity = env.RAG_SMART_EMBEDDING
    ? classifyPromptComplexity({ text, attachmentIds })
    : null;
  const shouldPreEmbed =
    env.EMBEDDING_ENABLED &&
    (textOnlyComplexity === null || textOnlyComplexity.category === "complex");

  logger.debug(
    {
      sessionId: sessionId.toString(),
      category: textOnlyComplexity?.category ?? "legacy",
      reasons: textOnlyComplexity?.reasons ?? [],
      speculativePreEmbed: shouldPreEmbed,
    },
    "embedding complexity (pre-retrieval)",
  );

  // ── Stage A: Paralel loading ─────────────────────────────────────
  const [session, user, history, files, attachmentDigests, preEmbedVec] =
    await Promise.all([
      SessionModel.findOne({ _id: sessionId, userId }).lean(),
      UserModel.findById(userId).lean(),
      MessageModel.find({
        sessionId,
        _id: { $ne: userMessageId },
        summarized: { $ne: true },
      })
        .sort({ createdAt: 1 })
        .lean(),
      FileDocModel.find({
        sessionId,
        status: { $in: ["ready", "processing"] },
        expired: { $ne: true },
      })
        .sort({ createdAt: 1 })
        .lean(),
      (async () => {
        if (attachmentIds.length === 0) return [];
        const attDocs = await FileDocModel.find({ _id: { $in: attachmentIds } })
          .select({ mime: 1, digest: 1 })
          .lean();
        return attDocs
          .filter((d) => d.mime.startsWith("image/") && d.digest !== undefined)
          .map((d) => ({
            summary: d.digest?.summary,
            ocrText: d.digest?.ocrText,
          }));
      })(),
      (async () => {
        if (!shouldPreEmbed) return null;
        try {
          const vecs = await embedTexts([text], "query", signal);
          return vecs[0] ?? null;
        } catch (err) {
          if (err instanceof EmbeddingError && err.aborted) {
            return null;
          }
          logger.warn({ err }, "pre-embed query failed");
          return null;
        }
      })(),
    ]);

  if (!session) throw AppError.notFound();
  if (!user) throw AppError.unauthorized();

  let finalStatus: RunTurnResult["status"] = "error";
  let finalUsage: Usage | undefined;
  let finalError: string | undefined;
  let finalErrorCode: string | undefined;
  let clarificationInfo: RunTurnResult["clarification"] | undefined;
  let savedSources: SourcePayload[] | undefined;

  try {
    // ── Generation plan (§8): dihitung di server, bukan oleh model.
    const plan = await resolveGenerationPlan(user, generation);
    const allowedToolNames = listTools()
      .filter((t) => t.kind !== "media" || plan.allowedMediaTools.has(t.name))
      .map((t) => t.name);

    // ── Wait attachments (jika ada) ─────────────────────────────────
    if (attachmentIds.length > 0) {
      await waitForReady(attachmentIds, ATTACHMENT_WAIT_MS, signal);
      const final = await FileDocModel.find({ _id: { $in: attachmentIds } })
        .select({ status: 1, error: 1, name: 1 })
        .lean();
      if (final.length !== attachmentIds.length) {
        throw AppError.badRequest("Some attachments no longer exist");
      }
      const failed = final.filter((f) => f.status !== "ready");
      if (failed.length > 0) {
        throw AppError.badRequest("Attachments not ready", {
          files: failed.map((f) => ({
            name: f.name,
            error: f.error ?? null,
          })),
        });
      }
    }

    // ── Safety gate ─────────────────────────────────────────────────
    const safetyResult = await checkSafety({ text, attachmentDigests });
    if (!safetyResult.safe) {
      const refusal: Block = {
        type: "text",
        markdown:
          "Maaf, aku tidak bisa membantu dengan permintaan itu. Silakan ajukan pertanyaan lain.",
      };
      emitter.emitAtomic(refusal);
      await saveAssistantMessage(
        messageId,
        sessionId,
        userId,
        [refusal],
        "done",
      );
      finalStatus = "done";
      transition("DONE");
      return { status: "done", blocks: [refusal] };
    }

    // ── askClarification ────────────────────────────────────────────
    const askClarification = async (
      q: ClarificationQuestion,
      resumePhase: Phase = "GENERATING",
    ): Promise<string[]> => {
      const pending = createPending({
        sessionId: sessionId.toString(),
        userId: userId.toString(),
        messageId: messageId.toString(),
        question: q,
      });

      transition("CLARIFYING");
      sseSend("clarification.needed", {
        questionId: pending.questionId,
        question: q.question,
        multi: q.multi,
        options: q.options,
        timeoutMs: env.CLARIFICATION_TIMEOUT_MS,
      });

      const answer = await pending.wait(signal, env.CLARIFICATION_TIMEOUT_MS);

      sseSend("clarification.resolved", {
        questionId: pending.questionId,
        answer,
      });

      const choicesBlock: Block = {
        type: "choices",
        questionId: pending.questionId,
        question: q.question,
        multi: q.multi,
        options: q.options,
        answer,
      };
      emitter.emitAtomic(choicesBlock);

      transition(resumePhase);
      clarificationInfo = {
        questionId: pending.questionId,
        question: q.question,
        answer,
      };
      return answer;
    };

    // ── Clarification detection ─────────────────────────────────────
    let augmentedText = text;
    const explicitMediaMode =
      generation?.mode === "image" || generation?.mode === "video";
    const question = explicitMediaMode
      ? null
      : detectClarification({
          text,
          attachmentIds,
          files: files.map((f) => ({
            _id: f._id,
            name: f.name,
            status: f.status,
            origin: f.origin,
            createdAt: f.createdAt,
          })),
          history: history.map((m) => ({ role: m.role, blocks: m.blocks })),
          enabled: env.CLARIFICATION_ENABLED,
        });

    if (question) {
      // Prediksi apakah setelah klarifikasi akan ada retrieval.
      const predictedComplexity = classifyPromptComplexity({
        text: augmentedText,
        attachmentIds,
      });
      const predictedRetrieval = decideRetrieval({
        complexity: predictedComplexity.category,
        files: files.map((f) => ({ _id: f._id, status: f.status })),
        attachmentIds,
        enabled: env.RAG_ENABLED,
      });
      const resumePhase: Phase = predictedRetrieval.needsRetrieval
        ? "RETRIEVING"
        : "GENERATING";

      try {
        const answer = await askClarification(question, resumePhase);
        augmentedText = `${text}\n\n[Klarifikasi user — "${question.question}": ${answer.join(", ")}]`;
      } catch (err) {
        if (err instanceof ClarificationTimeoutError) {
          emitter.emitAtomic({
            type: "text",
            markdown:
              "_Pertanyaan klarifikasi tidak dijawab dan dibatalkan. Kirim pesan lagi kapan saja._",
          });
          await saveAssistantMessage(
            messageId,
            sessionId,
            userId,
            emitter.blocks,
            "done",
          );
          finalStatus = "done";
          transition("DONE");
          return { status: "done", blocks: emitter.blocks };
        }
        if (err instanceof ClarificationAbortedError) {
          await saveAssistantMessage(
            messageId,
            sessionId,
            userId,
            emitter.blocks,
            "aborted",
          );
          finalStatus = "aborted";
          transition("ABORTED");
          return { status: "aborted", blocks: emitter.blocks };
        }
        throw err;
      }
    }

    // ── Phase 9: retrieval decision (final) ─────────────────────────
    const finalComplexity = classifyPromptComplexity({
      text: augmentedText,
      attachmentIds,
    });
    const retrievalDecision = decideRetrieval({
      complexity: finalComplexity.category,
      files: files.map((f) => ({ _id: f._id, status: f.status })),
      attachmentIds,
      enabled: env.RAG_ENABLED,
    });

    logger.debug(
      {
        sessionId: sessionId.toString(),
        category: finalComplexity.category,
        reasons: finalComplexity.reasons,
        needsRetrieval: retrievalDecision.needsRetrieval,
        needsEmbedding: retrievalDecision.needsEmbedding,
      },
      "retrieval decision",
    );

    // ── Retrieval ───────────────────────────────────────────────────
    let retrieved: RetrievedChunk[] = [];
    const doRetrieve = retrievalDecision.needsRetrieval;
    const effectiveNeedsEmbedding =
      retrievalDecision.needsEmbedding && env.EMBEDDING_ENABLED;

    if (doRetrieve) {
      transition("RETRIEVING");

      let queryVecPromise: Promise<number[] | null>;
      if (effectiveNeedsEmbedding) {
        if (preEmbedVec !== null) {
          queryVecPromise = Promise.resolve(preEmbedVec);
        } else {
          // Edge case: teks awal terklasifikasi simple/medium sehingga
          // pre-embed tidak jalan, tapi setelah klarifikasi jadi complex.
          // Lazy-embed di sini agar retrieval tetap dapat vektor.
          queryVecPromise = embedTexts([augmentedText], "query", signal)
            .then((v) => v[0] ?? null)
            .catch((err) => {
              if (err instanceof EmbeddingError && err.aborted) return null;
              logger.warn({ err }, "lazy query embedding failed");
              return null;
            });
        }
      } else {
        // Medium / text-only: paksa retriever pakai text search saja.
        queryVecPromise = Promise.resolve(null);
      }

      try {
        retrieved = await Promise.race([
          retrieveRelevantChunks(augmentedText, {
            sessionId,
            excludeFileIds: attachmentIds,
            topK: env.RAG_TOP_K,
            queryVec: queryVecPromise,
            signal,
          }),
          new Promise<RetrievedChunk[]>((resolve) => {
            const t = setTimeout(() => {
              logger.warn(
                { sessionId: sessionId.toString() },
                "retrieval timeout",
              );
              resolve([]);
            }, env.RAG_TIMEOUT_MS);
            t.unref?.();
          }),
        ]);
      } catch (err) {
        logger.warn({ err }, "retrieval failed; continuing without context");
        retrieved = [];
      }

      if (retrieved.length > 0) {
        sseSend("sources", { sources: toSourcesPayload(retrieved) });
        savedSources = toSourcesPayload(retrieved);
      }
    }

    // ── Build context & Harness ─────────────────────────────────────
    const extraSystemMessages: ChatMessage[] =
      retrieved.length > 0 ? [buildGroundedMessage(retrieved)] : [];

    const { messages } = await buildContext({
      session: { summary: session.summary ?? "" },
      user: {
        timezone: user.timezone,
        personality: user.personality ?? undefined,
        styleProfile:
          (user.styleProfile as PersistedStyleProfile | undefined) ?? undefined,
      },
      history: history.map((m) => ({
        _id: m._id,
        role: m.role,
        blocks: m.blocks,
        status: m.status,
        llm: m.llm,
      })),
      currentUserText: augmentedText,
      toolsAvailable: allowedToolNames,
      generation: plan,
      files: files.map((f) => ({
        _id: f._id,
        name: f.name,
        mime: f.mime,
        status: f.status,
        version: f.version,
        summaryLine: f.summaryLine,
        origin: f.origin,
      })),
      attachmentIds,
      ...(extraSystemMessages.length > 0 ? { extraSystemMessages } : {}),
    });

    const harness = classifyTurn({
      text: augmentedText,
      attachmentCount: attachmentIds.length,
      fileCount: files.length,
      historyLen: history.length,
      hasRetrieval: retrieved.length > 0,
      generation: plan,
    });

    logger.info(
      { sessionId: sessionId.toString(), harness },
      "harness decision",
    );

    // ── Prompt cache lookup (Phase 2) ───────────────────────────────
    const isMediaGeneration = explicitMediaMode;
    let cacheKey: string | null = null;

    if (env.PROMPT_CACHE_ENABLED && !isMediaGeneration) {
      const historyFingerprint = fingerprintString(
        history
          .filter((m) => m.role !== "tool" && m.status !== "streaming")
          .map((m) => `${String(m._id)}:${m.status}:${blocksToText(m.blocks)}`)
          .join("\n"),
      );
      const attachmentFingerprint = fingerprintString(attachmentIds.join(","));
      const filesFingerprint = fingerprintString(
        files
          .map((f) => `${String(f._id)}:v${f.version}:${f.status}`)
          .join("|"),
      );
      const ragFingerprint =
        savedSources && savedSources.length > 0
          ? fingerprintString(JSON.stringify(savedSources))
          : "none";
      const toolsFingerprint = fingerprintString(
        [...allowedToolNames].sort().join(","),
      );
      const dateFingerprint = new Date().toLocaleDateString("en-CA", {
        timeZone: user.timezone,
      });

      cacheKey = buildCacheKey({
        userId: userId.toString(),
        normalizedPrompt: augmentedText,
        dateFingerprint,
        provider: env.LLM_PROVIDER,
        model: harness.model,
        reasoning: harness.reasoning,
        maxTokens: harness.maxTokens,
        personalityMode: user.personality?.mode ?? "auto",
        personalityNote: user.personality?.note ?? "",
        attachmentFingerprint,
        historyFingerprint,
        filesFingerprint,
        ragFingerprint,
        generationMode: generation?.mode ?? "auto",
        toolsFingerprint,
      });

      const cached = await getCachedTurn(cacheKey);

      if (cached) {
        transition("GENERATING");

        if (cached.sources && cached.sources.length > 0) {
          sseSend("sources", { sources: cached.sources });
        }
        for (const block of cached.blocks) {
          emitter.emitAtomic(block);
        }

        await saveAssistantMessage(
          messageId,
          sessionId,
          userId,
          cached.blocks,
          "done",
          {
            ...(cached.usage !== undefined ? { usage: cached.usage } : {}),
            ...(cached.sources !== undefined
              ? { sources: cached.sources }
              : {}),
            ...(cached.toolCalls !== undefined
              ? { toolCalls: cached.toolCalls }
              : {}),
          },
        );

        finalStatus = "done";
        finalUsage = cached.usage;

        void maybeSummarize(sessionId).catch((err: unknown) => {
          logger.warn(
            { err },
            "maybeSummarize fire-and-forget failed (cache hit)",
          );
        });

        transition("DONE");

        return {
          status: "done",
          blocks: cached.blocks,
          ...(cached.usage !== undefined ? { usage: cached.usage } : {}),
        };
      }
    }

    transition("GENERATING");

    // ── Agent loop ──────────────────────────────────────────────────
    const result = await runAgent({
      messages,
      tools: buildToolDefinitions(plan.allowedMediaTools),
      userId,
      sessionId,
      messageId,
      model: harness.model,
      reasoning: harness.reasoning,
      maxTokens: harness.maxTokens,
      emitter,
      sseSend,
      callbacks: {
        onToolStart: (callId, name) => sseSend("tool.start", { callId, name }),
        onToolEnd: (callId, ok, summary) =>
          sseSend("tool.end", { callId, ok, summary }),
      },
      signal,
      allowedTools: plan.allowedMediaTools,
      generation: plan,
      askClarification: (q) => askClarification(q, "GENERATING"),
    });

    finalStatus = result.aborted ? "aborted" : result.error ? "error" : "done";
    finalUsage = result.usage;
    finalError = result.error;
    if (result.error) finalErrorCode = result.errorCode ?? "STREAM_ERROR";

    await saveAssistantMessage(
      messageId,
      sessionId,
      userId,
      result.blocks,
      finalStatus,
      {
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(savedSources !== undefined ? { sources: savedSources } : {}),
        toolCalls: result.toolCalls,
      },
    );

    // ── Prompt cache store (Phase 2) ───────────────────────────────
    if (cacheKey && finalStatus === "done" && result.blocks.length > 0) {
      await setCachedTurn(cacheKey, {
        blocks: result.blocks,
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(savedSources !== undefined ? { sources: savedSources } : {}),
        ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
        createdAt: Date.now(),
      });
    }

    if (finalStatus === "done") {
      void maybeSummarize(sessionId).catch((err: unknown) => {
        logger.warn({ err }, "maybeSummarize fire-and-forget failed");
      });
    }

    // ── Phase 8: gradual style profile update (fire-and-forget) ────
    if (finalStatus === "done") {
      const recentUserTexts = history
        .filter((m) => m.role === "user" && m.status === "done")
        .slice(-10)
        .map((m) => blocksToText(m.blocks));
      recentUserTexts.push(text);

      void (async () => {
        try {
          const prev =
            (user.styleProfile as PersistedStyleProfile | undefined) ??
            undefined;
          const updated = computeStyleProfileUpdate({
            recentUserTexts,
            ...(prev !== undefined ? { persisted: prev } : {}),
          });
          if (updated.sampleCount === (prev?.sampleCount ?? -1)) return;
          await UserModel.updateOne(
            { _id: userId },
            { $set: { styleProfile: updated } },
          );
        } catch (err) {
          logger.warn({ err }, "style profile update failed");
        }
      })();
    }

    if (finalStatus === "done" && session.titleAuto) {
      const priorDoneAssistant = history.some(
        (m) => m.role === "assistant" && m.status === "done",
      );
      if (!priorDoneAssistant) {
        const sessionIdStr = sessionId.toString();
        const assistantText = result.blocks
          .map((b) => blocksToText([b]))
          .join("");
        void generateTitle(sessionIdStr, [
          { role: "user", content: text },
          { role: "assistant", content: assistantText.slice(0, 500) },
        ])
          .then((title) => {
            if (!title) return;
            sseSend("title", { sessionId: sessionIdStr, title });
          })
          .catch((err: unknown) => {
            logger.warn(
              { err, sessionId: sessionIdStr },
              "background title gen failed",
            );
          });
      }
    }

    if (result.aborted) transition("ABORTED");
    else if (result.error) transition("ERROR");
    else transition("DONE");

    return {
      status: finalStatus,
      blocks: result.blocks,
      ...(finalUsage !== undefined ? { usage: finalUsage } : {}),
      ...(finalError !== undefined ? { error: finalError } : {}),
      ...(finalErrorCode !== undefined ? { errorCode: finalErrorCode } : {}),
      ...(clarificationInfo !== undefined
        ? { clarification: clarificationInfo }
        : {}),
    };
  } catch (err) {
    try {
      const partialStatus = signal.aborted ? "aborted" : "error";
      await saveAssistantMessage(
        messageId,
        sessionId,
        userId,
        emitter.blocks,
        partialStatus,
        savedSources !== undefined ? { sources: savedSources } : {},
      );
    } catch (saveErr) {
      logger.error(
        { err: saveErr, assistantId: messageId.toString() },
        "failed to save partial assistant message",
      );
    }

    const code = err instanceof AppError ? err.code : "INTERNAL";
    const publicMessage =
      err instanceof AppError
        ? err.message
        : "Terjadi kesalahan saat memproses permintaan.";
    logger.error(
      { err, sessionId: sessionId.toString() },
      "coordinator runTurn error",
    );

    finalStatus = signal.aborted ? "aborted" : "error";
    finalError = publicMessage;
    finalErrorCode = code;

    try {
      if (signal.aborted) transition("ABORTED");
      else transition("ERROR");
    } catch {
      // ignore
    }

    return {
      status: finalStatus,
      blocks: emitter.blocks,
      ...(finalError !== undefined ? { error: finalError } : {}),
      ...(finalErrorCode !== undefined ? { errorCode: finalErrorCode } : {}),
      ...(clarificationInfo !== undefined
        ? { clarification: clarificationInfo }
        : {}),
    };
  }
}
