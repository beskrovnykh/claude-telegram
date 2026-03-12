import { Bot } from "grammy";
import { SessionStore } from "./session.js";
import { runClaude } from "./claude.js";
import { createActivityStatus } from "./activity.js";
import { sendMessage } from "./sender.js";
import { processTracker, setupGracefulShutdown } from "./shutdown.js";
import { loadModules } from "./modules.js";
function sanitizeErrorForUser(text, workspace, maxLen) {
    const normalized = text.replace(/\r\n/g, "\n").trim();
    if (!normalized)
        return "";
    const lines = normalized.split("\n");
    const kept = [];
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line)
            continue;
        // Drop Node/JS stack-trace lines and other noisy frames.
        if (/^\s*at\s+/.test(rawLine))
            continue;
        if (/^\s*Node\.js v\d+/.test(rawLine))
            continue;
        kept.push(line);
        if (kept.length >= 2)
            break;
    }
    let out = kept.length > 0 ? kept.join("\n") : lines[0]?.trim() || "";
    out = out.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "<TELEGRAM_TOKEN_REDACTED>");
    if (workspace)
        out = out.split(workspace).join("<WORKSPACE>");
    return out.slice(0, maxLen);
}
function buildHelpText(modules) {
    const lines = [
        "Send any message to chat with Claude Code. I'll show a live status while Claude works.\n",
        "/cancel — stop current request",
        "/clear — start a new conversation",
        "/reload — reload modules",
        "/help — show this message",
    ];
    const extra = modules
        .flatMap((m) => m.commands ?? [])
        .filter((c) => c.command.startsWith("/"));
    if (extra.length > 0) {
        lines.push("\nExtra commands:");
        for (const c of extra)
            lines.push(`${c.command} — ${c.description}`);
    }
    return lines.join("\n");
}
/** Build reply options that preserve forum topic context. */
function topicParams(ctx) {
    const id = ctx.message?.message_thread_id;
    return id ? { message_thread_id: id } : {};
}
/**
 * Create and configure a Grammy bot connected to Claude CLI.
 */
