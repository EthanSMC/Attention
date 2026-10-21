import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolvePublicTarget } from "./network-policy.js";
import { bounded } from "./task-manager.js";

/** HTTPS tunnel only: DNS resolves once and the socket connects to that exact
 * validated address. Chromium retains TLS validation and cookies locally. */
export async function createEgressProxy(allowedHosts: ReadonlySet<string>) {
  const username = "attention", password = randomBytes(32).toString("hex");
  const expectedAuth = Buffer.from("Basic " + Buffer.from(username + ":" + password).toString("base64"));
  const sockets = new Set<Socket>();
  let closed = false, connections = 0, bytes = 0;
  const server = createServer((_request, response) => { response.writeHead(403); response.end(); });
  const closeSockets = () => { for (const socket of sockets) socket.destroy(); sockets.clear(); };
  const track = (socket: Socket) => {
    sockets.add(socket); socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", chunk => { bytes += chunk.length; if (bytes > 20 * 1024 * 1024) closeSockets(); });
  };
  server.on("connection", track);
  server.on("connect", (request, client, head) => {
    void (async () => {
      const authorization = Buffer.from(request.headers["proxy-authorization"] ?? "");
      if (authorization.length !== expectedAuth.length || !timingSafeEqual(authorization, expectedAuth)) {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="attention"\r\nConnection: close\r\n\r\n');
        return;
      }
      if (closed || ++connections > 100 || bytes > 20 * 1024 * 1024) { client.destroy(); return; }
      const match = /^([a-z0-9.-]+):443$/.exec(request.url ?? "");
      if (!match) { client.destroy(); return; }
      const target = await bounded(resolvePublicTarget(match[1]!, allowedHosts), AbortSignal.timeout(5000));
      if (closed || client.destroyed) return;
      const upstream = connect({ host: target.address, family: target.family, port: 443 });
      track(upstream);
      upstream.setTimeout(15_000, () => upstream.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
      upstream.once("connect", () => {
        if (closed || client.destroyed || upstream.remoteAddress !== target.address) { upstream.destroy(); return; }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
    })().catch(() => client.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("browser_proxy_unavailable");
  return {
    proxy: { server: "http://127.0.0.1:" + address.port, username, password, bypass: "<-loopback>" },
    async close() {
      closed = true; closeSockets();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
