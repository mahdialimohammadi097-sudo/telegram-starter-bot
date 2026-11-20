import http from "node:http";

export function startHealthHttpServer({
  port,
  runtimeHealth,
  getBotUsername = () => "PROFINO",
  webhookPath = "/telegram",
  getWebhookHandler = () => null
}) {
  const active = new Map();
  const sockets = new Set();
  let draining;
  const server = http.createServer((req, res) => {
    if (draining) {
      res.writeHead(503, { connection: "close" });
      return res.end();
    }
    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
      res.writeHead(400);
      return res.end();
    }

    if (req.method === "GET" && pathname === "/healthz") {
      const state = runtimeHealth.snapshot();
      res.writeHead(state.ready ? 200 : 503, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      return res.end(JSON.stringify(state));
    }

    if (req.method === "GET" && pathname === "/livez") {
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      });
      return res.end("alive");
    }

    if (req.method === "POST" && (pathname === webhookPath || pathname === "/telegram")) {
      const handler = getWebhookHandler();
      if (handler) {
        const task = Promise.resolve().then(() => handler(req, res)).catch(() => {
          if (res.destroyed || res.writableEnded) return;
          if (res.headersSent) return res.destroy();
          res.writeHead(500, { "cache-control": "no-store" });
          res.end("webhook processing failed");
        }).finally(() => active.delete(req));
        active.set(req, task);
        return;
      }
      res.writeHead(503, { "cache-control": "no-store" });
      return res.end("webhook not configured");
    }

    if (req.method === "GET" && pathname === "/") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(`@${getBotUsername()} is running`);
    }

    res.writeHead(404);
    res.end();
  });

  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.drain = () => {
    if (draining) return draining;
    const closed = new Promise(resolve => server.close(resolve));
    const keep = new Set();
    const work = [];
    for (const [req, task] of active) {
      if (req.complete) {
        keep.add(req.socket);
        work.push(task);
      }
    }
    for (const socket of sockets) {
      if (!keep.has(socket)) socket.destroy();
    }
    const finished = Promise.allSettled(work).then(() => {
      for (const socket of keep) socket.end();
    });
    draining = Promise.all([closed, finished]);
    return draining;
  };

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      console.log(`[health] HTTP endpoints listening on 0.0.0.0:${server.address().port}`);
      resolve(server);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "0.0.0.0");
  });
}
