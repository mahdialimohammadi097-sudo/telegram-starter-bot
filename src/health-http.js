import http from "node:http";

export function startHealthHttpServer({
  port,
  runtimeHealth,
  getBotUsername = () => "PROFINO",
  webhookPath = "/telegram",
  getWebhookHandler = () => null
}) {
  const server = http.createServer(async (req, res) => {
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
      try {
        const handler = getWebhookHandler();
        if (handler) return await handler(req, res);
        res.writeHead(503, { "cache-control": "no-store" });
        return res.end("webhook not configured");
      } catch {
        // Never expose a Telegram or database error to the HTTP client.
        console.error("[health] webhook handler failed");
        if (res.writableEnded || res.destroyed) return;
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(500, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
        return res.end("internal server error");
      }
    }

    if (req.method === "GET" && pathname === "/") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(`@${getBotUsername()} is running`);
    }

    res.writeHead(404);
    res.end();
  });

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
