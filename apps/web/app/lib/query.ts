// URL construction is shared by loaders and browser-rendered pagination links.
export function queryString(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined && value !== "") sp.set(key, String(value));
  const query = sp.toString();
  return query ? `?${query}` : "";
}
