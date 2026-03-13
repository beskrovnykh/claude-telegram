import { type ChildProcess } from "node:child_process";
import type { BotConfig, ClaudeResult, StreamJsonEvent } from "./types.js";
import type { SessionStore } from "./session.js";
/**
 * Send a signal to the entire process group (child + all descendants).
 * This mimics Ctrl+C behavior in a terminal.
 */
export declare function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void;
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