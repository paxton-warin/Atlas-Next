/** A website's load event is not a deadline: slow scripts/images may still be
 * making progress. Only the separate opaque attestation path has a hard budget. */
export function watchPageLoad(options: {
  clock: Pick<Window, "setTimeout" | "clearTimeout">;
  delayMs: number;
  kind: "website" | "opaque-proof";
  slow(): void;
  expired(): void;
}) {
  let live = true;
  const timer = options.clock.setTimeout(() => {
    if (!live) return;
    live = false;
    if (options.kind === "website") {
      // A presentation observer is not allowed to turn slow progress into failure.
      try { options.slow(); } catch {}
    }
    else {
      options.expired();
    }
  }, options.delayMs);
  return () => {
    live = false;
    options.clock.clearTimeout(timer);
  };
}