export function createBot(config, options = {}) {
    const bot = new Bot(config.token);
    const sessionStore = new SessionStore(config.workspace, config.sessionNamespace);
    let modules = options.modules ?? [];
    let helpText = buildHelpText(modules);
    // Track which users currently have a running Claude process
    const busy = new Set();
    const running = new Map();
    // Avoid unhandled errors taking down the process.
    bot.catch((err) => {
        console.error("[claude-telegram] Bot error:", err.error);
    });
    // --- Middleware: chat type filter ---
    bot.use(async (ctx, next) => {
        if (!ctx.chat)
            return;
        if (ctx.chat.type !== "private" && !config.allowGroups) {
            try {
                if (ctx.message) {
                    await ctx.reply("Please message me in a private chat.", topicParams(ctx));
                }
            }
            catch {
                // Ignore reply failures.
            }
            return;
        }
        await next();
    });
    // --- Middleware: topic filter ---
    // When topic_id is configured, only respond to messages in that specific forum topic.
    // Messages in other topics are silently ignored so other bots can handle them.
    if (config.topicId) {
        bot.use(async (ctx, next) => {
            if (ctx.chat?.type !== "private") {
                if (ctx.message?.message_thread_id !== config.topicId)
                    return;
            }
            await next();
        });
    }
    // --- Middleware: whitelist ---
    bot.use(async (ctx, next) => {
        const userId = ctx.from?.id;
        if (!userId)
            return;
        // Secure by default: empty whitelist means no one can use the bot.
        if (config.whitelist.length === 0 || !config.whitelist.includes(userId)) {
            if (ctx.chat) {
                try {
                    await ctx.reply(`Sorry, you don't have access to this bot. Ask the owner to add your user ID to the whitelist.\n\nYour ID: ${userId}`, topicParams(ctx));
                }
                catch {
                    // Ignore reply failures for non-message updates.
                }
            }
            return;
        }
        await next();
    });
    // --- Commands ---
    bot.command("topicid", async (ctx) => {
        const threadId = ctx.message?.message_thread_id;
        if (threadId) {
            await ctx.reply(`Topic ID: ${threadId}`, topicParams(ctx));
        }
        else {
            await ctx.reply("This chat has no topic (not a forum or General topic).", topicParams(ctx));
        }
    });
    bot.command("start", async (ctx) => {
        const firstName = ctx.from?.first_name || "there";
        await ctx.reply(`Hi ${firstName}! I'm a bridge to Claude Code — an AI that can read, write, and run code in a workspace on the server.\n\nSend any message and I'll pass it to Claude. You'll see a live status while it works.\n\nTry: "What files are in the workspace?"\n\n${helpText}`, topicParams(ctx));
    });
    bot.command("help", async (ctx) => {
        await ctx.reply(helpText, topicParams(ctx));
    });
    async function runBeforeClaudeHooks(ctx, message) {
        let current = message;
        for (const mod of modules) {
            if (!mod.beforeClaude)
                continue;
            try {
                const res = await mod.beforeClaude(ctx, current);
                if (!res)
                    continue;
                if (res.action === "deny") {
                    return { allowed: false, reply: res.reply };
                }
                if (res.action === "continue" && typeof res.message === "string") {
                    current = res.message;
                }
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    allowed: false,
                    reply: `Module "${mod.name}" failed: ${msg.slice(0, 300)}`,
                };
            }
        }
        return { allowed: true, message: current };
    }
    async function runAfterClaudeHooks(ctx, result) {
        let current = result;
        for (const mod of modules) {
            if (!mod.afterClaude)
                continue;
            try {
                const next = await mod.afterClaude(ctx, current);
                if (next)
                    current = next;
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`[claude-telegram] Module "${mod.name}" afterClaude() failed: ${msg}`);
            }
        }
        return current;
    }
    async function dispatchToClaude(ctx, message) {
        const userId = ctx.from?.id;
        const chatId = ctx.chat?.id;
        if (!userId || !chatId)
            return;
        if (!message || !message.trim())
            return;
        // In group chats, use chatId as session key so all users share one conversation.
        // In private chats, use userId as before.
        const isGroup = ctx.chat?.type !== "private";
        const sessionKey = isGroup ? chatId : userId;
        // Concurrency guard: one message at a time per session
        if (busy.has(sessionKey)) {
            await ctx.reply("Still working on your previous message. Send /cancel to stop, or wait for the response.", topicParams(ctx));
            return;
        }
        busy.add(sessionKey);
        // Give modules a chance to deny/transform the message before starting Claude.
        const before = await runBeforeClaudeHooks(ctx, message);
        if (!before.allowed) {
            if (before.reply) {
                try {
                    await ctx.reply(before.reply, topicParams(ctx));
                }
                catch {
                    // Ignore
                }
            }
            busy.delete(sessionKey);
            return;
        }
        const finalMessage = before.message;
        if (!finalMessage || !finalMessage.trim()) {
            busy.delete(sessionKey);
            return;
        }
        // Send placeholder message
        let statusMsg;
        try {
            statusMsg = await ctx.reply("💭 Thinking  ⏱ 0:00", topicParams(ctx));
        }
        catch {
            busy.delete(sessionKey);
            return;
        }
        const msgId = statusMsg.message_id;
        // Activity status updater
        const activity = createActivityStatus({
            api: bot.api,
            chatId,
            messageId: msgId,
        });
        let job;
        try {
            const { promise, child } = runClaude({
                config,
                sessionStore,
                userId: sessionKey,
                message: finalMessage,
                onEvent: activity.onEvent,
            });
            job = {
                child,
                chatId,
                statusMessageId: msgId,
                activity,
                canceled: false,
            };
            running.set(sessionKey, job);
            processTracker.register(child);
            const result = await promise;
            if (running.get(sessionKey) === job)
                running.delete(sessionKey);
            activity.stop();
            // Delete the status message
            try {
                await bot.api.deleteMessage(chatId, msgId);
            }
            catch {
                // Ignore — message may already be deleted
            }
            if (job.canceled) {
                // Cancel was already acknowledged by /cancel or /clear.
                return;
            }
            const finalResult = await runAfterClaudeHooks(ctx, result);
            if (finalResult.success && finalResult.output) {
                const parts = [];
                const secs = Math.round(finalResult.durationMs / 1000);
                if (secs > 0)
                    parts.push(`${secs}s`);
                if (finalResult.costUsd && finalResult.costUsd > 0)
                    parts.push(`$${finalResult.costUsd.toFixed(4)}`);
                if (config.model)
                    parts.push(config.model);
                const footer = parts.length > 0 ? parts.join(" · ") : undefined;
                await sendMessage(ctx, finalResult.output, { footer });
            }
            else if (finalResult.success && !finalResult.output) {
                await ctx.reply("Claude returned an empty response. Try rephrasing, or /clear to start fresh.", topicParams(ctx));
            }
            else {
                const safeError = finalResult.error
                    ? sanitizeErrorForUser(finalResult.error, config.workspace, 400)
                    : undefined;
                const errorMsg = safeError
                    ? `Something went wrong: ${safeError}`
                    : "Something went wrong. Try again, or /clear to start fresh.";
                await ctx.reply(errorMsg, topicParams(ctx));
            }
        }
        catch (err) {
            activity.stop();
            if (job && running.get(sessionKey) === job)
                running.delete(sessionKey);
            // Try to update the status message with error
            try {
                const errorText = err instanceof Error ? err.message : "Unknown error";
                const safeErrorText = sanitizeErrorForUser(errorText, config.workspace, 400);
                await bot.api.editMessageText(chatId, msgId, safeErrorText
                    ? `Something went wrong: ${safeErrorText}\n\nTry again or /clear to start fresh.`
                    : "Something went wrong.\n\nTry again or /clear to start fresh.");
            }
            catch {
                // Give up on status message
            }
        }
        finally {
            busy.delete(sessionKey);
        }
    }
    const moduleCtx = {
        bot,
        config,
        sessionStore,
        dispatchToClaude,
    };
    options.onModuleContext?.(moduleCtx);
    for (const mod of modules) {
        try {
            mod.register?.(moduleCtx);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`Module "${mod.name}" register() failed: ${msg}`);
        }
    }
    async function reloadModules() {
        if (busy.size > 0) {
            throw new Error("Cannot reload while requests are in progress.");
        }
        // Dispose old modules (reverse order).
        for (const mod of [...modules].reverse()) {
            if (!mod.dispose)
                continue;
            try {
                await mod.dispose();
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`[claude-telegram] Module "${mod.name}" dispose() failed: ${msg}`);
            }
        }
        // Load fresh modules.
        const fresh = await loadModules(config);
        // Init fresh modules.
        const freshCtx = { bot, config, sessionStore, dispatchToClaude };
        for (const mod of fresh) {
            if (!mod.init)
                continue;
            await mod.init(freshCtx);
        }
        modules = fresh;
        helpText = buildHelpText(modules);
        return fresh.map((m) => m.name);
    }
    bot.command("reload", async (ctx) => {
        try {
            const names = await reloadModules();
            await ctx.reply(`Reloaded: ${names.join(", ") || "(none)"}\n\nNote: new commands require bot restart.`, topicParams(ctx));
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await ctx.reply(`Reload failed: ${msg}`, topicParams(ctx));
        }
    });
    bot.command("cancel", async (ctx) => {
        const userId = ctx.from?.id;
        if (!userId)
            return;
        const isGroup = ctx.chat?.type !== "private";
        const sessionKey = isGroup ? ctx.chat.id : userId;
        const job = running.get(sessionKey);
        if (!job) {
            await ctx.reply("Nothing to cancel.", topicParams(ctx));
            return;
        }
        if (job.canceled) {
            await ctx.reply("Already cancelling...", topicParams(ctx));
            return;
        }
        job.canceled = true;
        job.activity.stop();
        // Best-effort status update; only send a separate reply if the edit fails.
        let statusUpdated = false;
        try {
            await bot.api.editMessageText(job.chatId, job.statusMessageId, "Cancelling...");
            statusUpdated = true;
        }
        catch {
            // Ignore
        }
        try {
            job.child.kill("SIGTERM");
        }
        catch {
            // Ignore
        }
        setTimeout(() => {
            try {
                if (running.get(sessionKey) === job) {
                    job.child.kill("SIGKILL");
                }
            }
            catch {
                // Ignore
            }
        }, 5000);
        if (!statusUpdated) {
            await ctx.reply("Cancelling... (may take a few seconds)", topicParams(ctx));
        }
    });
    bot.command("clear", async (ctx) => {
        const userId = ctx.from?.id;
        if (!userId)
            return;
        const isGroup = ctx.chat?.type !== "private";
        const sessionKey = isGroup ? ctx.chat.id : userId;
        const job = running.get(sessionKey);
        if (job && !job.canceled) {
            job.canceled = true;
            job.activity.stop();
            try {
                await bot.api.editMessageText(job.chatId, job.statusMessageId, "Cancelling...");
            }
            catch {
                // Ignore
            }
            try {
                job.child.kill("SIGTERM");
            }
            catch {
                // Ignore
            }
            setTimeout(() => {
                try {
                    if (running.get(sessionKey) === job)
                        job.child.kill("SIGKILL");
                }
                catch {
                    // Ignore
                }
            }, 5000);
        }
        sessionStore.resetSession(sessionKey);
        await ctx.reply("Conversation cleared. Claude won't remember previous messages.", topicParams(ctx));
    });
    // --- Text message handler ---
    bot.on("message:text", async (ctx) => {
        const userId = ctx.from?.id;
        const text = ctx.message.text;
        if (!userId || !text)
            return;
        // Skip commands (already handled above)
        if (text.startsWith("/"))
            return;
        // In group chats, prefix message with sender's name for context
        const isGroup = ctx.chat?.type !== "private";
        const finalText = isGroup
            ? `[${ctx.from?.first_name || "Unknown"}]: ${text}`
            : text;
        await dispatchToClaude(ctx, finalText);
    });
    return bot;
}
/**
 * Start the bot with graceful shutdown handling.
 */
