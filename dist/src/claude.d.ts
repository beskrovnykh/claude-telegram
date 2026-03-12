import { type ChildProcess } from "node:child_process";
import type { BotConfig, ClaudeResult, StreamJsonEvent } from "./types.js";
import type { SessionStore } from "./session.js";
export interface RunClaudeOptions {
    config: BotConfig;
    sessionStore: SessionStore;
    userId: number;
    message: string;
    onEvent?: (event: StreamJsonEvent) => void;
}
/**
 * Run Claude CLI as a subprocess with stream-json parsing.
 */
export declare function runClaude(options: RunClaudeOptions): {
    promise: Promise<ClaudeResult>;
    child: ChildProcess;
};
//# sourceMappingURL=claude.d.ts.map