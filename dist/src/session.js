import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { v5 as uuidv5, v4 as uuidv4 } from "uuid";
const NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
export class SessionStore {
    filePath;
    sessions;
    namespace;
    freshSessions = new Set();
    constructor(workspace, namespace) {
        const dataDir = join(workspace, "data", ".claude-telegram");
        this.filePath = join(dataDir, "sessions.json");
        this.namespace = namespace;
        if (!existsSync(dataDir)) {
            mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        }
        // Best-effort tighten perms even if the directory already existed.
        try {
            chmodSync(dataDir, 0o700);
        }
        catch {
            // Ignore (e.g. Windows, permission issues).
        }
        this.sessions = this.load();
    }
    load() {
        try {
            if (existsSync(this.filePath)) {
                return JSON.parse(readFileSync(this.filePath, "utf-8"));
            }
        }
        catch {
            // Corrupted file — start fresh
        }
        return {};
    }
    save() {
        writeFileSync(this.filePath, JSON.stringify(this.sessions, null, 2) + "\n", {
            mode: 0o600,
        });
        // Best-effort tighten perms even if the file already existed.
        try {
            chmodSync(this.filePath, 0o600);
        }
        catch {
            // Ignore (e.g. Windows, permission issues).
        }
    }
    /**
     * Get or create a session ID for a user.
     * Returns { sessionId, isNew } where isNew indicates first message.
     */
    getSession(userId) {
        const key = String(userId);
        const existing = this.sessions[key];
        if (existing) {
            return { sessionId: existing, isNew: this.freshSessions.has(key) };
        }
        // Deterministic first session ID
        let sessionId;
        if (this.namespace) {
            // Use custom namespace to seed the generation
            const ns = uuidv5(this.namespace, NAMESPACE);
            sessionId = uuidv5(key, ns);
        }
        else {
            sessionId = uuidv5(key, NAMESPACE);
        }
        this.sessions[key] = sessionId;
        this.save();
        return { sessionId, isNew: true };
    }
    /**
     * Mark a fresh session as confirmed (no longer new).
     */
    confirmSession(userId) {
        this.freshSessions.delete(String(userId));
    }
    /**
     * Reset session for a user (generates new random UUID).
     */
    resetSession(userId) {
        const key = String(userId);
        const sessionId = uuidv4();
        this.sessions[key] = sessionId;
        this.freshSessions.add(key);
        this.save();
        return sessionId;
    }
    /**
     * Mark a session as needing a fresh start (e.g., after resume failure).
     * Replaces the session with a new random UUID.
     */
    refreshSession(userId) {
        return this.resetSession(userId);
    }
}
//# sourceMappingURL=session.js.map