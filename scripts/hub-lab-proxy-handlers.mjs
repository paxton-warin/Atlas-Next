/** Loopback lab proxy dispatch. No listener, TLS secret, database or AWS access. */
import { request as nativeRequest } from "node:http";
import { connect as nativeConnect } from "node:net";
import {
  labUpstreamPort,
  labTransitionBlocksUpgrade,
} from "./hub-lab-routing.mjs";

function snapshot(request) {
  // A disconnected socket can lose remoteAddress while cloud routing awaits.
  // Capture all peer-dependent data synchronously, before the first await.
  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(([, value]) => value !== undefined),
  );
  const peer = request.socket?.remoteAddress;
  delete headers["x-forwarded-for"];
  headers["x-forwarded-proto"] = "https";
  if (typeof headers.host === "string")
    headers["x-forwarded-host"] = headers.host;
  else delete headers["x-forwarded-host"];
  if (typeof peer === "string" && peer) headers["x-forwarded-for"] = peer;
  return {
    headers,
    socket: request.socket,
    origin: "https://" + headers.host,
    method: request.method || "GET",
    url: request.url || "/",
    path: (request.url || "/").split("?")[0],
  };
}

export function createLabProxyHandlers({
  front,
  back,
  ports,
  cloud,
  httpRequest = nativeRequest,
  connect = nativeConnect,
}) {
  function http(request, response) {
    const input = snapshot(request);
    let upstream,
      result,
      cancelled = false;
    const closed = () =>
      cancelled ||
      request.aborted ||
      response.destroyed ||
      response.writableEnded ||
      input.socket?.destroyed;
    const cancel = () => {
      cancelled = true;
      result?.destroy();
      upstream?.destroy();
    };
    const fail = () => {
      if (!closed()) {
        try {
          if (!response.headersSent) {
            response.writeHead(503, {
              "content-type": "text/plain",
              "cache-control": "no-store",
            });
            response.end("Local lab service is restarting.");
          } else response.destroy();
        } catch {
          response.destroy();
        }
      }
      cancel();
    };
    request.once("aborted", cancel);
    request.once("error", fail);
    response.once("error", cancel);
    response.once("close", () => {
      // Do not destroy an already-completed reusable upstream connection.
      if (response.writableEnded && result?.complete) cancelled = true;
      else cancel();
    });
    // EventEmitter does not await async listeners. Terminate every async and
    // synchronous dispatch failure here instead of killing the shared proxy.
    void (async () => {
      if (closed() || (await cloud.handle(request, response)) || closed())
        return;
      if (input.path === "/__lab/discovery") {
        const hubOrigin = await cloud.currentHub();
        if (closed()) return;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ hubOrigin }));
        return;
      }
      const route = await cloud.routes(input.origin);
      if (closed()) return;
      if (
        route?.role === "hub" &&
        route.state === "transition" &&
        input.method === "GET" &&
        ["/", "/authorize"].includes(input.path)
      ) {
        response.writeHead(302, {
          location: route.target_origin + input.url,
          "cache-control": "no-store",
        });
        response.end();
        return;
      }
      if (
        route?.role === "frontend" &&
        route.state === "transition" &&
        [
          "/browse/",
          "/api/browse/",
          "/runtime-config",
          "/~/",
          "/wisp/",
          "/bare/",
          "/relay/",
        ].some((prefix) => input.path.startsWith(prefix))
      ) {
        response.writeHead(409, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(
          JSON.stringify({
            error: {
              code: "ENDPOINT_REPLACED",
              message: "Save this browser and continue from Atlas Hub.",
            },
          }),
        );
        return;
      }
      upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: labUpstreamPort(front, back, input.url, ports),
          method: input.method,
          path: input.url,
          headers: input.headers,
        },
        (incoming) => {
          result = incoming;
          if (closed()) {
            cancel();
            return;
          }
          incoming.once("error", fail);
          incoming.once("aborted", fail);
          try {
            if (
              input.path === "/api/hub/state" &&
              route?.role === "frontend" &&
              route.state === "transition"
            ) {
              const chunks = [];
              let bytes = 0;
              incoming.on("data", (chunk) => {
                if (closed()) return;
                bytes += chunk.length;
                if (bytes > 1024 * 1024) {
                  fail();
                  return;
                }
                chunks.push(Buffer.from(chunk));
              });
              incoming.once("end", () => {
                void (async () => {
                  if (closed()) return;
                  const state = JSON.parse(Buffer.concat(chunks).toString());
                  const hubOrigin = await cloud.currentHub();
                  if (closed()) return;
                  state.endpointTransition = {
                    revision: route.revision,
                    hubOrigin,
                    destination: route.target_origin,
                  };
                  const headers = {
                    ...incoming.headers,
                    "content-type": "application/json",
                    "cache-control": "no-store",
                  };
                  delete headers["content-length"];
                  response.writeHead(incoming.statusCode || 502, headers);
                  response.end(JSON.stringify(state));
                })().catch(fail);
              });
            } else {
              response.writeHead(incoming.statusCode || 502, incoming.headers);
              incoming.pipe(response);
            }
          } catch {
            fail();
          }
        },
      );
      upstream.once("error", fail);
      if (closed()) {
        cancel();
        return;
      }
      request.pipe(upstream);
    })().catch(fail);
  }

  function upgrade(request, socket, head) {
    const input = snapshot(request);
    let upstream,
      cancelled = false;
    const closed = () => cancelled || socket.destroyed;
    const cancel = () => {
      cancelled = true;
      upstream?.destroy();
    };
    const fail = () => {
      if (!closed()) {
        try {
          socket.end(
            "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
          );
        } catch {
          socket.destroy();
        }
      }
      cancel();
    };
    socket.once("error", cancel);
    socket.once("close", cancel);
    socket.once("end", () => {
      cancel();
      socket.end();
    });
    request.once("error", fail);
    request.once("aborted", cancel);
    void (async () => {
      const route = await cloud.routes(input.origin);
      if (closed()) return;
      if (
        route?.role === "frontend" &&
        route.state === "transition" &&
        labTransitionBlocksUpgrade(input.url)
      ) {
        socket.end(
          "HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
        return;
      }
      upstream = connect(
        labUpstreamPort(front, back, input.url, ports),
        "127.0.0.1",
        () => {
          if (closed()) {
            cancel();
            return;
          }
          try {
            const headers = Object.entries(input.headers)
              .map(
                ([name, value]) =>
                  `${name}: ${Array.isArray(value) ? value.join(", ") : value}`,
              )
              .join("\r\n");
            upstream.write(
              `${input.method} ${input.url} HTTP/1.1\r\n${headers}\r\n\r\n`,
            );
            if (head.length) upstream.write(head);
            socket.pipe(upstream);
            upstream.pipe(socket);
          } catch {
            fail();
          }
        },
      );
      upstream.once("error", fail);
      upstream.once("close", () => {
        if (!cancelled && !socket.destroyed) socket.destroy();
      });
      if (closed()) cancel();
    })().catch(fail);
  }
  return Object.freeze({ http, upgrade });
}
