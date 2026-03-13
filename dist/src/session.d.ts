export declare class SessionStore {
    private filePath;
    private sessions;
    private namespace?;
    private freshSessions;
    constructor(workspace: string, namespace?: string);
    private load;
    private save;
    /**
     * Get or create a session ID for a user.
     * Returns { sessionId, isNew } where isNew indicates first message.
     */
    getSession(userId: number): {
        sessionId: string;
        isNew: boolean;
    };
    /**
     * Mark a fresh session as confirmed (no longer new).
     */
    confirmSession(userId: number): void;
    /**
     * Reset session for a user (generates new random UUID).
     */
    resetSession(userId: number): string;
    /**
     * Mark a session as needing a fresh start (e.g., after resume failure).
     * Replaces the session with a new random UUID.
     */
    refreshSession(userId: number): string;
}
//# sourceMappingURL=session.d.ts.map