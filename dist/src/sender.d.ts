import type { Context } from "grammy";
/**
 * Send a potentially long message, splitting into chunks
 * and formatting as MarkdownV2.
 */
export declare function sendMessage(ctx: Context, text: string, options?: {
    footer?: string;
}): Promise<void>;
//# sourceMappingURL=sender.d.ts.map