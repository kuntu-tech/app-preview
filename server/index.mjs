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
            res.status(422).json({ error: 'OpenAI could not select a suitable tool.' });
            return;
          }
          const selectedTool = findToolByName(normalizedToolsList, toolName);
          if (!selectedTool) {
            res.status(422).json({ error: `Selected tool ${toolName} does not exist in the list.` });
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

  app.post(
    '/api/openai/widget-summary',
    express.json({ limit: '2mb' }),
    async (req, res) => {
      if (!openaiClient) {
        res.status(501).json({ error: 'OpenAI integration not configured on server.' });
        return;
      }

      const { structuredContent, meta, toolName, widgetUri, locale, question } = req.body ?? {};
      if (structuredContent === undefined || structuredContent === null) {
        res.status(400).json({ error: 'Missing structuredContent payload.' });
        return;
      }

      try {
        const prompt = buildWidgetSummaryPrompt({
          structuredContent,
          meta,
          toolName,
          widgetUri,
          locale,
          question,
        });
        const response = await openaiClient.responses.create({
          model: openaiModel,
          input: prompt,
          temperature: 0.2,
          max_output_tokens: 600,
        });
        let summary = extractText(response)?.trim();
        if (!summary) {
          res.status(502).json({ error: 'OpenAI did not return a usable summary.' });
          return;
        }
        if (containsNonEnglish(summary)) {
          summary = await translateToEnglish(summary);
        }
        res.json({ summary, usage: response.usage ?? null });
      } catch (error) {
        console.error('OpenAI widget summary failed:', error);
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: message });
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
    'You are a strict JSON parameter generator. Given the user instruction and the tool information, you must return a JSON object that matches the provided schema. Do not return any non-JSON text.\n\nIMPORTANT RULE: Unless the user explicitly specifies query/search/filter parameters (such as search keywords, filter conditions, query terms, etc.), ONLY include pagination parameters (page, limit, pageSize, offset, skip, cursor, etc.) in the output. Do not infer or guess query parameters that are not explicitly mentioned by the user.';

  const localeText = typeof locale === 'string' && locale.trim() ? locale : 'en-US';

  const userPrompt = `Tool name: ${tool.name}\nTool description: ${toolDescription}\nInput JSON Schema:\n${schemaText}\n\nConversation context:\n${contextText || '(none)'}\n\nUser instruction (${localeText}):\n${message}\n\nRemember: Only include query/search/filter parameters if the user explicitly mentions them. Otherwise, only use pagination parameters.`;

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

  const localeText = typeof locale === 'string' && locale.trim() ? locale : 'en-US';
  const toolSummaries = tools
    .map((tool, index) => {
      const schemaSnippet = JSON.stringify(normalizeSchema(tool.inputSchema), null, 2);
      const description = tool.description ? String(tool.description) : 'No description available.';
      return `Tool ${index + 1}:\nName: ${tool.name}\nTitle: ${tool.title ?? '-'}\nDescription: ${description}\nInput schema:\n${schemaSnippet}`;
    })
    .join('\n\n');

  const systemPrompt =
    'You are a tool-selection assistant. Analyze the user request, choose the most appropriate tool from the list, and provide the JSON arguments that satisfy its schema. Always respond with JSON and no extra text.\n\nIMPORTANT RULE: Unless the user explicitly specifies query/search/filter parameters (such as search keywords, filter conditions, query terms, etc.), ONLY include pagination parameters (page, limit, pageSize, offset, skip, cursor, etc.) in the arguments. Do not infer or guess query parameters that are not explicitly mentioned by the user.';

  const userPrompt = `Available tools:\n${toolSummaries}\n\nConversation context:\n${
    contextText || '(none)'
  }\n\nUser instruction (${localeText}):\n${message}\n\nReturn JSON with the following shape:\n{\n  \"toolName\": \"must match a tool name\",\n  \"arguments\": { ...fields that satisfy the schema... },\n  \"reason\": \"why this tool and argument set were chosen\"\n}\n\nRemember: Only include query/search/filter parameters if the user explicitly mentions them. Otherwise, only use pagination parameters.`;

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

function buildWidgetSummaryPrompt({ structuredContent, meta, toolName, widgetUri, locale, question }) {
  void locale;
  const instruction =
    'Always respond in clear, natural English. Highlight key insights, notable differences, anomalies, and any actionable recommendations. Include concrete numbers or percentages when available.';
  const questionText = typeof question === 'string' && question.trim().length > 0 ? question.trim() : null;
  const sourceLabel =
    [toolName, widgetUri].filter((value) => typeof value === 'string' && value.trim().length > 0)[0] ??
    'Unnamed dataset';
  const structuredText = formatJsonForPrompt(structuredContent);
  const metaText = formatJsonForPrompt(meta ?? {});
  const taskDescription = [
    questionText ? `User question: ${questionText}` : null,
    `Data source: ${sourceLabel}`,
    'Structured data (JSON):',
    structuredText,
    'Additional metadata (JSON):',
    metaText,
    'Task: Provide 2-4 English sentences that summarize the dataset, call out major findings, comparisons, or trends, and finish with a concise takeaway or recommendation.',
  ]
    .filter(Boolean)
    .join('\n\n');

  return [
    {
      role: 'system',
      content: [
        {
          type: 'input_text',
          text: `You are an analytical assistant that explains tool outputs in plain English.\n${instruction}`,
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: taskDescription,
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

function extractText(response) {
  if (!response) return '';
  if (Array.isArray(response.output_text)) {
    for (const item of response.output_text) {
      if (typeof item === 'string' && item.trim().length > 0) {
        return item;
      }
    }
  }
  const output = Array.isArray(response.output) ? response.output : [];
  for (const step of output) {
    const contents = Array.isArray(step?.content) ? step.content : [];
    for (const item of contents) {
      if (!item) continue;
      if (item.type === 'output_text' && typeof item.text === 'string' && item.text.trim().length > 0) {
        return item.text;
      }
      if (item.type === 'text' && typeof item.text === 'string' && item.text.trim().length > 0) {
        return item.text;
      }
    }
  }
  return '';
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

function formatJsonForPrompt(value, maxLength = 6000) {
  if (value === undefined || value === null) {
    return '(empty)';
  }
  try {
    const json = JSON.stringify(value, null, 2);
    if (json.length <= maxLength) {
      return json;
    }
    const truncated = json.slice(0, maxLength);
    return `${truncated}\n... (truncated ${json.length - maxLength} characters)`;
  } catch {
    return '(serialization failed)';
  }
}

function containsNonEnglish(text) {
  if (typeof text !== 'string') return false;
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
}

async function translateToEnglish(text) {
  if (!openaiClient || typeof text !== 'string' || !text.trim()) {
    return text;
  }
  try {
    const translation = await openaiClient.responses.create({
      model: openaiModel,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: 'You translate any input into fluent English. Respond with English sentences only.',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: text,
            },
          ],
        },
      ],
      temperature: 0,
      max_output_tokens: 200,
    });
    const translated = extractText(translation)?.trim();
    return translated || text;
  } catch (error) {
    console.warn('Translation to English failed, returning original summary.', error);
    return text;
  }
}
