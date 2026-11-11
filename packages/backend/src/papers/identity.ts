export interface PaperIdentity { id: string; arxivId: string; version: number | null; canonicalUrl: string }

function arxivIdentity(value: string): PaperIdentity | null {
  const match = /^(\d{4}\.\d{4,5}|[a-z][a-z.\-]*\/\d{7})(?:v([1-9]\d{0,3}))?$/i.exec(value.trim().replace(/\.pdf$/i, ""));
  if (!match) return null;
  const arxivId = match[1]!.toLowerCase();
  return { id: `arxiv:${arxivId}`, arxivId, version: match[2] ? Number(match[2]) : null, canonicalUrl: `https://arxiv.org/abs/${arxivId}` };
}

/** Recognise document URLs only; a random news article mentioning an ID is not silently a paper. */
export function paperIdentityFromUrl(value: string): PaperIdentity | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (!["https:", "http:"].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let path: string;
  try { path = decodeURIComponent(url.pathname).replace(/\/$/, ""); } catch { return null; }
  if (host === "arxiv.org" || host === "export.arxiv.org") {
    const match = /^\/(?:abs|pdf|html)\/(.+)$/i.exec(path);
    return match ? arxivIdentity(match[1]!) : null;
  }
  if (host === "huggingface.co") {
    const match = /^\/papers\/(.+)$/i.exec(path);
    return match ? arxivIdentity(match[1]!) : null;
  }
  return null;
}

function trustedArxivGuid(documentUrl: string, guid: unknown, direct: PaperIdentity | null): PaperIdentity | null {
  if (!direct || typeof guid !== "string") return null;
  let document: URL;
  try { document = new URL(documentUrl); } catch { return null; }
  const official = (url: URL) => ["arxiv.org", "export.arxiv.org"].includes(url.hostname.toLowerCase().replace(/^www\./, ""))
    && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.port;
  if (!official(document)) return null;
  let parsed: PaperIdentity | null;
  const oai = /^oai:arxiv\.org:(.+)$/i.exec(guid.trim());
  if (oai) parsed = arxivIdentity(oai[1]!);
  else {
    let address: URL;
    try { address = new URL(guid.trim()); } catch { return null; }
    if (!official(address) || address.search || address.hash) return null;
    parsed = paperIdentityFromUrl(address.toString());
  }
  return parsed?.id === direct.id && parsed.version !== null ? parsed : null;
}

/** Explicit collector metadata may supply a version that an unversioned HF URL does not encode. */
export function paperIdentityOf(url: string, raw?: unknown): PaperIdentity | null {
  const direct = paperIdentityFromUrl(url);
  const metadata = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const guid = trustedArxivGuid(url, metadata.guid, direct);
  if (guid && direct?.version === null) return { ...direct, version: guid.version };
  const paper = metadata.paper && typeof metadata.paper === "object" ? metadata.paper as Record<string, unknown> : {};
  const candidates = [metadata.arxivId, metadata.arxiv_id, paper.id];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const parsed = arxivIdentity(value) ?? paperIdentityFromUrl(value);
    if (!parsed || (direct && parsed.id !== direct.id)) continue;
    return direct ? { ...direct, version: direct.version ?? parsed.version } : parsed;
  }
  return direct;
}
