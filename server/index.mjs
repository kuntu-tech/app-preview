import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createServer as createViteServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import OpenAI from 'openai';

const PORT = Number(process.env.PORT ?? 5174);
const HOST = process.env.HOST ?? '0.0.0.0';
const MCP_TARGET = process.env.MCP_TARGET ?? 'http://localhost:3000';
const SECURE_PROXY = process.env.MCP_PROXY_SECURE !== 'false';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const templatePath = path.resolve(projectRoot, 'index.html');
const openaiClient =
  process.env.OPENAI_API_KEY
    ? new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: process.env.OPENAI_BASE_URL,
      })
    : null;
const openaiModel = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

async function createServer() {
  const app = express();

  app.all('/proxy', async (req, res) => {
    const target = typeof req.query?.target === 'string' ? req.query.target : '';
    if (!target) {
      res.status(400).json({ error: 'Missing target URL.' });
      return;
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      res.status(400).json({ error: 'Invalid target URL.' });
      return;
    }

    if (targetUrl.protocol !== 'https:') {
      res.status(400).json({ error: 'Only https:// targets are allowed.' });
      return;
    }

    try {
      const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET';
      const hasBody = method !== 'GET' && method !== 'HEAD';
      const requestBody = hasBody ? await readRequestBody(req) : undefined;
      const forwardHeaders = buildForwardHeaders(req.headers);
      const fetchInit = {
        method,
        headers: forwardHeaders,
        redirect: 'manual',
        ...(requestBody !== undefined ? { body: requestBody } : {}),
      };
      const fetchResponse = await fetch(targetUrl, fetchInit);

      res.status(fetchResponse.status);
      fetchResponse.headers.forEach((value, key) => {
        if (!HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });

      if (fetchResponse.body) {
        const arrayBuffer = await fetchResponse.arrayBuffer();
        res.send(Buffer.from(arrayBuffer));
        return;
      }

      res.end();
    } catch (error) {
      console.error('Proxy request failed:', error);
      res.status(502).json({ error: 'Proxy request failed.' });
    }
  });

  app.post(
    '/api/openai/arguments',
    express.json({ limit: '2mb' }),
    async (req, res) => {
      if (!openaiClient) {
        res.status(501).json({ error: 'OpenAI integration not configured on server.' });
        return;
      }

      const { tool, tools: toolsPayload, message, locale, conversation } = req.body ?? {};
      if (typeof message !== 'string' || message.trim().length === 0) {
        res.status(400).json({ error: 'Missing user message.' });
        return;
      }

      const toolsList = Array.isArray(toolsPayload)
        ? toolsPayload.filter((item) => item && typeof item === 'object')
        : [];
      const hasExplicitTool = tool && typeof tool === 'object' && typeof tool.name === 'string';
      const useAutomaticSelection = !hasExplicitTool && toolsList.length > 0;

      if (!useAutomaticSelection && !hasExplicitTool) {
        res.status(400).json({ error: 'No tool information provided.' });
        return;
      }

      const normalizedTool = hasExplicitTool ? normalizeToolDescriptor(tool) : null;
      const normalizedToolsList = useAutomaticSelection
        ? toolsList.map((descriptor) => normalizeToolDescriptor(descriptor))
        : [];

      try {
        if (useAutomaticSelection) {
          const selectionResponse = await openaiClient.responses.create({
            model: openaiModel,
            input: buildSelectionPrompt({
              tools: normalizedToolsList,
              message,
              locale,
              conversation,
            }),
            temperature: 0.1,
            max_output_tokens: 800,
          });

          const plan = extractArguments(selectionResponse) ?? {};
          const toolName = typeof plan.toolName === 'string' ? plan.toolName : null;
          if (!toolName) {
            res.status(422).json({ error: 'OpenAI 未能选择合适的工具' });
            return;
          }
          const selectedTool = findToolByName(normalizedToolsList, toolName);
          if (!selectedTool) {
            res.status(422).json({ error: `选中的工具 ${toolName} 不存在于列表中` });
            return;
          }
          const args = plan.arguments && typeof plan.arguments === 'object' ? plan.arguments : {};
          res.json({
            toolName: selectedTool.name,
            arguments: args,
            reason: typeof plan.reason === 'string' ? plan.reason : null,
            usage: selectionResponse.usage ?? null,
          });
          return;
        }

        const schema = normalizeSchema(normalizedTool.inputSchema);
        const response = await openaiClient.responses.create({
          model: openaiModel,
          input: buildPrompt({ tool: normalizedTool, message, schema, locale, conversation }),
          temperature: 0,
          max_output_tokens: 400,
        });

        const args = extractArguments(response) ?? {};
        res.json({ toolName: normalizedTool.name, arguments: args, usage: response.usage ?? null });
      } catch (error) {
        console.error('OpenAI argument builder failed:', error);
        const messageText = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: messageText });
      }
    },
  );

  app.use(
    '/mcp',
    createProxyMiddleware({
      target: MCP_TARGET,
      changeOrigin: true,
      secure: SECURE_PROXY,
      ws: true,
      logLevel: 'warn',
    }),
  );

  if (process.env.NODE_ENV === 'production') {
    const distPath = path.resolve(projectRoot, 'dist');

    app.use(express.static(distPath, { index: false }));

    app.use('*', (_req, res, next) => {
      res.sendFile(path.join(distPath, 'index.html'), (err) => {
        if (err) next(err);
      });
    });
  } else {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: { server: null },
      },
      appType: 'custom',
    });

    app.use(vite.middlewares);
    app.use('*', async (req, res, next) => {
      try {
        const url = req.originalUrl;
        const template = await fs.readFile(templatePath, 'utf-8');
        const transformed = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).send(transformed);
      } catch (error) {
        vite.ssrFixStacktrace?.(error);
        next(error);
      }
    });
  }

  return new Promise((resolve) => {
    app.listen(PORT, HOST, () => {
      console.log(`▶ MCP Chat dev server listening on http://${HOST}:${PORT}`);
      console.log(`   Proxying /mcp to ${MCP_TARGET}`);
      resolve();
    });
  });
}

