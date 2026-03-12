import type { Bot, Context } from "grammy";
import type { SessionStore } from "./session.js";
import type { BotConfig, ClaudeResult } from "./types.js";
export type DispatchToClaude = (ctx: Context, message: string) => Promise<void>;
export interface ModuleContext {
    bot: Bot;
    config: BotConfig;
    sessionStore: SessionStore;
    dispatchToClaude: DispatchToClaude;
}
export type BeforeClaudeHookResult = {
    action: "continue";
    message?: string;
} | {
    action: "deny";
    reply?: string;
};
export type BeforeClaudeHook = (ctx: Context, message: string) => BeforeClaudeHookResult | void | Promise<BeforeClaudeHookResult | void>;
export type AfterClaudeHook = (ctx: Context, result: ClaudeResult) => ClaudeResult | void | Promise<ClaudeResult | void>;
export interface ModuleCommandHelp {
    command: string;
    description: string;
}
export interface BotModule {
    name: string;
    commands?: ModuleCommandHelp[];
    /**
     * Optional hook executed right before the message is sent to Claude.
     * Use it for:
     * - security checks (deny with an optional reply)
     * - "memory" retrieval / prompt augmentation (return modified message)
     */
    beforeClaude?: BeforeClaudeHook;
    /**
     * Optional hook executed after Claude finishes (success or error),
     * before the final response is sent to the user.
     * Use it for:
     * - "memory" persistence
     * - output post-processing / redaction
     */
    afterClaude?: AfterClaudeHook;
    /**
     * Register Telegram handlers (commands, message types, middleware).
     * Must be synchronous. Do async work inside handlers or `init()`.
     */
    register?: (ctx: ModuleContext) => void;
    /**
     * Optional startup hook. Called by `startBot()` before polling begins.
     */
    init?: (ctx: ModuleContext) => void | Promise<void>;
    /**
     * Optional shutdown hook. Called on SIGINT/SIGTERM before process exit.
     */
    dispose?: () => void | Promise<void>;
}
/**
 * Load modules from config. Relative file paths are resolved against `config.workspace`.
 */
export declare function loadModules(config: BotConfig): Promise<BotModule[]>;
//# sourceMappingURL=modules.d.ts.map