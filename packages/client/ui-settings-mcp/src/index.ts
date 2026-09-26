/**
 * MCP settings page, node half. The page reads and writes the MCP config files
 * through the Host's `mcpServers` Remote service, which `dsh-mcp-project-config`
 * mounts; nothing on this side holds configuration or opens a connection.
 */

/** Host plugin body — the management service is provided by `dsh-mcp-project-config`. */
export function apply(): void {}
