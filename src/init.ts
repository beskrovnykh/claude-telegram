import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

function configTemplate(token: string, whitelist: number[], permissionMode: string): string {
  return `token: ${token}
workspace: .
whitelist:
${whitelist.map((id) => `  - ${id}`).join("\n")}

permission_mode: ${permissionMode}

modules:
  - ./modules/    # auto-discover all .mjs files
`;
}

function claudeMdTemplate(): string {
  return `# Workspace CLAUDE.md

You are running as a Telegram bot via **claude-telegram**.
Users interact with you through Telegram messages.

## Creating Modules

You can extend the bot by creating module files in the \`modules/\` directory.
After creating a module, tell the user to send \`/reload\` in Telegram to activate it.

### Module API

Each module is an \`.mjs\` file that exports a factory function returning a module object:

\`\`\`js
export default function createModule(options) {
  return {
    name: "my-module",  // required, unique

    // Optional: declare commands for /help listing
    commands: [{ command: "/mycommand", description: "Does something" }],

    // Register Grammy bot handlers (commands, middleware)
    register({ bot, config, sessionStore, dispatchToClaude }) {
      bot.command("mycommand", async (ctx) => {
        await ctx.reply("Hello!");
      });
    },

    // Hook: runs before message is sent to Claude
    // Return { action: "continue" } to proceed (optionally with modified message)
    // Return { action: "deny", reply: "reason" } to block the message
    async beforeClaude(ctx, message) {
      return { action: "continue" };
    },

    // Hook: runs after Claude responds, before sending to user
    // Return modified result or void to keep original
    async afterClaude(ctx, result) {
      // result: { success, output, error, sessionId, costUsd, durationMs }
      return result;
    },

    // Optional lifecycle hooks
    async init({ bot, config }) { /* startup */ },
    async dispose() { /* shutdown cleanup */ },
  };
}
\`\`\`

### ModuleContext

The \`register()\` and \`init()\` functions receive a \`ModuleContext\` with:
- \`bot\` — Grammy Bot instance (register handlers, middleware)
- \`config\` — Resolved bot config
- \`sessionStore\` — User session manager (getSessionId, resetSession)
- \`dispatchToClaude\` — Send a message to Claude on behalf of a user

### Conventions

- File must be \`.mjs\` (ES modules)
- Module \`name\` must be unique across all modules
- Grammy handlers are additive — new commands from modules require a bot restart
- Hooks (\`beforeClaude\`/\`afterClaude\`) are reloaded immediately on \`/reload\`
- Keep modules focused and small

## Workspace Structure

\`\`\`
.
├── claude-telegram.yaml   # Bot configuration
├── CLAUDE.md              # This file (agent instructions)
├── modules/               # Custom modules (auto-discovered)
│   └── example.mjs
└── data/                  # Runtime data (sessions, etc.)
\`\`\`
`;
}

function exampleModuleTemplate(): string {
  return `export default function createModule() {
  return {
    name: "example",
    commands: [{ command: "/ping", description: "Ping the bot" }],

    register({ bot }) {
      bot.command("ping", async (ctx) => {
        const ms = Date.now() - (ctx.message?.date ?? 0) * 1000;
        await ctx.reply(\`Pong! (\${ms}ms)\`);
      });
    },

    async beforeClaude(ctx, message) {
      return { action: "continue" };
    },

    async afterClaude(ctx, result) {
      return result;
    },
  };
}
`;
}

function gitignoreTemplate(): string {
  return `data/
.env*
node_modules/
`;
}

export async function runInit(targetDir?: string): Promise<void> {
  const dir = resolve(targetDir || ".");
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    console.log("[init] Setting up claude-telegram workspace\n");

    // Check existing config
    const configPath = join(dir, "claude-telegram.yaml");
    if (existsSync(configPath)) {
      const overwrite = await rl.question(
        "claude-telegram.yaml already exists. Overwrite? (y/N) "
      );
      if (overwrite.toLowerCase() !== "y") {
        console.log("Aborted.");
        return;
      }
    }

    // Bot token
    const tokenAnswer = await rl.question(
      "Bot token [${TELEGRAM_BOT_TOKEN}]: "
    );
    const token = tokenAnswer.trim() || "${TELEGRAM_BOT_TOKEN}";

    // Whitelist
    console.log(
      "\nTip: run `npx claude-telegram whoami` to find your Telegram user ID."
    );
    const whitelistAnswer = await rl.question(
      "Whitelist user IDs (comma-separated): "
    );
    const whitelist = whitelistAnswer
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => !isNaN(n) && n > 0);

    if (whitelist.length === 0) {
      console.log(
        "  Warning: empty whitelist — no one will be able to use the bot."
      );
    }

    // Permission mode
    console.log("\nPermission modes:");
    console.log("  1. acceptEdits (default) — auto-accept file edits");
    console.log("  2. default — ask for confirmation on each edit");
    console.log("  3. bypassPermissions — skip all permission checks");
    const modeAnswer = await rl.question("Permission mode [1]: ");
    const modeMap: Record<string, string> = {
      "1": "acceptEdits",
      "2": "default",
      "3": "bypassPermissions",
      "": "acceptEdits",
      acceptEdits: "acceptEdits",
      default: "default",
      bypassPermissions: "bypassPermissions",
    };
    const permissionMode = modeMap[modeAnswer.trim()] || "acceptEdits";

    // Create directory structure
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "modules"), { recursive: true });

    // Write files
    writeFileSync(configPath, configTemplate(token, whitelist, permissionMode));
    console.log(`  Created claude-telegram.yaml`);

    const claudeMdPath = join(dir, "CLAUDE.md");
    if (!existsSync(claudeMdPath)) {
      writeFileSync(claudeMdPath, claudeMdTemplate());
      console.log(`  Created CLAUDE.md`);
    } else {
      console.log(`  Skipped CLAUDE.md (already exists)`);
    }

    const examplePath = join(dir, "modules", "example.mjs");
    if (!existsSync(examplePath)) {
      writeFileSync(examplePath, exampleModuleTemplate());
      console.log(`  Created modules/example.mjs`);
    } else {
      console.log(`  Skipped modules/example.mjs (already exists)`);
    }

    const gitignorePath = join(dir, ".gitignore");
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, gitignoreTemplate());
      console.log(`  Created .gitignore`);
    } else {
      console.log(`  Skipped .gitignore (already exists)`);
    }

    console.log("\n--- Next steps ---");
    console.log(`1. ${token === "${TELEGRAM_BOT_TOKEN}" ? "Set TELEGRAM_BOT_TOKEN environment variable" : "Token is embedded in config"}`);
    if (whitelist.length === 0) {
      console.log("2. Add your user ID to the whitelist (run: npx claude-telegram whoami)");
    }
    console.log(`${whitelist.length === 0 ? "3" : "2"}. Validate: npx claude-telegram check${targetDir ? ` --config ${configPath}` : ""}`);
    console.log(`${whitelist.length === 0 ? "4" : "3"}. Start:    npx claude-telegram start${targetDir ? ` --config ${configPath}` : ""}`);
  } finally {
    rl.close();
  }
}
