import type { MCPToolDescriptor } from './mcpTypes';

export interface ConversationTurn {
  role: string;
  content: string;
}

interface BuildArgumentsRequest {
  tool?: MCPToolDescriptor;
  tools?: MCPToolDescriptor[];
  message: string;
  locale?: string;
  conversation?: ConversationTurn[];
}

interface BuildArgumentsResponse {
  toolName?: string;
  arguments: Record<string, unknown>;
  reason?: string | null;
}

export interface BuiltToolPlan {
  toolName: string;
  arguments: Record<string, unknown>;
  reason?: string | null;
}

export class ToolArgumentBuilder {
  private readonly endpoint: string;

  constructor(endpoint: string = '/api/openai/arguments') {
    this.endpoint = endpoint;
  }

  async buildArguments(request: BuildArgumentsRequest): Promise<BuiltToolPlan> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const message = await safeReadText(response);
      throw new Error(message || `Failed to build tool arguments (${response.status})`);
    }

    const payload = (await response.json()) as BuildArgumentsResponse;
    const toolName = typeof payload?.toolName === 'string' ? payload.toolName : request.tool?.name;
    if (!toolName) {
      throw new Error('OpenAI could not select an available tool.');
    }
    return {
      toolName,
      arguments: (payload?.arguments as Record<string, unknown>) ?? {},
      reason: payload?.reason ?? undefined,
    };
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    console.warn('Failed to read response body', error);
    return '';
  }
}
