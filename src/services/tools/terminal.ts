// src/services/tools/terminal.ts

import { z } from "zod";
import { registerTool, errorResult, okResult } from "./registry.js";
import {
  getCommand,
  listCommands,
  listCommandNames,
} from "./terminal/registry.js";
import { runTerminalCommand } from "./terminal/runner.js";

// Side-effect: register all safelisted commands
import "./terminal/commands/calc.js";
import "./terminal/commands/format_json.js";
import "./terminal/commands/csv_stats.js";
import "./terminal/commands/file_hash.js";
import "./terminal/commands/word_count.js";
import "./terminal/commands/pdf_info.js";
import "./terminal/commands/list_files.js";

function buildDescription(): string {
  const commands = listCommands().map(
    (command) => `- ${command.name}: ${command.description}`,
  );

  return [
    "Jalankan satu command dari registry dengan parameter command dan args.",
    "Gunakan saat user meminta eksekusi command yang tersedia.",
    'Contoh pemanggilan: {"command":"calc","args":{"expression":"12 * 8"}}.',
    "Gunakan hasil tool pada turn ini untuk melaporkan hasil eksekusi.",
    "Jika tool gagal, sampaikan kegagalannya. Jangan memberi hasil perkiraan sebagai hasil eksekusi.",
    "Untuk permintaan penjelasan atau contoh sintaks saja, jawab sesuai pertanyaan.",
    "Runner hanya menerima command berikut dan tidak menyediakan shell atau akses jaringan:",
    ...commands,
  ].join("\n");
}

const RunCommandSchema = z.object({
  command: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).default({}),
});

registerTool({
  name: "run_command",
  kind: "command",
  description: buildDescription(),
  schema: RunCommandSchema,
  async run(rawArgs, ctx) {
    const parsed = RunCommandSchema.parse(rawArgs);

    const cmd = getCommand(parsed.command);
    if (!cmd) {
      return errorResult(
        "COMMAND_NOT_ALLOWED",
        `Command "${parsed.command}" tidak ada di safelist`,
        { allowed: listCommandNames() },
      );
    }

    const result = await runTerminalCommand(
      { command: parsed.command, args: parsed.args },
      {
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        messageId: ctx.messageId,
      },
    );

    if (!result.ok) {
      const hints: Record<string, unknown> = {
        allowed: listCommandNames(),
      };
      if (result.error === "INVALID_ARGS") {
        hints.commandSchema = z.toJSONSchema(cmd.argsSchema, {
          target: "draft-7",
          io: "input",
        });
        if (result.data !== undefined) hints.detail = result.data;
      } else if (
        result.error === "COMMAND_ERROR" ||
        result.error === "PDFINFO_FAILED"
      ) {
        if (result.data !== undefined) hints.detail = result.data;
      }
      return errorResult(
        result.error ?? "COMMAND_ERROR",
        `run_command ${parsed.command} gagal: ${result.error ?? "unknown"}`,
        hints,
      );
    }

    const data =
      typeof result.data === "object" && result.data !== null
        ? (result.data as Record<string, unknown>)
        : { result: result.data };

    return okResult({ command: parsed.command, ...data });
  },
});
