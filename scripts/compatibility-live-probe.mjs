#!/usr/bin/env node
// Read-only, logged-out HTTP evidence; never stores cookies, bodies or credentials.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const targets = [
  "https://www.espn.com/",
  "https://chatgpt.com/",
  "https://example.com/",
];
const nodes = process.argv.includes("--nodes")
  ? [
      "vps-2.internals.paxton.co",
      "vps-3.internals.paxton.co",
      "vps-4.internals.paxton.co",
    ]
  : [];
const results = [];
for (const host of [null, ...nodes])
  for (const url of targets) {
    const command = "curl";
    const args = [
      "--silent",
      "--show-error",
      "--location",
      "--max-redirs",
      "5",
      "--connect-timeout",
      "5",
      "--max-time",
      "15",
      "--output",
      "/dev/null",
      "--write-out",
      "%{http_code}",
    ];
    const response = host
      ? spawnSync(
          "ssh",
          [
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=5",
            "root@" + host,
            command,
            ...args,
            url,
          ],
          { encoding: "utf8", timeout: 25000 },
        )
      : spawnSync(command, [...args, url], {
          encoding: "utf8",
          timeout: 25000,
        });
    results.push({
      egress: host || "local",
      site: new URL(url).hostname,
      status: Number(response.stdout) || null,
      result: response.status === 0 ? "observed" : "probe-unavailable",
      exit: response.status,
    });
  }
const report = {
  checkedAt: new Date().toISOString(),
  kind: "logged-out HTTP only; not a browser/sign-in/playback qualification",
  results,
};
writeFileSync(
  "evidence/client-compatibility-20261013/live-http.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
