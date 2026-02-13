#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { startBot } from "../src/bot.js";
import { Bot } from "grammy";

const args = process.argv.slice(2);
const command = args[0];

function getConfigPath(): string | undefined {
  const configIdx = args.indexOf("--config");
  if (configIdx !== -1 && args[configIdx + 1]) {
    return args[configIdx + 1];
  }
  return undefined;
}

async function cmdStart() {
  const config = loadConfig(getConfigPath());
  await startBot(config);
}

function cmdCheck() {
  console.log("[check] Validating config...");

  let config;
  try {
    config = loadConfig(getConfigPath());
    console.log(`  ✓ Config loaded`);
    console.log(`  ✓ Workspace: ${config.workspace}`);
    console.log(
      `  ✓ Whitelist: ${config.whitelist.length} user(s)`
    );
    console.log(`  ✓ Permission mode: ${config.permissionMode}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ Config error: ${msg}`);
    process.exit(1);
  }

  // Check Claude CLI
  try {
    const version = execFileSync(config.claudePath, ["--version"], {
      encoding: "utf-8",
    }).trim();
    console.log(`  ✓ Claude CLI: ${version}`);
  } catch {
    console.error(`  ✗ Claude CLI not found or not executable: ${config.claudePath}`);
    process.exit(1);
  }

  // Sanity-check required flags used by this package (no API calls).
  try {
    const help = execFileSync(config.claudePath, ["--help"], {
      encoding: "utf-8",
    });
    const required = [
      "--output-format",
      "stream-json",
      "--permission-mode",
      "--resume",
      "--session-id",
    ];
    const missing = required.filter((s) => !help.includes(s));
    if (missing.length > 0) {
      console.error(
        `  ✗ Claude CLI is missing required flags: ${missing.join(", ")}`
      );
      process.exit(1);
    }
    console.log("  ✓ Claude CLI flags look compatible");
  } catch {
    console.error("  ✗ Failed to validate Claude CLI help output");
    process.exit(1);
  }

  console.log("\nAll checks passed.");
}

async function cmdWhoami() {
  // Determine token: from --config or env
  let token: string | undefined;

  try {
    const config = loadConfig(getConfigPath());
    token = config.token;
  } catch {
    // If no config, try env directly
    token = process.env.TELEGRAM_BOT_TOKEN;
  }

  if (!token) {
    console.error(
      "No bot token found. Provide a config file or set TELEGRAM_BOT_TOKEN."
    );
    process.exit(1);
  }

  const bot = new Bot(token);

  bot.on("message", async (ctx) => {
    if (ctx.chat?.type !== "private") {
      try {
        await ctx.reply("Please message me in a private chat.");
      } catch {
        // Ignore
      }
      return;
    }

    const userId = ctx.from?.id;
    const username = ctx.from?.username || "(no username)";
    const name =
      [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") ||
      "(no name)";

    await ctx.reply(
      `Your Telegram info:\n\n` +
        `User ID: ${userId}\n` +
        `Username: @${username}\n` +
        `Name: ${name}\n\n` +
        `Add ${userId} to your whitelist config.`
    );
  });

  console.log("[whoami] Bot started. Send any message to get your user ID.");
  console.log("[whoami] Press Ctrl+C to stop.\n");

  await bot.start();
}

// --- Main ---
switch (command) {
  case "start":
    cmdStart().catch((err) => {
      console.error("Fatal:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
    break;

  case "check":
    cmdCheck();
    break;

  case "whoami":
    cmdWhoami().catch((err) => {
      console.error("Fatal:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
    break;

  default:
    console.log(`claude-telegram — Telegram bot for Claude Code CLI

Usage:
  claude-telegram start [--config path]   Start the bot
  claude-telegram check [--config path]   Validate config & dependencies
  claude-telegram whoami                  Get your Telegram user ID
`);
    if (command && command !== "help" && command !== "--help") {
      process.exit(1);
    }
    break;
}
