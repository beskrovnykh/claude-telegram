import type { ChildProcess } from "node:child_process";
/**
 * Tracks running Claude CLI processes for graceful shutdown.
 */
declare class ProcessTracker {
    private processes;
    register(child: ChildProcess): void;
    get count(): number;
    waitForAll(timeoutMs: number): Promise<boolean>;
    killAll(signal?: NodeJS.Signals): void;
}
export declare const processTracker: ProcessTracker;
/**
 * Setup graceful shutdown handlers.
 * Stops Grammy polling, waits for Claude processes, then exits.
 */
export declare function setupGracefulShutdown(botStop: () => void, options?: {
    timeout?: number;
    beforeExit?: () => void | Promise<void>;
}): void;
export {};
//# sourceMappingURL=shutdown.d.ts.map