import { parentPort, workerData } from "node:worker_threads";
const { literal, surfaces } = workerData;
const end = literal.lastIndexOf("/");
const regex = new RegExp(literal.slice(1, end), literal.slice(end + 1));
const hits = [];
for (const surface of surfaces) {
  regex.lastIndex = 0;
  const match = regex.exec(surface.text);
  if (match)
    hits.push({
      file: surface.file,
      surface: surface.surface,
      offset: match.index,
      matchLength: match[0].length,
    });
}
parentPort.postMessage(hits);
