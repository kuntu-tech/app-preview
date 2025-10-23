export interface MCPJSONRPCRequest<TParams = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: TParams;
}

export interface MCPJSONRPCResponse<TResult = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result?: TResult;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface MCPToolDescriptor {
  name: string;
  description?: string;
  title?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  examples?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface MCPToolListResult {
  tools: MCPToolDescriptor[];
  [key: string]: unknown;
}

export interface MCPToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface MCPToolContentChunk {
  type: 'text' | string;
  text?: string;
  [key: string]: unknown;
}

export interface MCPToolCallResult {
  content?: MCPToolContentChunk[];
  structuredContent?: unknown;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WidgetInvocationPayload {
  structuredContent?: unknown;
  meta?: Record<string, unknown>;
}
