const MIN_UPDATE_INTERVAL_MS = 3_000;
const TOOL_LABELS = {
    Read: "reading",
    Edit: "editing",
    Write: "writing",
    Bash: "command",
    Grep: "searching",
    Glob: "searching",
    WebFetch: "web",
    WebSearch: "web",
    Task: "subagent",
};
const ACTIVITY_DISPLAY = {
    thinking: "💭 Thinking",
    reading: "📖 Reading",
    editing: "✏️ Editing",
    writing: "📝 Writing",
    searching: "🔍 Searching",
    command: "🔧 Running command",
    web: "🌐 Web lookup",
    subagent: "🧩 Sub-agent",
    mcp: "🔌 MCP tool",
};
function formatElapsed(ms) {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${String(sec).padStart(2, "0")}`;
}
/**
 * Detect activity from a stream-json event.
 */
function detectActivity(event) {
    if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
            if (block.type === "tool_use" && block.name) {
                // Check known tools
                const key = TOOL_LABELS[block.name];
                if (key)
                    return key;
                // MCP tools (mcp__*)
                if (block.name.startsWith("mcp__"))
                    return "mcp";
            }
        }
    }
    return null;
}
/**
 * Create an activity status updater that edits a Telegram message
 * with current Claude activity and elapsed time.
 */
export function createActivityStatus(options) {
    const { api, chatId, messageId } = options;
    const startTime = Date.now();
    let currentLabel = ACTIVITY_DISPLAY.thinking;
    let lastSentText = "";
    let stopped = false;
    const timer = setInterval(sendUpdate, MIN_UPDATE_INTERVAL_MS);
    async function sendUpdate() {
        if (stopped)
            return;
        const elapsed = formatElapsed(Date.now() - startTime);
        const text = `${currentLabel}  ⏱ ${elapsed}`;
        if (text === lastSentText)
            return;
        try {
            await api.editMessageText(chatId, messageId, text);
            lastSentText = text;
        }
        catch {
            // Silently ignore edit failures (rate limit, message deleted, etc.)
        }
    }
    function onEvent(event) {
        if (stopped)
            return;
        const key = detectActivity(event);
        if (key) {
            currentLabel = ACTIVITY_DISPLAY[key];
        }
    }
    function stop() {
        stopped = true;
        clearInterval(timer);
    }
    // Send first update immediately
    void sendUpdate();
    return { onEvent, stop };
}
//# sourceMappingURL=activity.js.map