export async function startBot(config) {
    const modules = await loadModules(config);
    let moduleCtx;
    const bot = createBot(config, {
        modules,
        onModuleContext: (ctx) => {
            moduleCtx = ctx;
        },
    });
    if (moduleCtx) {
        for (const mod of modules) {
            if (!mod.init)
                continue;
            console.log(`[claude-telegram] Init module: ${mod.name}`);
            await mod.init(moduleCtx);
        }
    }
    setupGracefulShutdown(() => bot.stop(), {
        timeout: 30_000,
        beforeExit: async () => {
            for (const mod of [...modules].reverse()) {
                if (!mod.dispose)
                    continue;
                try {
                    await mod.dispose();
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`[claude-telegram] Module "${mod.name}" dispose() failed: ${msg}`);
                }
            }
        },
    });
    console.log(`[claude-telegram] Starting bot...`);
    console.log(`[claude-telegram] Workspace: ${config.workspace}`);
    console.log(`[claude-telegram] Permission mode: ${config.permissionMode}`);
    console.log(`[claude-telegram] Whitelist: ${config.whitelist.length > 0 ? config.whitelist.join(", ") : "(empty — no one can access)"}`);
    console.log(`[claude-telegram] Modules: ${modules.length > 0 ? modules.map((m) => m.name).join(", ") : "(none)"}`);
    await bot.start({
        onStart: () => console.log("[claude-telegram] Bot is running"),
    });
}
//# sourceMappingURL=bot.js.map