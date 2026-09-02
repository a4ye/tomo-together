// The real @unifold/node SDK, with its transport swapped for fetch.
//
// The SDK is used unmodified — same base URL, same `Unifold-Version` header,
// same idempotency-key generation, same retry policy, same error mapping — so
// the requests this service makes to Unifold are byte-identical to the ones the
// App Service made. Only the socket layer changes: NodeHttpClient builds
// `http.Agent`s and drives `req.once('socket', …)`, which is not something to
// rely on inside workerd, and the SDK already accepts a `httpClient` override.
//
// (The SDK does import node:http/node:https at module load to construct its
// default agents. That was verified to work on workerd with nodejs_compat
// before this adapter was written; the agents are simply never used.)
import Unifold from '@unifold/node';

/** Mirrors HttpClientResponse from @unifold/node/cjs/net/HttpClient.js. */
class FetchHttpClientResponse {
  constructor(
    private readonly response: Response,
    private readonly headers: Record<string, string>,
  ) {}

  getStatusCode(): number {
    return this.response.status;
  }

  getHeaders(): Record<string, string> {
    return this.headers;
  }

  getRawResponse(): unknown {
    return this.response;
  }

  toStream(streamCompleteCallback: () => void): unknown {
    streamCompleteCallback();
    return this.response.body;
  }

  async toJSON(): Promise<unknown> {
    return this.response.json();
  }
}

class FetchHttpClient {
  getClientName(): string {
    return 'fetch';
  }

  async makeRequest(
    host: string,
    port: string,
    path: string,
    method: string,
    headers: Record<string, string>,
    requestData: string,
    protocol: string,
    timeout: number,
  ): Promise<FetchHttpClientResponse> {
    const origin =
      (protocol === 'https' && port === '443') || (protocol === 'http' && port === '80')
        ? `${protocol}://${host}`
        : `${protocol}://${host}:${port}`;

    const outgoing = new Headers();
    for (const [key, value] of Object.entries(headers)) {
      // fetch owns these; setting them is either forbidden or wrong.
      if (/^(host|content-length|connection)$/i.test(key)) continue;
      if (value === undefined || value === null) continue;
      outgoing.set(key, String(value));
    }

    const hasBody = method !== 'GET' && method !== 'HEAD' && requestData !== '';
    let response: Response;
    try {
      response = await fetch(`${origin}${path}`, {
        method,
        headers: outgoing,
        body: hasBody ? requestData : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      // The SDK distinguishes a timeout from a connection error by `code`.
      const wrapped: Error & { code?: string } =
        error instanceof Error ? error : new Error(String(error));
      if (wrapped.name === 'TimeoutError' || wrapped.name === 'AbortError') {
        wrapped.code = 'ETIMEDOUT';
      }
      throw wrapped;
    }

    const flat: Record<string, string> = {};
    for (const [key, value] of response.headers) flat[key.toLowerCase()] = value;
    return new FetchHttpClientResponse(response, flat);
  }
}

export type UnifoldClient = InstanceType<typeof Unifold>;

const clients = new Map<string, UnifoldClient>();

export function unifoldClient(secretKey: string): UnifoldClient {
  const existing = clients.get(secretKey);
  if (existing) return existing;
  const created = new Unifold(secretKey, {
    httpClient: new FetchHttpClient() as never,
    // The App Service ran with telemetry on and the SDK's default 2 retries.
  });
  clients.set(secretKey, created);
  return created;
}
