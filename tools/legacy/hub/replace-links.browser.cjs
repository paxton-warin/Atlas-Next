/* Atlas Link Dispenser: paste into the signed-in dispenser tab's DevTools console.
 * This uses existing administrator APIs. It never calls AWS or node endpoints.
 * Before use, save a full PostgreSQL dump: link JSON does not restore history.
 */
(function (root) {
  "use strict";
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const fail = (message) => {
    throw new Error(message);
  };
  function parseImport(text) {
    if (
      typeof text !== "string" ||
      new TextEncoder().encode(text).length > 1_500_000
    )
      fail("Choose a frontend import text file smaller than 1.5 MB.");
    const lines = text
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.length || lines.length > 5000)
      fail("The import must contain between 1 and 5,000 frontend links.");
    const seen = new Set();
    return lines.map((line, index) => {
      const delimiter = line.includes("|")
        ? "|"
        : line.includes("\t")
          ? "\t"
          : null;
      const parts = delimiter
        ? line.split(delimiter).map((s) => s.trim())
        : [line];
      let value;
      try {
        value = new URL(parts[parts.length - 1]);
      } catch {
        fail(`Invalid URL on line ${index + 1}.`);
      }
      if (
        value.protocol !== "https:" ||
        !/^d[a-z0-9]+\.cloudfront\.net$/.test(value.hostname) ||
        value.port ||
        value.username ||
        value.password ||
        value.pathname !== "/" ||
        value.search ||
        value.hash
      )
        fail(
          `Line ${index + 1} must be an HTTPS CloudFront frontend root URL, without a path, query, or fragment.`,
        );
      const url = value.href;
      if (seen.has(url))
        fail(
          `Duplicate URL on line ${index + 1}. Remove the duplicate before replacing links.`,
        );
      seen.add(url);
      return {
        name: (parts.length > 1
          ? parts.slice(0, -1).join(" ")
          : value.hostname
        ).slice(0, 160),
        url,
      };
    });
  }
  function validateSnapshot(links) {
    if (
      !Array.isArray(links) ||
      links.some(
        (l) =>
          !l ||
          !uuid.test(l.id) ||
          typeof l.url !== "string" ||
          typeof l.enabled !== "boolean",
      )
    )
      fail("Unexpected link snapshot. No links were removed.");
    const ids = new Set();
    for (const link of links) {
      if (ids.has(link.id))
        fail("Duplicate IDs in link snapshot. No links were removed.");
      ids.add(link.id);
      try {
        new URL(link.url);
      } catch {
        fail("Invalid URL in link snapshot. No links were removed.");
      }
    }
    return links;
  }
  function normalized(url) {
    return new URL(url).href;
  }
  function planReplacement(links, desired) {
    validateSnapshot(links);
    const urls = new Set(desired.map((l) => l.url));
    return {
      remove: links.filter((l) => !urls.has(normalized(l.url))),
      keep: links.filter((l) => urls.has(normalized(l.url))),
    };
  }
  async function replaceLinks({
    text,
    fetch,
    download,
    confirm,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    report = () => {},
  }) {
    const progress = {
      outcome: "started",
      requested: 0,
      imported: 0,
      skipped: 0,
      deleted: 0,
      assignmentsDeleted: 0,
      reportsDeleted: 0,
      plannedDeletes: 0,
    };
    let csrf;
    const request = async (route, method = "GET", body) => {
      const response = await fetch(route, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...(method !== "GET" ? { "x-csrf-token": csrf } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok)
        fail(
          `Operation stopped: HTTP ${response.status}. No retry was attempted; review progress before starting again.`,
        );
      try {
        return await response.json();
      } catch {
        fail("Operation stopped: unexpected API response.");
      }
    };
    try {
      const desired = parseImport(text);
      progress.requested = desired.length;
      const session = await request("/api/session");
      if (
        session.user?.role !== "admin" ||
        session.user?.status !== "active" ||
        typeof session.csrfToken !== "string" ||
        !session.csrfToken
      )
        fail(
          "Sign in as an active administrator on the dispenser, then run this helper again.",
        );
      csrf = session.csrfToken;
      const original = validateSnapshot(
        (await request("/api/admin/links")).links,
      );
      const plan = planReplacement(original, desired);
      progress.plannedDeletes = plan.remove.length;
      try {
        await download({
          format: "atlas-link-pool-snapshot-v1",
          exportedAt: new Date().toISOString(),
          links: original,
        });
      } catch {
        fail(
          "The old-link snapshot download failed. No mutations were attempted.",
        );
      }
      const summary = {
        oldCount: original.length,
        desiredCount: desired.length,
        removeCount: plan.remove.length,
        retainedCount: plan.keep.length,
        confirmation: `REPLACE ${plan.remove.length} WITH ${desired.length}`,
      };
      if (!(await confirm(summary)))
        return { ...progress, outcome: "cancelled" };
      // Import first: all desired URLs must exist before any old link is removed.
      const imported = await request("/api/admin/links/bulk", "POST", {
        text: desired.map((l) => `${l.name} | ${l.url}`).join("\n"),
      });
      if (!Array.isArray(imported.inserted) || !Array.isArray(imported.skipped))
        fail("Unexpected import response. Original links were not removed.");
      progress.imported = imported.inserted.length;
      progress.skipped = imported.skipped.length;
      const current = validateSnapshot(
        (await request("/api/admin/links")).links,
      );
      const currentByUrl = new Map(current.map((l) => [normalized(l.url), l]));
      if (desired.some((l) => currentByUrl.get(l.url)?.enabled !== true))
        fail(
          "At least one replacement link is missing or disabled. Original links were not removed; review the pool and enable intended existing links before retrying.",
        );
      const currentById = new Map(current.map((l) => [l.id, l]));
      if (
        plan.remove.some(
          (l) => currentById.has(l.id) && currentById.get(l.id).url !== l.url,
        )
      )
        fail(
          "An original link changed during preparation. Original links were not removed; review changes and run again.",
        );
      report({ ...progress, outcome: "replacement_verified" });
      for (const oldLink of plan.remove) {
        if (!currentById.has(oldLink.id)) continue;
        // Only original reviewed IDs are eligible; concurrent additions are untouched.
        await sleep(250);
        const result = await request(
          `/api/admin/links/${oldLink.id}`,
          "DELETE",
        );
        if (
          result.ok !== true ||
          result.deleted !== true ||
          !Number.isInteger(result.assignments) ||
          !Number.isInteger(result.reports)
        )
          fail(
            "Unexpected delete response. The last deletion may have completed; review the pool before retrying.",
          );
        progress.deleted++;
        progress.assignmentsDeleted += result.assignments;
        progress.reportsDeleted += result.reports;
        report({ ...progress, outcome: "deleting" });
      }
      const final = validateSnapshot((await request("/api/admin/links")).links);
      const finalUrls = new Set(
        final.filter((l) => l.enabled).map((l) => normalized(l.url)),
      );
      const finalIds = new Set(final.map((l) => l.id));
      if (
        desired.some((l) => !finalUrls.has(l.url)) ||
        plan.remove.some((l) => finalIds.has(l.id))
      )
        fail(
          "Final verification found a changed pool. Review progress and current links before retrying.",
        );
      return { ...progress, outcome: "complete" };
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error("Operation stopped.");
      failure.progress = { ...progress, outcome: "stopped" };
      throw failure;
    }
  }
  function launchBrowser() {
    if (root.document.getElementById("atlas-replace-links-operator")) {
      root.alert("The link replacement helper is already open.");
      return;
    }
    const panel = root.document.createElement("section");
    panel.id = "atlas-replace-links-operator";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Replace dispenser links");
    panel.style.cssText =
      "position:fixed;z-index:2147483647;inset:24px 24px auto auto;width:min(520px,calc(100vw - 48px));box-sizing:border-box;padding:24px;background:#fff;color:#17202a;border:1px solid #aab7b8;border-radius:12px;box-shadow:0 8px 36px #0005;font:14px/1.5 system-ui;";
    const append = (tag, text) => {
      const element = root.document.createElement(tag);
      element.textContent = text;
      panel.append(element);
      return element;
    };
    append("h2", "Replace dispenser links");
    append(
      "p",
      "First save a full PostgreSQL backup. This replaces the global link pool: removed links lose their assignments, reports and health history, freeing affected weekly quota. Users, Google configuration and AWS distributions stay unchanged.",
    );
    append(
      "p",
      "Select frontend-import.txt, containing only Atlas frontend links—not node endpoints or this dispenser. Existing URLs are retained. A link-only JSON snapshot downloads before confirmation; it does not restore deleted history. Avoid concurrent link edits.",
    );
    const button = append("button", "Choose frontend-import.txt");
    button.type = "button";
    const close = append("button", "Close");
    close.type = "button";
    close.style.marginLeft = "12px";
    const status = append("p", "Waiting for a file.");
    status.setAttribute("role", "status");
    const input = root.document.createElement("input");
    input.type = "file";
    input.accept = ".txt,text/plain";
    input.hidden = true;
    panel.append(input);
    close.onclick = () => panel.remove();
    button.onclick = () => input.click();
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      button.disabled = true;
      close.disabled = true;
      try {
        if (file.size > 1_500_000)
          fail("Choose a text file smaller than 1.5 MB.");
        const result = await replaceLinks({
          text: await file.text(),
          fetch: root.fetch.bind(root),
          download: async (snapshot) => {
            const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
              type: "application/json",
            });
            const url = URL.createObjectURL(blob);
            const anchor = root.document.createElement("a");
            anchor.href = url;
            anchor.download = `atlas-links-before-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
            root.document.body.append(anchor);
            anchor.click();
            anchor.remove();
            root.setTimeout(() => URL.revokeObjectURL(url), 60000);
          },
          confirm: async (summary) =>
            root.prompt(
              `Downloaded the old-link snapshot (${summary.oldCount} links). Confirm the download finished and that you saved a full database backup.\n\nImport ${summary.desiredCount} frontend links; retain ${summary.retainedCount} existing links; permanently remove ${summary.removeCount} old links and their assignment/report/health history. This restores affected quota usage. AWS distributions are untouched.\n\nType exactly: ${summary.confirmation}`,
            ) === summary.confirmation,
          report: (progress) => {
            status.textContent = `Verified replacement supply. Removed ${progress.deleted} of ${progress.plannedDeletes} reviewed old links.`;
          },
        });
        status.textContent =
          result.outcome === "cancelled"
            ? "Cancelled. No changes made."
            : `Complete: ${result.imported} imported, ${result.skipped} existing URLs retained, ${result.deleted} old links removed. Refresh Links to see the pool.`;
      } catch (error) {
        const counts = error.progress;
        status.textContent = `${error.message} ${counts ? `Completed: ${counts.imported} imports and ${counts.deleted} deletions. Keep the downloaded snapshot and database backup.` : ""}`;
      } finally {
        button.disabled = false;
        close.disabled = false;
        input.value = "";
      }
    };
    root.document.body.append(panel);
  }
  const api = { parseImport, planReplacement, replaceLinks };
  if (
    typeof module === "object" &&
    module.exports &&
    typeof process === "object" &&
    process.versions?.node
  )
    module.exports = api;
  else launchBrowser();
})(globalThis);
