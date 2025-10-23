import {
  MCPJSONRPCRequest,
  MCPJSONRPCResponse,
  MCPToolCallParams,
  MCPToolCallResult,
  MCPToolDescriptor,
  MCPToolListResult,
} from './mcpTypes';

export interface MCPClientConfig {
  endpoint?: string;
  widgetBasePath?: string;
  fetchImplementation?: typeof fetch;
}

export interface WidgetResource {
  type: 'src' | 'html';
  value: string;
  baseUrl?: string;
}

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

export class MCPClient {
  private readonly endpoint: string;
  private readonly effectiveEndpoint: string;
  private readonly widgetBasePath: string;
  private readonly fetchFn: typeof fetch;
  private requestId = 0;

  constructor({ endpoint, widgetBasePath, fetchImplementation }: MCPClientConfig = {}) {
    const resolvedEndpoint = endpoint ?? import.meta.env.VITE_MCP_ENDPOINT ?? '/mcp';
    this.endpoint = resolvedEndpoint;
    this.effectiveEndpoint = resolveEffectiveEndpoint(resolvedEndpoint);
    this.widgetBasePath = widgetBasePath ?? import.meta.env.VITE_WIDGET_BASE ?? '/widgets';
    const candidateFetch = fetchImplementation ?? (typeof globalThis !== 'undefined' ? globalThis.fetch : fetch);
    if (!candidateFetch) {
      throw new Error('Fetch API is not available in this environment.');
    }
    this.fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
      return candidateFetch.call(globalThis, input, init);
    }) as typeof fetch;
  }

  async listTools(): Promise<MCPToolDescriptor[]> {
    const response = await this.jsonRpcRequest<MCPToolListResult>('tools/list');
    return response.tools ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<MCPToolCallResult> {
    const params: MCPToolCallParams = { name, arguments: args };
    const response = await this.jsonRpcRequest<MCPToolCallResult>('tools/call', params);
    return response;
  }

  async resolveWidgetResource(widgetUri: string): Promise<WidgetResource> {
    if (!widgetUri) {
      throw new Error('Missing widget URI');
    }

    if (isHttpUrl(widgetUri) || widgetUri.startsWith('/')) {
      return { type: 'src', value: widgetUri };
    }

    try {
      const readResult = await this.jsonRpcRequest<any>('resources/read', { uri: widgetUri });
      const contents: Array<Record<string, unknown>> | undefined = readResult?.contents;
      const htmlPart = contents?.find((part) =>
        typeof part === 'object' &&
        part !== null &&
        'mimeType' in part &&
        typeof part.mimeType === 'string' &&
        part.mimeType.includes('html'),
      );
      if (htmlPart && typeof htmlPart === 'object' && htmlPart !== null && 'text' in htmlPart) {
        const text = (htmlPart as { text?: string }).text;
        if (typeof text === 'string' && text.trim().length > 0) {
          const baseUrl = typeof (htmlPart as { uri?: string }).uri === 'string'
            ? ((htmlPart as { uri?: string }).uri as string)
            : undefined;
          return { type: 'html', value: text, baseUrl };
        }
      }
    } catch (error) {
      console.warn('[MCP] resources/read failed, falling back to static widget loader.', error);
    }

    if (widgetUri.startsWith('ui://')) {
      const normalized = widgetUri
        .replace(/^ui:\/\//, '')
        .replace(/^widget\//, '')
        .replace(/\.html?$/, (ext) => ext.toLowerCase());
      const path = `${this.widgetBasePath.replace(/\/$/, '')}/${normalized}`;
      return { type: 'src', value: path };
    }

    throw new Error(`Unable to resolve widget URI: ${widgetUri}`);
  }

  private async jsonRpcRequest<TResult = unknown, TParams = unknown>(
    method: string,
    params?: TParams,
  ): Promise<TResult> {
    const id = ++this.requestId;
    const payload: MCPJSONRPCRequest<TParams> = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const response = await this.fetchFn(this.effectiveEndpoint, {
      method: 'POST',
      headers: DEFAULT_HEADERS,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await safeReadText(response);
      throw new Error(`MCP request failed: ${response.status} ${response.statusText}\n${body}`);
    }

    const json = (await response.json()) as MCPJSONRPCResponse<TResult>;
    if (json.error) {
      throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
    }
    if (!('result' in json)) {
      throw new Error('Invalid MCP response payload: missing result');
    }
    return json.result as TResult;
  }
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function resolveEffectiveEndpoint(endpoint: string): string {
  if (!isHttpUrl(endpoint)) {
    return endpoint;
  }
  const proxyBase =
    typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_MCP_PROXY_ENDPOINT
      ? import.meta.env.VITE_MCP_PROXY_ENDPOINT
      : '/proxy';
  const separator = proxyBase.includes('?') ? '&' : '?';
  return `${proxyBase}${separator}target=${encodeURIComponent(endpoint)}`;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    console.warn('Failed to read response body as text', error);
    return '';
  }
}
