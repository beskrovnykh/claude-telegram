# Security

claude-telegram includes all the essential security primitives out of the box:

- **Telegram whitelist** — only approved user IDs can interact with the bot
- **Permission modes** — `default`, `acceptEdits`, `bypassPermissions` control what Claude can do
- **Tool restrictions** — `tools`, `allowed_tools`, `disallowed_tools` let you limit Claude's capabilities
- **Slash command toggle** — `disable_slash_commands: true` to reduce attack surface
- **Settings source control** — `setting_sources` to ignore workspace-local overrides
- **MCP lockdown** — `strict_mcp_config: true` to disable MCP unless explicitly configured
- **Error sanitization** — tokens and paths are redacted from error messages

These controls cover the most common deployment scenarios.

## Advanced Security

For production deployments that need hard isolation, DLP, audit logging, and other advanced security features, check out **[Radius](https://github.com/bluzir/radius)** — a security layer purpose-built for claude-telegram.