createServer().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

function buildForwardHeaders(headers) {
  const forward = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!key) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_REQUEST_HEADERS.has(lower)) {
      continue;
    }
    if (typeof value === 'string') {
      forward[key] = value;
    } else if (Array.isArray(value) && value.length > 0) {
      forward[key] = value.join(', ');
    }
  }
  return forward;
}

function buildPrompt({ tool, message, schema, locale, conversation }) {
  const contextText = Array.isArray(conversation)
    ? conversation
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const role = typeof item.role === 'string' ? item.role : 'user';
          const content = typeof item.content === 'string' ? item.content : '';
          if (!content) return null;
          return `${role.toUpperCase()}: ${content}`;
        })
        .filter(Boolean)
        .join('\n')
    : '';

  const schemaText = JSON.stringify(schema, null, 2);
  const toolDescription =
    typeof tool.description === 'string' && tool.description.trim().length > 0
      ? tool.description
      : 'No description provided.';
  const systemPrompt =
    '你是一个严格的 JSON 参数生成器。给定用户指令和工具信息，你只返回符合输入 JSON Schema 的参数对象。禁止返回除 JSON 以外的文本。';

  const localeText = typeof locale === 'string' && locale.trim() ? locale : 'zh-CN';

  const userPrompt = `工具名称: ${tool.name}\n工具描述: ${toolDescription}\n输入 JSON Schema:\n${schemaText}\n\n上下文对话:\n${contextText || '(无)'}\n\n用户指令 (${localeText}):\n${message}`;

  return [
    {
      role: 'system',
      content: [
        {
          type: 'input_text',
          text: systemPrompt,
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: userPrompt,
        },
      ],
    },
  ];
}

