/**
 * Attention's local browser capability, independent of WeChat transport.
 * Installation/authorization wiring must construct the trusted authority and
 * explicitly connect the returned MCP server. Importing this module opens no
 * browser and does not silently grant any permission.
 */
export { createBrowserMcpServer } from "./mcp-server.js";
export { BrowserTaskManager, type BrowserAuthority } from "./task-manager.js";
export { PlaywrightBrowserEngine } from "./playwright-engine.js";
export { BrowserGrantSchema, BrowserTaskError, BrowserTaskResultSchema } from "./contracts.js";
