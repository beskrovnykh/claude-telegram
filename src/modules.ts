import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import type { Bot, Context } from "grammy";
import type { SessionStore } from "./session.js";
import type { BotConfig, ModuleConfig } from "./types.js";

export type DispatchToClaude = (ctx: Context, message: string) => Promise<void>;

export interface ModuleContext {
  bot: Bot;
  config: BotConfig;
  sessionStore: SessionStore;
  dispatchToClaude: DispatchToClaude;
}

export interface ModuleCommandHelp {
  command: string; // include leading "/"
  description: string;
}

export interface BotModule {
  name: string;
  commands?: ModuleCommandHelp[];

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
 * Load modules from config. Relative file paths are resolved against `config.workspace`.
 */
export async function loadModules(config: BotConfig): Promise<BotModule[]> {
  const specs = config.modules ?? [];
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