function buildSelectionPrompt({ tools, message, locale, conversation }) {
  const contextText = Array.isArray(conversation)
    ? conversation
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const role = typeof item.role === 'string' ? item.role : 'user';
          const content = typeof item.content === 'string' ? item.content : '';
          if (!content) return null;
          return `${role.toUpperCase()}: ${content}`;
        })
        .filter(Boolean)
        .join('\n')
    : '';

  const localeText = typeof locale === 'string' && locale.trim() ? locale : 'zh-CN';
  const toolSummaries = tools
    .map((tool, index) => {
      const schemaSnippet = JSON.stringify(normalizeSchema(tool.inputSchema), null, 2);
      const description = tool.description ? String(tool.description) : '无描述';
      return `工具 ${index + 1}:\n名称: ${tool.name}\n标题: ${tool.title ?? '-'}\n描述: ${description}\n输入 Schema:\n${schemaSnippet}`;
    })
    .join('\n\n');

  const systemPrompt =
    '你是一名工具调度助理。请分析用户请求，从可用工具中选择最合适的一个，并给出调用该工具所需的参数。始终返回 JSON（不包含额外文本）。';

  const userPrompt = `可用工具列表:\n${toolSummaries}\n\n上下文对话:\n${contextText || '(无)'}\n\n用户指令 (${localeText}):\n${message}\n\n请输出 JSON：\n{\n  "toolName": "工具名称（必须来自列表）",\n  "arguments": { ...与输入 Schema 匹配的字段... },\n  "reason": "选择该工具的原因"\n}`;

  return [
    {
      role: 'system',
      content: [
        {
          type: 'input_text',
          text: systemPrompt,
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: userPrompt,
        },
      ],
    },
  ];
}

function normalizeSchema(schemaCandidate) {
  if (!schemaCandidate || typeof schemaCandidate !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: true };
  }
  const schema = cloneDeep(schemaCandidate);
  if (!schema.type) {
    schema.type = 'object';
  }
  return schema;
}

function extractArguments(response) {
  if (!response) return {};
  if (Array.isArray(response.output_text)) {
    for (const item of response.output_text) {
      if (typeof item !== 'string') continue;
      const parsed = tryParseJson(item);
      if (parsed) return parsed;
    }
  }
  const output = Array.isArray(response.output) ? response.output : [];
  for (const step of output) {
    const contents = Array.isArray(step?.content) ? step.content : [];
    for (const item of contents) {
      if (!item) continue;
      if (item.type === 'output_json' && item.data) {
        return item.data;
      }
      if (item.type === 'json_schema' && item.data) {
        return item.data;
      }
      if (item.type === 'output_text' && typeof item.text === 'string') {
        const parsed = tryParseJson(item.text);
        if (parsed) return parsed;
      }
      if (item.type === 'text' && typeof item.text === 'string') {
        const parsed = tryParseJson(item.text);
        if (parsed) return parsed;
      }
    }
  }
  return {};
}

function cloneDeep(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch (error) {
    return null;
  }
}

function normalizeToolDescriptor(tool) {
  const descriptor = cloneDeep(tool ?? {});
  if (!descriptor || typeof descriptor !== 'object') {
    return { name: 'unknown-tool', description: '', inputSchema: {} };
  }
  if (typeof descriptor.name !== 'string') {
    descriptor.name = 'unknown-tool';
  }
  if (!descriptor.inputSchema || typeof descriptor.inputSchema !== 'object') {
    descriptor.inputSchema = {};
  }
  return {
    name: descriptor.name,
    title: typeof descriptor.title === 'string' ? descriptor.title : undefined,
    description: typeof descriptor.description === 'string' ? descriptor.description : '',
    inputSchema: descriptor.inputSchema,
  };
}

function findToolByName(tools, name) {
  const normalized = String(name ?? '').trim();
  if (!normalized) return null;
  return tools.find((tool) => typeof tool.name === 'string' && tool.name.trim() === normalized) ?? null;
}
