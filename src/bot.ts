import type { ChildProcess } from "node:child_process";
import { Bot, type Context } from "grammy";
import type { BotConfig } from "./types.js";
import { SessionStore } from "./session.js";
import { runClaude } from "./claude.js";
import { createActivityStatus } from "./activity.js";
import { sendMessage } from "./sender.js";
import { processTracker, setupGracefulShutdown } from "./shutdown.js";
import { loadModules, type BotModule, type ModuleContext } from "./modules.js";

export interface CreateBotOptions {
  modules?: BotModule[];
  onModuleContext?: (ctx: ModuleContext) => void;
}

function buildHelpText(modules: BotModule[]): string {
  const lines: string[] = [
    "Send me any text message to chat with Claude.\n",
    "/cancel — stop current request",
    "/clear — start a new conversation",
    "/help — show this message",
  ];

  const extra = modules
    .flatMap((m) => m.commands ?? [])
    .filter((c) => c.command.startsWith("/"));

  if (extra.length > 0) {
    lines.push("\nExtra commands:");
    for (const c of extra) lines.push(`${c.command} — ${c.description}`);
  }

  return lines.join("\n");
}

/**
 * Create and configure a Grammy bot connected to Claude CLI.
 */
export function createBot(config: BotConfig, options: CreateBotOptions = {}): Bot {
  const bot = new Bot(config.token);
  const sessionStore = new SessionStore(config.workspace);
  const modules = options.modules ?? [];
  const helpText = buildHelpText(modules);

  // Track which users currently have a running Claude process
  const busy = new Set<number>();

  type RunningJob = {
    child: ChildProcess;
    chatId: number;
    statusMessageId: number;
    activity: ReturnType<typeof createActivityStatus>;
    canceled: boolean;
  };

  const running = new Map<number, RunningJob>();

  // Avoid unhandled errors taking down the process.
  bot.catch((err) => {
    console.error("[claude-telegram] Bot error:", err.error);
  });

  // --- Middleware: private chat only ---
  bot.use(async (ctx, next) => {
    if (!ctx.chat) return;
    if (ctx.chat.type !== "private") {
      try {
        if (ctx.message) {
          await ctx.reply("Please message me in a private chat.");
        }
      } catch {
        // Ignore reply failures.
      }
      return;
    }
    await next();
  });

  // --- Middleware: whitelist ---
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Secure by default: empty whitelist means no one can use the bot.
    if (config.whitelist.length === 0 || !config.whitelist.includes(userId)) {
      if (ctx.chat) {
        try {
          await ctx.reply("Access denied.");
        } catch {
          // Ignore reply failures for non-message updates.
        }
      }
      return;
    }

    await next();
  });

  // --- Commands ---
  bot.command("start", async (ctx) => {
    await ctx.reply("Hello!\n\n" + helpText);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(helpText);
  });

  async function dispatchToClaude(ctx: Context, message: string): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!userId || !chatId) return;
    if (!message || !message.trim()) return;

    // Concurrency guard: one message at a time per user
    if (busy.has(userId)) {
      await ctx.reply(
        "Still working on previous message... Send /cancel to stop."
      );
      return;
    }

    busy.add(userId);

    // Send placeholder message
    let statusMsg;
    try {
      statusMsg = await ctx.reply("💭 Thinking  ⏱ 0:00");
    } catch {
      busy.delete(userId);
      return;
    }

    const msgId = statusMsg.message_id;

    // Activity status updater
    const activity = createActivityStatus({
      api: bot.api,
      chatId,
      messageId: msgId,
    });

    let job: RunningJob | undefined;
    try {
      const { promise, child } = runClaude({
        config,
        sessionStore,
        userId,
        message,
        onEvent: activity.onEvent,
      });

      job = {
        child,
        chatId,
        statusMessageId: msgId,
        activity,
        canceled: false,
      };
      running.set(userId, job);

      processTracker.register(child);

      const result = await promise;
      if (running.get(userId) === job) running.delete(userId);
      activity.stop();

      // Delete the status message
      try {
        await bot.api.deleteMessage(chatId, msgId);
      } catch {
        // Ignore — message may already be deleted
      }

      if (job.canceled) {
        // Cancel was already acknowledged by /cancel or /clear.
        return;
      }

      if (result.success && result.output) {
        await sendMessage(ctx, result.output);
      } else if (result.success && !result.output) {
        await ctx.reply("(empty response)");
      } else {
        const errorMsg = result.error
          ? `Error: ${result.error.slice(0, 300)}`
          : "Unknown error occurred.";
        await ctx.reply(errorMsg);
      }
    } catch (err) {
      activity.stop();
      if (job && running.get(userId) === job) running.delete(userId);

      // Try to update the status message with error
      try {
        const errorText =
          err instanceof Error ? err.message : "Unknown error";
        await bot.api.editMessageText(
          chatId,
          msgId,
          `Error: ${errorText.slice(0, 300)}`
        );
      } catch {
        // Give up on status message
      }
    } finally {
      busy.delete(userId);
    }
  }

  const moduleCtx: ModuleContext = {
    bot,
    config,
    sessionStore,
    dispatchToClaude,
  };
  options.onModuleContext?.(moduleCtx);

  for (const mod of modules) {
    try {
      mod.register?.(moduleCtx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Module "${mod.name}" register() failed: ${msg}`);
    }
  }

  bot.command("cancel", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const job = running.get(userId);
    if (!job) {
      await ctx.reply("Nothing to cancel.");
      return;
    }

    if (job.canceled) {
      await ctx.reply("Already cancelling...");
      return;
    }

    job.canceled = true;
    job.activity.stop();

    // Best-effort status update; main handler will also clean up.
    try {
      await bot.api.editMessageText(
        job.chatId,
        job.statusMessageId,
        "Cancelling..."
      );
    } catch {
      // Ignore
    }

    try {
      job.child.kill("SIGTERM");
    } catch {
      // Ignore
    }
    setTimeout(() => {
      try {
        if (running.get(userId) === job) {
          job.child.kill("SIGKILL");
        }
      } catch {
        // Ignore
      }
    }, 5000);

    await ctx.reply("Cancelling... (may take a few seconds)");
  });

  bot.command("clear", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const job = running.get(userId);
    if (job && !job.canceled) {
      job.canceled = true;
      job.activity.stop();
      try {
        await bot.api.editMessageText(
          job.chatId,
          job.statusMessageId,
          "Cancelling..."
        );
      } catch {
        // Ignore
      }
      try {
        job.child.kill("SIGTERM");
      } catch {
        // Ignore
      }
      setTimeout(() => {
        try {
          if (running.get(userId) === job) job.child.kill("SIGKILL");
        } catch {
          // Ignore
        }
      }, 5000);
    }

    sessionStore.resetSession(userId);
    await ctx.reply("Session cleared. Starting fresh.");
  });

  // --- Text message handler ---
  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    const text = ctx.message.text;

    if (!userId || !text) return;

    // Skip commands (already handled above)
    if (text.startsWith("/")) return;

    await dispatchToClaude(ctx, text);
  });

  return bot;
}

/**
 * Start the bot with graceful shutdown handling.
 */
export async function startBot(config: BotConfig): Promise<void> {
  const modules = await loadModules(config);
  let moduleCtx: ModuleContext | undefined;

  const bot = createBot(config, {
    modules,
    onModuleContext: (ctx) => {
      moduleCtx = ctx;
    },
  });

  if (moduleCtx) {
    for (const mod of modules) {
      if (!mod.init) continue;
      console.log(`[claude-telegram] Init module: ${mod.name}`);
      await mod.init(moduleCtx);
    }
  }

  setupGracefulShutdown(() => bot.stop(), {
    timeout: 30_000,
    beforeExit: async () => {
      for (const mod of [...modules].reverse()) {
        if (!mod.dispose) continue;
        try {
          await mod.dispose();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[claude-telegram] Module "${mod.name}" dispose() failed: ${msg}`
          );
        }
      }
    },
  });

  console.log(`[claude-telegram] Starting bot...`);
  console.log(`[claude-telegram] Workspace: ${config.workspace}`);
  console.log(`[claude-telegram] Permission mode: ${config.permissionMode}`);
  console.log(
    `[claude-telegram] Whitelist: ${config.whitelist.length > 0 ? config.whitelist.join(", ") : "(empty — no one can access)"}`
  );
  console.log(
    `[claude-telegram] Modules: ${modules.length > 0 ? modules.map((m) => m.name).join(", ") : "(none)"}`
  );

  await bot.start({
    onStart: () => console.log("[claude-telegram] Bot is running"),
  });
}
