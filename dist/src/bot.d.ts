import { Bot } from "grammy";
import type { BotConfig } from "./types.js";
import { type BotModule, type ModuleContext } from "./modules.js";
export interface CreateBotOptions {
    modules?: BotModule[];
    onModuleContext?: (ctx: ModuleContext) => void;
}
/**
 * Create and configure a Grammy bot connected to Claude CLI.
 */
export declare function createBot(config: BotConfig, options?: CreateBotOptions): Bot;
/**
 * Start the bot with graceful shutdown handling.
 */
export declare function startBot(config: BotConfig): Promise<void>;
//# sourceMappingURL=bot.d.ts.map