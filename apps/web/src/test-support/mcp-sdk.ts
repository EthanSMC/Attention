export { Client } from "@modelcontextprotocol/sdk/client/index.js";
export {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
export { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
export type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
