import type { Bot } from "grammy";
import type { StreamJsonEvent } from "./types.js";
interface ActivityStatusOptions {
    api: Bot["api"];
    chatId: number;
    messageId: number;
}
/**
 * Create an activity status updater that edits a Telegram message
 * with current Claude activity and elapsed time.
 */
export declare function createActivityStatus(options: ActivityStatusOptions): {
    onEvent: (event: StreamJsonEvent) => void;
    stop: () => void;
};
export {};
//# sourceMappingURL=activity.d.ts.map