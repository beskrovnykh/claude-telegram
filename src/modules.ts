import { resolve as resolvePath } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Bot, Context } from "grammy";
import type { SessionStore } from "./session.js";
import type { BotConfig, ClaudeResult, ModuleConfig } from "./types.js";

export type DispatchToClaude = (ctx: Context, message: string) => Promise<void>;

export interface ModuleContext {
  bot: Bot;
  config: BotConfig;
  sessionStore: SessionStore;
  dispatchToClaude: DispatchToClaude;
}

export type BeforeClaudeHookResult =
  | { action: "continue"; message?: string }
  | { action: "deny"; reply?: string };

export type BeforeClaudeHook = (
  ctx: Context,
  message: string
) => BeforeClaudeHookResult | void | Promise<BeforeClaudeHookResult | void>;

export type AfterClaudeHook = (
  ctx: Context,
  result: ClaudeResult
) => ClaudeResult | void | Promise<ClaudeResult | void>;

export interface ModuleCommandHelp {
  command: string; // include leading "/"
  description: string;
}

export interface BotModule {
  name: string;
  commands?: ModuleCommandHelp[];

  /**
   * Optional hook executed right before the message is sent to Claude.
   * Use it for:
   * - security checks (deny with an optional reply)
   * - "memory" retrieval / prompt augmentation (return modified message)
   */
  beforeClaude?: BeforeClaudeHook;

  /**
   * Optional hook executed after Claude finishes (success or error),
   * before the final response is sent to the user.
   * Use it for:
   * - "memory" persistence
   * - output post-processing / redaction
   */
  afterClaude?: AfterClaudeHook;

  /**
   * Register Telegram handlers (commands, message types, middleware).
   * Must be synchronous. Do async work inside handlers or `init()`.
   */
  register?: (ctx: ModuleContext) => void;

  /**
   * Optional startup hook. Called by `startBot()` before polling begins.
   */
  init?: (ctx: ModuleContext) => void | Promise<void>;

  /**
   * Optional shutdown hook. Called on SIGINT/SIGTERM before process exit.
   */
  dispose?: () => void | Promise<void>;
}

function isFileLikeSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("file:") ||
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/") ||
    specifier.endsWith(".js") ||
    specifier.endsWith(".mjs") ||
    specifier.endsWith(".cjs")
  );
}

function toImportTarget(config: BotConfig, specifier: string): string {
  if (specifier.startsWith("file:")) return specifier;

  if (isFileLikeSpecifier(specifier)) {
    const abs = resolvePath(config.workspace, specifier);
    return pathToFileURL(abs).href;
  }

  // Treat as a package specifier.
  return specifier;
}

async function instantiateModule(
  config: BotConfig,
  spec: ModuleConfig
): Promise<BotModule> {
  const importSpec = typeof spec === "string" ? spec : spec.import;
  const options = typeof spec === "string" ? undefined : spec.options;
  const target = toImportTarget(config, importSpec);

  const ns = await import(target);

  const exported =
    ns?.default ?? ns?.module ?? ns?.createModule ?? ns?.create ?? ns;

  if (typeof exported === "function") {
    const created = await exported(options);
    if (!created || typeof created !== "object") {
      throw new Error(
        `Module factory for "${importSpec}" did not return an object`
      );
    }
    return created as BotModule;
  }

  if (exported && typeof exported === "object") {
    return exported as BotModule;
  }

  throw new Error(
    `Module "${importSpec}" must export a default object or factory function`
  );
}

/**
 * Expand module specs: if a spec points to a directory, scan it for .mjs/.js files.
 */
function expandModuleSpecs(config: BotConfig): ModuleConfig[] {
  const specs = config.modules ?? [];
  const expanded: ModuleConfig[] = [];

  for (const spec of specs) {
    const importSpec = typeof spec === "string" ? spec : spec.import;

    // Only expand file-like specifiers (not package names).
    if (!isFileLikeSpecifier(importSpec)) {
      expanded.push(spec);
      continue;
    }

    const abs = resolvePath(config.workspace, importSpec);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      // Not a directory (or doesn't exist) — keep as-is, let instantiate handle the error.
      expanded.push(spec);
      continue;
    }

    if (!isDir) {
      expanded.push(spec);
      continue;
    }

    // Scan directory for module files.
    const files = readdirSync(abs)
      .filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))
      .sort();

    for (const file of files) {
      const filePath = resolvePath(abs, file);
      if (typeof spec === "string") {
        expanded.push(filePath);
      } else {
        // Propagate options/enabled from the directory spec to each file.
        expanded.push({ ...spec, import: filePath });
      }
    }
  }

  return expanded;
}

/**
 * Load modules from config. Relative file paths are resolved against `config.workspace`.
 */
export async function loadModules(config: BotConfig): Promise<BotModule[]> {
  const specs = expandModuleSpecs(config);
  if (specs.length === 0) return [];

  const enabledSpecs = specs.filter((s) => {
    if (typeof s === "string") return true;
    return s.enabled !== false;
  });

  const modules: BotModule[] = [];
  for (const spec of enabledSpecs) {
    const importSpec = typeof spec === "string" ? spec : spec.import;
    try {
      const mod = await instantiateModule(config, spec);
      if (!mod?.name) {
        throw new Error(`Module "${importSpec}" has no "name"`);
      }
      modules.push(mod);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load module "${importSpec}": ${msg}`);
    }
  }

  // Prevent ambiguous command registration and logging.
  const seen = new Set<string>();
  for (const m of modules) {
    if (seen.has(m.name)) {
      throw new Error(`Duplicate module name: "${m.name}"`);
    }
    seen.add(m.name);
  }

  return modules;
}
