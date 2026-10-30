/** Registration failures carry status and a fixed code, never tokens, URLs,
 * headers, or a server body. This distinguishes capacity from expired owners. */
export async function registrationFailure(response: Pick<Response, "status" | "json">, phase: string) {
  let code = "HTTP_" + response.status;
  try {
    const value = await response.json();
    const candidate = typeof value?.error === "string" ? value.error : value?.error?.code;
    if (typeof candidate === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,95}$/.test(candidate)) code = candidate;
  } catch { /* Status remains available for non-JSON proxy failures. */ }
  return Object.assign(new Error(`${phase} (HTTP ${response.status}: ${code})`), { code, status: response.status });
}
