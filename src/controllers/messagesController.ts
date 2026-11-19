// src/controllers/messagesController.ts
import type { Request, Response } from "express";
import { z } from "zod";
import { Types } from "mongoose";
import { SessionModel } from "../models/Session.js";
import { MessageModel } from "../models/Message.js";
import { FileDocModel } from "../models/FileDoc.js";
import { AppError } from "../middleware/error.js";
import { getUserId } from "../middleware/auth.js";
import { parseObjectIdParam as parseSessionId } from "../utils/params.js";
import {
  setupSseHeaders,
  createSseSender,
  startPing,
} from "../services/chat/sse.js";
import { estimateTokens } from "../services/chat/contextBuilder.js";
import { GenerationInputSchema } from "@services/generation/plan.js";
import { logger } from "../config/logger.js";
import {
  registerStream,
  unregisterStream,
} from "../services/chat/activeStreams.js";
import { runTurn } from "../services/orchestrator/coordinator.js";
import { RunTurnResult } from "@services/orchestrator/types.js";
import {
  resolvePending,
  type ResolveResult,
} from "../services/orchestrator/clarificationStore.js";
import type { Block } from "@services/blocks/schemas.js";

const PostMessageBody = z.object({
  text: z.string().min(1).max(100_000),
  attachmentIds: z.array(z.string()).optional(),
  generation: GenerationInputSchema.optional(),
  /** Phase 4: jika diset, user message ini di-update dan semua pesan
   * setelahnya dihapus sebelum turn baru dijalankan. */
  editOfMessageId: z.string().optional(),
});

const RegenerateBody = z.object({
  generation: GenerationInputSchema.optional(),
});

const RespondBody = z.object({
  questionId: z.string().min(1).max(128),
  answer: z.array(z.string().min(1).max(2000)).min(1).max(6),
});

type FinalStatus = "done" | "aborted" | "error";

interface StreamTurnParams {
  res: Response;
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  userMessageId: Types.ObjectId;
  text: string;
  attachmentIds: string[];
  generation?: z.infer<typeof GenerationInputSchema>;
}

/**
 * Setup SSE + jalankan runTurn + kirim event error / message.end.
 * Dipakai oleh tiga flow: new message, edit, dan regenerate.
 * Tidak pernah throw setelah SSE headers terkirim — semua error
 * dikirim lewat event `error`.
 */
