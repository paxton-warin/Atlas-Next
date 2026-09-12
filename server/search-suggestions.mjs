// Copied from ../Atlas/apps/gateway/src/searchSuggestions.ts; TypeScript annotations removed.
const endpoint =
  "https://suggestqueries.google.com/complete/search?client=firefox&q=";

export async function fetchSearchSuggestions(query, fetcher = fetch) {
  const response = await fetcher(
    `${endpoint}${encodeURIComponent(query.trim())}`,
    {
      redirect: "error",
      headers: { accept: "application/json", "user-agent": "Atlas/1.0" },
      signal: AbortSignal.timeout(3_000),
    },
  );
  if (!response.ok) return [];
  const body = await response.json();
  const values = Array.isArray(body) && Array.isArray(body[1]) ? body[1] : [];
  return [
    ...new Set(
      values
        .filter((value) => typeof value === "string")
        .map((value) => value.trim().slice(0, 160))
        .filter(Boolean),
    ),
  ].slice(0, 5);
}
