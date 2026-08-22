/**
 * Mock qBittorrent WebUI fetch implementation.
 * Records every request and routes by URL pathname via handler functions.
 */

export interface RecordedRequest {
  url: string;
  path: string;
  query: URLSearchParams;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export type FetchHandler = (req: RecordedRequest, callIndex: number) => Response | Promise<Response>;

export interface MockFetch {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
  /** Calls recorded against a specific API path (pathname only). */
  callsTo(pathSuffix: string): RecordedRequest[];
}

export function createMockFetch(handler: FetchHandler): MockFetch {
  const requests: RecordedRequest[] = [];

  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(rawUrl);
    const headers: Record<string, string> = {};
    const headerObj = new Headers(init?.headers ?? undefined);
    headerObj.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const record: RecordedRequest = {
      url: rawUrl,
      path: parsed.pathname,
      query: parsed.searchParams,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    const index = requests.push(record) - 1;
    return handler(record, index);
  }) as typeof fetch;

  return {
    fetchImpl: impl,
    requests,
    callsTo(pathSuffix: string) {
      return requests.filter((r) => r.path.endsWith(pathSuffix));
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function textResponse(text: string, status = 200, headers?: Record<string, string>): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain', ...headers } });
}

/** Parses urlencoded or multipart form bodies into a flat map. */
export function parseForm(body: string | undefined): Record<string, string> {
  if (!body) return {};
  if (body.includes('Content-Disposition: form-data')) {
    const out: Record<string, string> = {};
    const parts = body.split(/--[\w-]+/).filter((p) => p.includes('name="'));
    for (const part of parts) {
      const nameMatch = /name="([^"]+)"/.exec(part);
      if (!nameMatch) continue;
      const valueStart = part.indexOf('\r\n\r\n');
      out[nameMatch[1]] = valueStart >= 0 ? part.slice(valueStart + 4).replace(/\r\n$/, '') : '';
    }
    return out;
  }
  return Object.fromEntries(new URLSearchParams(body));
}
