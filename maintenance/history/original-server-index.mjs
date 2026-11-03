import { createApp, defaults } from "./app.mjs";
import { createRuntime } from "./runtime.mjs";
const config = defaults();
const app = await createApp(config);
const runtime = await createRuntime({
  ...config,
  fixture:
    process.env.NODE_ENV === "test" && process.env.ATLAS_TEST_FIXTURE === "1",
});
await runtime.listen({
  port: Number(process.env.RUNTIME_PORT || 4181),
  host: process.env.HOST || "127.0.0.1",
});
await app.listen({
  port: Number(process.env.PORT || 4180),
  host: process.env.HOST || "127.0.0.1",
});
console.log(
  `Atlas: ${config.appOrigin}\nRuntime: ${config.runtimeOrigin}\nAdmin: ${config.appOrigin}${config.adminPath}`,
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    for (const s of [runtime, app]) s.server.closeAllConnections?.();
    await Promise.all([runtime.close(), app.close()]);
    process.exit(0);
  });