async function streamTurn(params: StreamTurnParams): Promise<void> {
  const {
    res,
    userId,
    sessionId,
    userMessageId,
    text,
    attachmentIds,
    generation,
  } = params;

  setupSseHeaders(res);
  const sse = createSseSender(res);
  const ping = startPing(sse);

  const ac = new AbortController();
  registerStream(ac);

  let clientDisconnected = false;
  const onClose = (): void => {
    if (res.writableEnded) return;
    if (ac.signal.aborted) return;
    clientDisconnected = true;
    logger.info(
      { sessionId: sessionId.toString() },
      "client disconnected; aborting stream",
    );
    ac.abort();
  };
  res.on("close", onClose);

  const assistantId = new Types.ObjectId();
  let terminalEventSent = false;
  const sendEnd = (
    status: FinalStatus,
    usage: RunTurnResult["usage"] | null,
    truncated = false,
  ): void => {
    if (terminalEventSent) return;
    terminalEventSent = true;
    sse.send("message.end", {
      messageId: assistantId.toString(),
      status,
      usage: usage ?? null,
      ...(truncated ? { truncated: true } : {}),
    });
  };

  try {
    sse.send("message.start", {
      messageId: assistantId.toString(),
      userMessageId: userMessageId.toString(),
      sessionId: sessionId.toString(),
    });

    let result: RunTurnResult;
    try {
      result = await runTurn({
        userId,
        sessionId,
        messageId: assistantId,
        userMessageId,
        text,
        attachmentIds,
        ...(generation !== undefined ? { generation } : {}),
        sseSend: sse.send,
        signal: ac.signal,
      });
    } catch (err) {
      logger.error({ err }, "runTurn threw unexpectedly");
      if (!clientDisconnected && !ac.signal.aborted) {
        sse.send("error", {
          code: err instanceof AppError ? err.code : "INTERNAL",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      sendEnd(ac.signal.aborted ? "aborted" : "error", null);
      return;
    }

    if (result.error && !clientDisconnected && !ac.signal.aborted) {
      sse.send("error", {
        code: result.errorCode ?? "STREAM_ERROR",
        message: result.error,
      });
    }

    sendEnd(result.status, result.usage ?? null, result.truncated);
  } catch (err) {
    logger.error({ err }, "streamTurn error after SSE start");
    if (!clientDisconnected && !ac.signal.aborted) {
      sse.send("error", {
        code: err instanceof AppError ? err.code : "INTERNAL",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    sendEnd(ac.signal.aborted ? "aborted" : "error", null);
  } finally {
    unregisterStream(ac);
    clearInterval(ping);
    res.off("close", onClose);
    if (!res.writableEnded) res.end();
  }
}

async function validateAttachments(
  rawIds: string[],
  sessionId: Types.ObjectId,
  userId: Types.ObjectId,
): Promise<string[]> {
  const attachmentIds = rawIds.filter((id) => /^[a-f0-9]{24}$/i.test(id));
  if (attachmentIds.length !== rawIds.length) {
    throw AppError.badRequest("Some attachmentIds are invalid");
  }
  if (attachmentIds.length > 0) {
    const found = await FileDocModel.find({
      _id: { $in: attachmentIds },
      userId,
      sessionId,
    })
      .select({ _id: 1 })
      .lean();
    if (found.length !== attachmentIds.length) {
      throw AppError.badRequest("Some attachments not found in this session");
    }
  }
  return attachmentIds;
}

/**
 * Reset session summary jika message penanda summary sudah terhapus
 * (terjadi saat edit/regenerate men-truncate history). Jika message
 * penanda masih ada, berarti ia berada sebelum cutoff → summary valid.
 */
async function maybeResetSummaryIfTruncated(
  sessionId: Types.ObjectId,
  summaryUpToMessageId: Types.ObjectId | null | undefined,
): Promise<void> {
  if (!summaryUpToMessageId) return;
  const exists = await MessageModel.exists({ _id: summaryUpToMessageId });
  if (!exists) {
    await SessionModel.updateOne(
      { _id: sessionId },
      { $set: { summary: "", summaryUpToMessageId: null } },
    );
  }
}

export async function postMessage(req: Request, res: Response): Promise<void> {
  const sessionId = parseSessionId(req.params.id);
  // §7.8: nilai generation tak dikenal → 400 INVALID_PARAMS.
  const parsedBody = PostMessageBody.safeParse(req.body);
  if (!parsedBody.success) {
    throw AppError.invalidParams("Body tidak valid", {
      issues: z.treeifyError(parsedBody.error),
    });
  }
  const body = parsedBody.data;
  const userId = getUserId(res);

  const session = await SessionModel.findOne({ _id: sessionId, userId }).lean();
  if (!session) throw AppError.notFound();

  const attachmentIds = await validateAttachments(
    body.attachmentIds ?? [],
    session._id,
    userId,
  );

  let userMsgId: Types.ObjectId;

  if (body.editOfMessageId) {
    // ── EDIT FLOW ────────────────────────────────────────────────
    if (!Types.ObjectId.isValid(body.editOfMessageId)) {
      throw AppError.badRequest("editOfMessageId invalid");
    }
    const edited = await MessageModel.findOne({
      _id: body.editOfMessageId,
      sessionId: session._id,
      userId,
      role: "user",
    });
    if (!edited) {
      throw AppError.notFound("User message not found");
    }

    edited.blocks = [{ type: "text", markdown: body.text }] as Block[];
    edited.attachmentIds = attachmentIds.map((id) => new Types.ObjectId(id));
    edited.tokenEstimate = estimateTokens(body.text);
    await edited.save();

    await MessageModel.deleteMany({
      sessionId: session._id,
      _id: { $ne: edited._id },
      createdAt: { $gt: edited.createdAt },
    });

    await maybeResetSummaryIfTruncated(
      session._id,
      session.summaryUpToMessageId,
    );

    userMsgId = edited._id;
  } else {
    // ── NEW MESSAGE FLOW ─────────────────────────────────────────
    const userMsg = await MessageModel.create({
      sessionId: session._id,
      userId,
      role: "user",
      blocks: [{ type: "text", markdown: body.text }],
      attachmentIds: attachmentIds.map((id) => new Types.ObjectId(id)),
      status: "done",
      tokenEstimate: estimateTokens(body.text),
    });
    userMsgId = userMsg._id;
  }

  await SessionModel.updateOne(
    { _id: session._id },
    { $set: { lastMessageAt: new Date() } },
  );

  await streamTurn({
    res,
    userId,
    sessionId: session._id,
    userMessageId: userMsgId,
    text: body.text,
    attachmentIds,
    ...(body.generation !== undefined ? { generation: body.generation } : {}),
  });
}

export async function regenerateMessage(
  req: Request,
  res: Response,
): Promise<void> {
  const sessionId = parseSessionId(req.params.id);
  const messageIdRaw = String(req.params.msgId ?? "");
  if (!Types.ObjectId.isValid(messageIdRaw)) {
    throw AppError.badRequest("messageId invalid");
  }

  const parsedBody = RegenerateBody.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    throw AppError.invalidParams("Body tidak valid", {
      issues: z.treeifyError(parsedBody.error),
    });
  }
  const body = parsedBody.data;
  const userId = getUserId(res);

  const session = await SessionModel.findOne({ _id: sessionId, userId }).lean();
  if (!session) throw AppError.notFound();

  const target = await MessageModel.findOne({
    _id: messageIdRaw,
    sessionId: session._id,
    userId,
    role: "assistant",
  });
  if (!target) {
    throw AppError.notFound("Assistant message not found");
  }

  // Cari user message yang memicu pesan assistant ini.
  const userMsg = await MessageModel.findOne({
    sessionId: session._id,
    role: "user",
    createdAt: { $lt: target.createdAt },
  })
    .sort({ createdAt: -1 })
    .lean();
  if (!userMsg) {
    throw AppError.badRequest("No preceding user message to regenerate from");
  }

  // Hapus target assistant + semua pesan setelahnya (history tail).
  await MessageModel.deleteMany({
    sessionId: session._id,
    createdAt: { $gte: target.createdAt },
  });

  await maybeResetSummaryIfTruncated(session._id, session.summaryUpToMessageId);

  await SessionModel.updateOne(
    { _id: session._id },
    { $set: { lastMessageAt: new Date() } },
  );

  const text = userMsg.blocks
    .map((b) => (b.type === "text" ? b.markdown : ""))
    .filter(Boolean)
    .join("\n\n");

  const attachmentIds = (userMsg.attachmentIds ?? []).map((id) =>
    id.toString(),
  );

  await streamTurn({
    res,
    userId,
    sessionId: session._id,
    userMessageId: userMsg._id,
    text,
    attachmentIds,
    ...(body.generation !== undefined ? { generation: body.generation } : {}),
  });
}

export async function respondClarification(
  req: Request,
  res: Response,
): Promise<void> {
  const sessionId = parseSessionId(req.params.id);
  const body = RespondBody.parse(req.body);
  const userId = getUserId(res);

  const session = await SessionModel.findOne({ _id: sessionId, userId }).lean();
  if (!session) throw AppError.notFound();

  const result: ResolveResult = resolvePending({
    questionId: body.questionId,
    sessionId: sessionId.toString(),
    userId: userId.toString(),
    answer: body.answer,
  });

  switch (result) {
    case "ok":
      res.json({ ok: true });
      return;
    case "not_found":
      throw AppError.notFound("Question not found or expired");
    case "forbidden":
      throw AppError.forbidden("Not your question");
    case "already_answered":
      throw AppError.conflict("Question already answered");
  }
}
