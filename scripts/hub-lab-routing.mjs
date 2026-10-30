/** Main's ticket relay lives in the runtime; trusted owners stay in the app. */
export function labUpstreamPort(front, fallback, path, ports) {
  return front === ports.atlas &&
    String(path).split("?")[0].startsWith("/relay/")
    ? ports.runtimeInternal
    : fallback;
}
export function labTransitionBlocksUpgrade(path) {
  // Trusted storage/cookie ownership sockets may finish a pending profile upload.
  return !/^\/browse\/(?:storage|cookies)\/owner\//.test(
    String(path).split("?")[0],
  );
}
