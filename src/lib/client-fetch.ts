/**
 * fetch() for authenticated admin endpoints. If the session is no longer valid
 * (e.g. the admin was deleted) the server returns 401 and clears the cookie;
 * we send the user to /login so they recover cleanly instead of seeing errors.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.href = "/login";
    // We're navigating away; stop the caller from processing the 401 body.
    await new Promise<never>(() => {});
  }
  return res;
}
