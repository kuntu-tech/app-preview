import { FormEvent, KeyboardEvent, SVGProps, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { MCPClient } from './lib/mcpClient';
import { ToolArgumentBuilder } from './lib/toolArgumentBuilder';
import { buildToolGuidance } from './lib/toolGuidance';
import type {
  MCPToolCallResult,
  MCPToolContentChunk,
  MCPToolDescriptor,
} from './lib/mcpTypes';
import { WidgetFrame } from './components/WidgetFrame';

interface AppProps {
  appVersion: string;
}

type ChatMessage =
  | {
      id: string;
      role: 'user';
      text: string;
      createdAt: number;
    }
  | {
      id: string;
      role: 'assistant';
      toolName?: string;
      createdAt: number;
      content: MCPToolContentChunk[];
      structuredContent?: unknown;
      meta?: Record<string, unknown>;
      widgetUri?: string;
    }
  | {
      id: string;
      role: 'system';
      text: string;
      createdAt: number;
      tone?: 'info' | 'error';
      meta?: Record<string, unknown>;
    };

type ArgumentMode = 'auto' | 'json';

const DEFAULT_SERVER_URL = import.meta.env.VITE_MCP_ENDPOINT ?? '/mcp';
export default function App({ appVersion }: AppProps) {
  const embedMode = useMemo(() => detectEmbedMode(), []);
  const initialServerUrl = useMemo(() => getInitialServerUrl(), []);
  const [serverUrl, setServerUrl] = useState<string>(initialServerUrl);
  const [serverUrlDraft, setServerUrlDraft] = useState<string>(initialServerUrl);
  const normalizedServerUrl = serverUrl.trim();
  const client = useMemo(
    () => new MCPClient({ endpoint: normalizedServerUrl || undefined }),
    [normalizedServerUrl],
  );
  const argumentBuilder = useMemo(() => new ToolArgumentBuilder(), []);

  const [tools, setTools] = useState<MCPToolDescriptor[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState<string>('');
  const [toolsStatus, setToolsStatus] = useState<{
    status: 'idle' | 'loading' | 'success' | 'error';
    endpoint: string;
    timestamp?: number;
    message?: string;
  }>({ status: 'idle', endpoint: normalizedServerUrl || '(Not configured)' });

  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const [argumentMode, setArgumentMode] = useState<ArgumentMode>('auto');
  const [argumentJson, setArgumentJson] = useState<string>('{}');
  const [lastAutoArguments, setLastAutoArguments] = useState<Record<string, unknown> | null>(null);
  const [lastAutoReason, setLastAutoReason] = useState<string | null>(null);
  const [autoSelectedTool, setAutoSelectedTool] = useState<string | null>(null);
  const [messageDraft, setMessageDraft] = useState<string>('');
  const [isCalling, setIsCalling] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const loadTools = useCallback(async () => {
    if (embedMode && !normalizedServerUrl) {
      setTools([]);
      setToolsError('Please enter the MCP Server URL');
      return;
    }
    setToolsLoading(true);
    setToolsError(null);
    setToolsStatus({ status: 'loading', endpoint: normalizedServerUrl || '(Not configured)' });
    try {
      const list = await client.listTools();
      setTools(list);
      setSelectedTool((prev) => {
        if (prev && list.some((tool) => tool.name === prev)) {
          return prev;
        }
        return list[0]?.name ?? '';
      });
      setAutoSelectedTool((prev) => {
        if (prev && list.some((tool) => tool.name === prev)) {
          return prev;
        }
        return null;
      });
      setToolsStatus({
        status: 'success',
        endpoint: normalizedServerUrl || '(Not configured)',
        timestamp: Date.now(),
        message: `Loaded ${list.length} tools`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setToolsError(message);
      setToolsStatus({
        status: 'error',
        endpoint: normalizedServerUrl || '(Not configured)',
        timestamp: Date.now(),
        message,
      });
    } finally {
      setToolsLoading(false);
    }
  }, [client, embedMode, normalizedServerUrl]);

  useEffect(() => {
    loadTools();
  }, [loadTools]);

  useEffect(() => {
    setTools([]);
    setSelectedTool('');
    setToolsError(null);
    setToolsStatus({ status: 'idle', endpoint: normalizedServerUrl || '(Not configured)' });
    setAutoSelectedTool(null);
    setLastAutoArguments(null);
    setLastAutoReason(null);
  }, [normalizedServerUrl]);

  useEffect(() => {
    if (argumentMode === 'json') {
      setLastAutoArguments(null);
      setLastAutoReason(null);
      setAutoSelectedTool(null);
    }
  }, [argumentMode]);

  useEffect(() => {
    if (embedMode && argumentMode !== 'auto') {
      setArgumentMode('auto');
    }
  }, [embedMode, argumentMode]);

  const appendMessage = useCallback((message: ChatMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const appendAssistantMessage = useCallback(
    (toolName: string | undefined, result: MCPToolCallResult) => {
      const metaCandidate =
        (result as { _meta?: Record<string, unknown>; meta?: Record<string, unknown> })._meta ??
        (result as { meta?: Record<string, unknown> }).meta;
      const meta = typeof metaCandidate === 'object' && metaCandidate !== null ? metaCandidate : undefined;
      const widgetUri = typeof meta?.['openai/outputTemplate' as const] === 'string'
        ? (meta['openai/outputTemplate' as const] as string)
        : undefined;

      appendMessage({
        id: createId('assistant'),
        role: 'assistant',
        toolName,
        createdAt: Date.now(),
        content: Array.isArray(result.content) ? result.content : [],
        structuredContent: result.structuredContent,
        meta,
        widgetUri,
      });
    },
    [appendMessage],
  );

  const applyIncomingDraft = useCallback(
    (text: string, options?: { focus?: boolean }) => {
      setMessageDraft(typeof text === 'string' ? text : '');
      if (options?.focus !== false) {
        const textarea = composerRef.current;
        if (textarea) {
          textarea.focus();
          try {
            const length = textarea.value.length;
            textarea.setSelectionRange(length, length);
          } catch {
            // ignore selection range failures
          }
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!embedMode) return;
    const handleExternalMessage = (event: MessageEvent) => {
      const { data } = event;
      if (data == null) return;

      let incomingText: string | null = null;
      let focus = true;
      if (typeof data === 'string') {
        incomingText = data;
      } else if (typeof data === 'object') {
        const maybeType =
          typeof (data as { type?: unknown }).type === 'string'
            ? (data as { type: string }).type
            : typeof (data as { action?: unknown }).action === 'string'
            ? ((data as { action: string }).action as string)
            : null;
        const normalizedType = maybeType?.toLowerCase();
        if (
          normalizedType === 'mcp-chat:setinput' ||
          normalizedType === 'mcp_chat:setinput' ||
          normalizedType === 'mcpchat.setinput' ||
          normalizedType === 'set-chat-input'
        ) {
          const payload = (data as { payload?: unknown }).payload;
          if (typeof payload === 'object' && payload !== null) {
            if (typeof (payload as { text?: unknown }).text === 'string') {
              incomingText = (payload as { text: string }).text;
            }
            if (typeof (payload as { focus?: unknown }).focus === 'boolean') {
              focus = Boolean((payload as { focus: boolean }).focus);
            }
          }
          if (typeof (data as { text?: unknown }).text === 'string') {
            incomingText = (data as { text: string }).text;
          }
          if (typeof (data as { focus?: unknown }).focus === 'boolean') {
            focus = Boolean((data as { focus: boolean }).focus);
          }
        } else if (typeof (data as { text?: unknown }).text === 'string' && !maybeType) {
          incomingText = (data as { text: string }).text;
          if (typeof (data as { focus?: unknown }).focus === 'boolean') {
            focus = Boolean((data as { focus: boolean }).focus);
          }
        }
      }

      if (typeof incomingText === 'string') {
        applyIncomingDraft(incomingText, { focus });
      }
    };

    window.addEventListener('message', handleExternalMessage);
    return () => window.removeEventListener('message', handleExternalMessage);
  }, [embedMode, applyIncomingDraft]);

  const callSelectedTool = useCallback(async (messageOverride?: string) => {
    if (argumentMode === 'auto' && tools.length === 0) {
      throw new Error('No tools available, please check the MCP Server');
    }

    const messageToUse = messageOverride ?? messageDraft;
    const trimmedMessage = messageToUse.trim();

    if (trimmedMessage.length > 0) {
      appendMessage({
        id: createId('user'),
        role: 'user',
        text: messageToUse,
        createdAt: Date.now(),
      });
    }

    const syntheticMessages: ChatMessage[] = trimmedMessage
      ? [
          ...messages,
          {
            id: 'pending-user',
            role: 'user',
            text: messageToUse,
            createdAt: Date.now(),
          },
        ]
      : messages;

    const locale = typeof navigator !== 'undefined' ? navigator.language : undefined;

    let targetTool: MCPToolDescriptor | undefined;
    let toolName = '';
    let args: Record<string, unknown> = {};
    let reason: string | null = null;

    if (argumentMode === 'auto') {
      if (!trimmedMessage) {
        throw new Error('Please enter the natural language instruction to parse');
      }
      setLastAutoArguments(null);
      setLastAutoReason(null);
      setAutoSelectedTool(null);
      // appendMessage({
      //   id: createId('arg-builder'),
      //   role: 'system',
      //   tone: 'info',
      //   text: '使用 OpenAI 分析问题并选择工具…',
      //   createdAt: Date.now(),
      // });
      try {
        const toolsForLLM = tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }));
        const plan = await argumentBuilder.buildArguments({
          tools: toolsForLLM,
          message: trimmedMessage,
          locale,
          conversation: projectConversationContext(syntheticMessages),
        });
        toolName = plan.toolName;
        targetTool = tools.find((tool) => tool.name === toolName);
        if (!targetTool) {
          throw new Error(`The tool ${toolName} selected by OpenAI is not in the list`);
        }
        args = plan.arguments ?? {};
        reason = plan.reason ?? null;
        setLastAutoArguments(args);
        setLastAutoReason(reason);
        setAutoSelectedTool(toolName);
        setSelectedTool(toolName);
        setArgumentJson(JSON.stringify(args, null, 2));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendMessage({
          id: createId('arg-error'),
          role: 'system',
          tone: 'error',
          text: `Parameter parsing failed: ${message}`,
          createdAt: Date.now(),
        });
        setAutoSelectedTool(null);
        setLastAutoArguments(null);
        setLastAutoReason(null);
        throw error;
      }

      // appendMessage({
      //   id: createId('tool-choice'),
      //   role: 'system',
      //   tone: 'info',
      //   text: `OpenAI 选择使用工具 ${toolName}`,
      //   createdAt: Date.now(),
      //   meta: { reason, arguments: args },
      // });
    } else {
      if (!selectedTool) {
        throw new Error('Please select a tool');
      }
      const manualTool = tools.find((tool) => tool.name === selectedTool);
      if (!manualTool) {
        throw new Error('The selected tool was not found, please refresh the list');
      }
      targetTool = manualTool;
      toolName = manualTool.name;
      try {
        args = JSON.parse(argumentJson);
        setLastAutoArguments(null);
        setLastAutoReason(null);
        setAutoSelectedTool(null);
      } catch (error) {
        throw new Error('The JSON parameters cannot be parsed, please check the input');
      }
    }

    if (!toolName && targetTool) {
      toolName = targetTool.name;
    }
    if (!targetTool || !toolName) {
      throw new Error('The tool to be called is not determined');
    }

    const callId = createId('call');
    appendMessage({
      id: callId,
      role: 'system',
      tone: 'info',
      text: `${toolName} is calling...`,
      createdAt: Date.now(),
      meta: { args },
    });

    try {
      const result = await client.callTool(toolName, args);
      appendAssistantMessage(toolName, result);
      const guidance = buildToolGuidance(targetTool, args);
      if (guidance) {
        appendMessage({
          id: createId('guidance'),
          role: 'system',
          tone: 'info',
          text: guidance,
          createdAt: Date.now(),
        });
      }
      setCallError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendMessage({
        id: createId('error'),
        role: 'system',
        tone: 'error',
        text: `Call failed: ${message}`,
        createdAt: Date.now(),
      });
      setCallError(message);
      throw error;
    }
  }, [appendAssistantMessage, appendMessage, argumentBuilder, argumentJson, argumentMode, client, messageDraft, messages, selectedTool, tools]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (isCalling) return;
      const messageToSend = messageDraft.trim();
      if (messageToSend.length === 0) return;
      
      // 立即清空输入框
      setMessageDraft('');
      
      try {
        setIsCalling(true);
        setCallError(null);
        await callSelectedTool(messageToSend);
      } catch (error) {
        console.warn('Tool call failed', error);
      } finally {
        setIsCalling(false);
      }
    },
    [argumentMode, callSelectedTool, isCalling, messageDraft],
  );

  const handleWidgetToolInvocation = useCallback(
    async ({ tool, args, sourceWidget }: { tool: string; args?: Record<string, unknown>; sourceWidget: string; }) => {
      const invocationArgs = args ?? {};
      appendMessage({
        id: createId('widget-invoke'),
        role: 'system',
        tone: 'info',
        text: `The component ${sourceWidget} requests to call the tool ${tool}`,
        createdAt: Date.now(),
        meta: { args: invocationArgs },
      });
      const result = await client.callTool(tool, invocationArgs);
      appendAssistantMessage(tool, result);
      return result;
    },
    [appendAssistantMessage, appendMessage, client],
  );

  const activeToolName = argumentMode === 'auto' ? autoSelectedTool ?? selectedTool : selectedTool;
  const activeTool = tools.find((tool) => tool.name === activeToolName);
  const trimmedServerUrlDraft = serverUrlDraft.trim();
  const nextServerUrlCandidate =
    trimmedServerUrlDraft.length > 0 ? trimmedServerUrlDraft : embedMode ? '' : DEFAULT_SERVER_URL;
  const canApplyServerUrl = nextServerUrlCandidate !== serverUrl;
  const serverInputPlaceholder = embedMode
    ? 'https://your-mcp-server.com/jsonrpc'
    : DEFAULT_SERVER_URL;
  const messageHasContent = messageDraft.trim().length > 0;
  const showSendButton = argumentMode === 'json' || messageHasContent;
  const sendDisabled =
    isCalling ||
    (argumentMode === 'json' && !selectedTool) ||
    (argumentMode === 'auto' && tools.length === 0);

  const handleComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter' || event.shiftKey) {
        return;
      }
      event.preventDefault();
      if (sendDisabled) {
        return;
      }
      const form = event.currentTarget.form;
      if (form) {
        form.requestSubmit();
      }
    },
    [sendDisabled],
  );

  const handleServerUrlSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const next = nextServerUrlCandidate.trim();
      if (next === serverUrl) {
        return;
      }
      setServerUrl(next);
      setServerUrlDraft(next);
    },
    [nextServerUrlCandidate, serverUrl],
  );

  const chatPanel = (
    <main className={['chat-panel', embedMode ? 'chat-panel--embed' : ''].filter(Boolean).join(' ')}>
      {!embedMode ? (
        <form className="server-form server-form--embed chat-panel__server" onSubmit={handleServerUrlSubmit}>
          <label className="field">
            <span>Server</span>
            <div className="field__controls">
              <input
                type="text"
                value={serverUrlDraft}
                onChange={(event) => setServerUrlDraft(event.target.value)}
                placeholder={serverInputPlaceholder}
                spellCheck={false}
              />
              <button type="submit" className="ghost" disabled={!canApplyServerUrl}>
                Connect
              </button>
            </div>
          </label>
        </form>
      ) : null}

      <section className="chat-panel__messages">
        {messages.map((message) => (
          <ChatBubble
            key={message.id}
            message={message}
            client={client}
            onWidgetToolInvocation={handleWidgetToolInvocation}
            embedMode={embedMode}
          />
        ))}
        {isCalling && (
          <div className="chat-bubble chat-bubble--system">
            <span className="spinner" aria-hidden />
            <span>Call Tool...</span>
          </div>
        )}
      </section>

      <form className="chat-panel__composer" onSubmit={handleSubmit}>
        <div className="composer__surface">
          <textarea
            ref={composerRef}
            value={messageDraft}
            onChange={(event) => setMessageDraft(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="Ask Anything about your chatapp"
            rows={3}
            aria-label="Chat input"
          />
          {showSendButton && (
            <button type="submit" className="composer__send" disabled={sendDisabled}>
              <UpArrowIcon aria-hidden width={22} height={22} />
              <span className="sr-only">Send</span>
            </button>
          )}
        </div>

        {!embedMode && (
          <p className="helper-text">When you select the conversation mode, we will call the OpenAI API to automatically parse and encapsulate the tool parameters.</p>
        )}

        {!embedMode && (
          <div className="argument-mode">
            <span>Argument Mode:</span>
            <label>
              <input
                type="radio"
                name="argument-mode"
                value="auto"
                checked={argumentMode === 'auto'}
                onChange={() => setArgumentMode('auto')}
              />
              Conversation Mode (OpenAI automatically parses)
            </label>
            <label>
              <input
                type="radio"
                name="argument-mode"
                value="json"
                checked={argumentMode === 'json'}
                onChange={() => setArgumentMode('json')}
              />
              Manual JSON
            </label>
          </div>
        )}

        {!embedMode && argumentMode === 'auto' && lastAutoArguments && (
          <details className="argument-preview" open>
            <summary>
              Automatically parsed tool parameters{autoSelectedTool ? `（${autoSelectedTool}）` : ''}
            </summary>
            {lastAutoReason && <p className="argument-preview__reason">{lastAutoReason}</p>}
            <pre>{JSON.stringify(lastAutoArguments, null, 2)}</pre>
          </details>
        )}

        {!embedMode && argumentMode === 'json' && (
          <label className="field">
            <span>Tool Parameters JSON</span>
            <textarea
              value={argumentJson}
              onChange={(event) => setArgumentJson(event.target.value)}
              placeholder='{ "input": "..." }'
              rows={6}
            />
          </label>
        )}

        {callError && <p className="error">{callError}</p>}
      </form>
    </main>
  );

  if (embedMode) {
    return <div className="app-shell app-shell--embed">{chatPanel}</div>;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__header">
          <h1>MCP Chat Demo</h1>
          <span className="badge">v{appVersion}</span>
        </div>
        <p className="sidebar__subtitle">Frontend custom MCP client, supports Chat + Widget.</p>
        <div className="sidebar__section">
          <h2>MCP Server</h2>
          <form className="server-form" onSubmit={handleServerUrlSubmit}>
            <label className="field">
              <span>Server URL</span>
              <div className="field__controls">
                <input
                  type="text"
                  value={serverUrlDraft}
                  onChange={(event) => setServerUrlDraft(event.target.value)}
                  placeholder={DEFAULT_SERVER_URL}
                  spellCheck={false}
                />
                <button type="submit" className="ghost" disabled={!canApplyServerUrl}>
                  Apply
                </button>
              </div>
            </label>
            <p className="helper-text">Currently using: {normalizedServerUrl || '(Not configured)'}</p>
          </form>
        </div>
        <div className="sidebar__section">
          <div className="sidebar__section-header">
            <h2>Tool List</h2>
            <button type="button" className="ghost" onClick={loadTools} disabled={toolsLoading}>
              {toolsLoading ? 'Refreshing...' : 'Reload'}
            </button>
          </div>
          {toolsError && <p className="error">{toolsError}</p>}
          {toolsStatus.status !== 'idle' && (
            <p className={`helper-text helper-text--${toolsStatus.status}`}>
              {toolsStatus.status === 'loading' && `Loading tools from ${toolsStatus.endpoint}...`}
              {toolsStatus.status === 'success' &&
                `${toolsStatus.message ?? 'Loading successful'} (${new Date(
                  toolsStatus.timestamp ?? Date.now(),
                ).toLocaleTimeString()})`}
              {toolsStatus.status === 'error' &&
                `Loading failed: ${toolsStatus.message ?? 'Unknown error'} (${toolsStatus.endpoint})`}
            </p>
          )}
          <div className="tool-list" role="list">
            {tools.map((tool) => (
              <button
                key={tool.name}
                type="button"
                role="listitem"
                className={['tool-list__item', tool.name === activeToolName ? 'active' : ''].join(' ')}
                onClick={() => {
                  setSelectedTool(tool.name);
                  if (argumentMode === 'auto') {
                    setAutoSelectedTool(tool.name);
                    setLastAutoArguments(null);
                    setLastAutoReason(null);
                  } else {
                    setAutoSelectedTool(null);
                  }
                }}
              >
                <strong>{tool.title ?? tool.name}</strong>
                {tool.description && <span>{tool.description}</span>}
              </button>
            ))}
            {tools.length === 0 && !toolsLoading && (
              <p className="sidebar__empty">No tools found, please check your MCP Server.</p>
            )}
          </div>
        </div>
        {activeTool && (
          <div className="sidebar__section">
            <h2>Input Schema</h2>
            <details className="schema-viewer" open>
              <summary>JSON Schema Details</summary>
              <pre>{JSON.stringify(activeTool.inputSchema ?? {}, null, 2)}</pre>
            </details>
          </div>
        )}
      </aside>

      {chatPanel}
    </div>
  );
}

function ChatBubble({
  message,
  client,
  onWidgetToolInvocation,
  embedMode,
}: {
  message: ChatMessage;
  client: MCPClient;
  onWidgetToolInvocation: (
    request: { tool: string; args?: Record<string, unknown>; sourceWidget: string },
  ) => Promise<MCPToolCallResult>;
  embedMode: boolean;
}) {
  if (message.role === 'user') {
    return (
      <div className="chat-bubble chat-bubble--user">
        {/* <div className="chat-bubble__header">用户</div> */}
        <div className="chat-bubble__body">{message.text}</div>
      </div>
    );
  }

  if (message.role === 'system') {
    return (
      <div className={`chat-bubble chat-bubble--system chat-bubble--${message.tone ?? 'info'}`}>
        <div className="chat-bubble__body">
          <span>{message.text}</span>
          {message.meta && (
            <details>
              <summary>Request</summary>
              <pre>{JSON.stringify(message.meta, null, 2)}</pre>
            </details>
          )}
        </div>
      </div>
    );
  }

  const textChunks = (message.content ?? []).filter((chunk) => chunk.type === 'text' && typeof chunk.text === 'string');
  const hasStructuredContent = message.structuredContent !== undefined && message.structuredContent !== null;
  const hasMeta = message.meta !== undefined && message.meta !== null;

  // 预处理文本，改善 Markdown 格式
  const preprocessMarkdown = (text: string): string => {
    if (!text) return text;
    
    // 第一步：将行内的列表项分离出来
    // 匹配模式：非换行符 + 空格 + "- " + 大写字母或引号开头的文本
    let processed = text
      // 处理 " - " 格式，如果后面跟着大写字母或引号，说明是列表项
      .replace(/([^\n])\s+-\s+([A-Z"])/g, '$1\n- $2')
      // 处理行内其他可能的 "- " 格式
      .replace(/([^\n])- /g, '$1\n- ')
      // 确保列表项前后都有空行（段落和列表之间）
      .replace(/([^\n])\n- /g, '$1\n\n- ')
      // 列表项结束后如果有非列表内容，添加空行
      .replace(/- ([^\n]+)\n([^\n-])/g, '- $1\n\n$2')
      // 清理多余的连续换行（最多保留两个）
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    
    // 第二步：处理分类标题（首字母大写，不包含引号）
    const lines = processed.split('\n');
    const result: string[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const nextLine = lines[i + 1];
      const trimmedLine = line.trim();
      
      // 检测分类标题：以 "- " 开头，首字母大写，不包含引号，且下一行也是列表项
      if (
        trimmedLine.match(/^-\s+[A-Z][^"]+$/) && 
        nextLine && 
        nextLine.trim().match(/^-\s+/)
      ) {
        // 提取标题文本（去掉 "- " 前缀）
        const title = trimmedLine.replace(/^-\s+/, '').trim();
        // 转换为粗体格式
        result.push(`- **${title}**`);
      } else {
        result.push(line);
      }
    }
    
    return result.join('\n');
  };

  return (
    <div className="chat-bubble chat-bubble--assistant">
      {message.toolName && (
        <div className="chat-bubble__header">
          <span className="chip">{message.toolName}</span>
        </div>
      )}
      <div className="chat-bubble__body">
        {textChunks.length > 0 && (
          <div className="chat-bubble__text">
            {textChunks.map((chunk, index) => {
              const text = typeof chunk.text === 'string' ? chunk.text : '';
              const processedText = preprocessMarkdown(text);
              return (
                <div key={index} className="markdown-content">
                  <ReactMarkdown>{processedText}</ReactMarkdown>
                </div>
              );
            })}
          </div>
        )}
        {message.widgetUri && (
          <WidgetFrame
            client={client}
            widgetUri={message.widgetUri}
            payload={{ structuredContent: message.structuredContent, meta: message.meta }}
            onToolInvocation={onWidgetToolInvocation}
          />
        )}
        {!embedMode && hasStructuredContent && (
          <details className="structured-content">
            <summary>View structuredContent</summary>
            <pre>{JSON.stringify(message.structuredContent, null, 2)}</pre>
          </details>
        )}
        {!embedMode && hasMeta && (
          <details className="structured-content">
            <summary>View _meta</summary>
            <pre>{JSON.stringify(message.meta, null, 2)}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Math.random().toString(16).slice(2)}`;
}

function projectConversationContext(messages: ChatMessage[]): Array<{ role: string; content: string }> {
  const recent = messages.slice(-8);
  return recent
    .map((message) => {
      if (message.role === 'user') {
        return { role: 'user', content: message.text };
      }
      if (message.role === 'assistant') {
        const text = (message.content ?? [])
          .filter((chunk) => chunk.type === 'text' && typeof chunk.text === 'string')
          .map((chunk) => chunk.text as string)
          .join('\n');
        if (text) {
          return { role: 'assistant', content: text };
        }
        return { role: 'assistant', content: '[Structured response]' };
      }
      return { role: 'system', content: message.text };
    })
    .filter((item) => typeof item.content === 'string' && item.content.trim().length > 0);
}

function detectEmbedMode(): boolean {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (params.has('embed') || params.get('layout') === 'embed') {
      return true;
    }
  }
  const flag = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_MCP_EMBED_MODE;
  return flag === 'true';
}

function getInitialServerUrl(): string {
  const embed = detectEmbedMode();
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const candidate = params.get('mcp') ?? params.get('server') ?? params.get('endpoint');
    if (candidate && candidate.trim()) {
      return candidate.trim();
    }
  }
  return embed ? '' : DEFAULT_SERVER_URL;
}

function UpArrowIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 19V5" />
      <path d="M6 11l6-6 6 6" />
    </svg>
  );
}
