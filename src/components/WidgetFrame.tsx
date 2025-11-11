import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MCPToolCallResult } from '../lib/mcpTypes';
import { WidgetResourceError } from '../lib/mcpClient';
import type { MCPClient, WidgetResource } from '../lib/mcpClient';

export interface WidgetFrameProps {
  client: MCPClient;
  widgetUri: string;
  payload: {
    structuredContent?: unknown;
    meta?: Record<string, unknown>;
  };
  onToolInvocation?: (
    request: {
      tool: string;
      args?: Record<string, unknown>;
      sourceWidget: string;
    },
  ) => Promise<MCPToolCallResult>;
}

export function WidgetFrame({ client, widgetUri, payload, onToolInvocation }: WidgetFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [widgetResource, setWidgetResource] = useState<WidgetResource | null>(null);
  const [iframeReady, setIframeReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [iframeHeight, setIframeHeight] = useState<number | null>(null);
  const [hideWidget, setHideWidget] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const userQuestion = useMemo(() => inferUserQuestion(payload.meta), [payload.meta]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setIframeReady(false);
    setIframeHeight(null);
    setHideWidget(false);
    setAnalysis(null);
    setAnalysisError(null);
    setAnalysisLoading(false);
    client
      .resolveWidgetResource(widgetUri)
      .then((resource) => {
        if (!cancelled) {
          setHideWidget(false);
          setWidgetResource(resource);
        }
      })
      .catch((err) => {
        console.error('Failed to resolve widget resource', err);
        if (!cancelled) {
          if (err instanceof WidgetResourceError && err.code === 'widget_resource_unavailable') {
            setHideWidget(true);
            setWidgetResource(null);
            setError(null);
            return;
          }
          setWidgetResource(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, widgetUri]);

  useEffect(() => {
    if (!hideWidget) {
      setAnalysis(null);
      setAnalysisError(null);
      setAnalysisLoading(false);
      return;
    }
    if (!payload.structuredContent) {
      setAnalysis(null);
      setAnalysisError(null);
      setAnalysisLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setAnalysisError(null);
    setAnalysis(null);
    setAnalysisLoading(true);

    const locale = 'en-US';

    fetch('/api/openai/widget-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredContent: payload.structuredContent,
        meta: payload.meta ?? null,
        toolName: extractToolName(payload.meta),
        widgetUri,
        locale,
        question: userQuestion,
      }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const text = await response.text();
          const errorText = text || `Widget summary request failed (${response.status})`;
          throw new Error(errorText);
        }
        return response.json();
      })
      .then((data) => {
        if (cancelled) return;
        const summary = typeof data?.summary === 'string' ? data.summary : null;
        setAnalysis(summary);
        setAnalysisLoading(false);
      })
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return;
        setAnalysisError(err instanceof Error ? err.message : String(err));
        setAnalysisLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [hideWidget, payload.structuredContent, payload.meta, widgetUri, userQuestion]);

  const toolOutputMessage = useMemo(
    () => ({
      type: 'openai.toolOutput',
      data: {
        structuredContent: payload.structuredContent ?? null,
        meta: payload.meta ?? {},
        _meta: payload.meta ?? {},
      },
    }),
    [payload.meta, payload.structuredContent],
  );

  const syncIframeHeight = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument;
      if (!doc) return;
      const body = doc.body;
      const docElement = doc.documentElement;
      const nextHeight = Math.max(
        body?.scrollHeight ?? 0,
        body?.offsetHeight ?? 0,
        docElement?.scrollHeight ?? 0,
        docElement?.offsetHeight ?? 0,
      );
      if (Number.isFinite(nextHeight) && nextHeight > 0) {
        setIframeHeight((current) => {
          if (!current || Math.abs(current - nextHeight) > 1) {
            return nextHeight;
          }
          return current;
        });
      }
    } catch (err) {
      // Cross-origin iframe; cannot auto-resize.
    }
  }, []);

  const deliverToolOutput = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) {
      return;
    }
    const targetWindow = iframe.contentWindow;
    try {
      targetWindow.postMessage(toolOutputMessage, '*');
    } catch (error) {
      console.warn('Failed to postMessage tool output to widget', error);
    }

    try {
      const globals = {
        structuredContent: payload.structuredContent ?? null,
        _meta: payload.meta ?? {},
        meta: payload.meta ?? {},
      };
      const scopedWindow = targetWindow as typeof targetWindow & { openai?: Record<string, unknown> };
      if (typeof scopedWindow.openai !== 'object' || scopedWindow.openai === null) {
        scopedWindow.openai = {};
      }
      scopedWindow.openai.toolOutput = globals;
      const customEventCtor = getCustomEventCtor(targetWindow);
      if (customEventCtor) {
        const evt = new customEventCtor('openai:set_globals', {
          detail: { globals: { toolOutput: globals } },
        });
        targetWindow.dispatchEvent(evt);
      }
    } catch (error) {
      console.warn('Failed to sync openai globals with widget', error);
    }
  }, [payload.meta, payload.structuredContent, toolOutputMessage]);

  useEffect(() => {
    if (!iframeReady) return;
    deliverToolOutput();
  }, [iframeReady, deliverToolOutput]);

  useEffect(() => {
    if (!iframeReady) return;
    deliverToolOutput();
  }, [toolOutputMessage, iframeReady, deliverToolOutput]);

  useEffect(() => {
    if (!iframeReady) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    syncIframeHeight();
    try {
      const doc = iframe.contentDocument;
      if (!doc) return undefined;
      const observer = new ResizeObserver(() => syncIframeHeight());
      observer.observe(doc.documentElement);
      if (doc.body) observer.observe(doc.body);
      return () => observer.disconnect();
    } catch (error) {
      console.warn('Widget auto-resize unavailable', error);
      return undefined;
    }
  }, [iframeReady, widgetResource, syncIframeHeight]);

  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      const iframeWindow = iframeRef.current?.contentWindow;
      if (!iframeWindow || event.source !== iframeWindow) {
        return;
      }

      const data = event.data;
      if (!data || typeof data !== 'object') {
        return;
      }

      if (data.type === 'openai.widgetHeight' && typeof data.height === 'number') {
        const heightValue = Math.max(0, Math.floor(data.height));
        setIframeHeight(heightValue > 0 ? heightValue : null);
        return;
      }

      if (data.type === 'openai.callTool') {
        const toolName: string | undefined = data.tool ?? data.name;
        const args: Record<string, unknown> | undefined = data.args ?? data.arguments;
        const invocationId: string | number | undefined = data.invocationId ?? Date.now();
        if (!toolName) {
          console.warn('Widget requested callTool without a name');
          return;
        }

        try {
          const result = await onToolInvocation?.({
            tool: toolName,
            args,
            sourceWidget: widgetUri,
          });
          iframeWindow.postMessage(
            {
              type: 'openai.toolResult',
              data: { ...(result ?? {}), invocationId },
            },
            '*',
          );
        } catch (error_) {
          const message = error_ instanceof Error ? error_.message : String(error_);
          iframeWindow.postMessage(
            {
              type: 'openai.toolError',
              data: { message, invocationId },
            },
            '*',
          );
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onToolInvocation, widgetUri]);

  const iframeProps = useMemo(() => {
    if (!widgetResource) {
      return {};
    }
    if (widgetResource.type === 'src') {
      return { src: widgetResource.value };
    }
    const html = injectBase(widgetResource.value, widgetResource.baseUrl ?? undefined);
    return { srcDoc: html };
  }, [widgetResource]);

  if (error) {
    return (
      <div className="widget-frame widget-frame--error">
        <strong>Widget failed to load:</strong> {error}
      </div>
    );
  }

  if (hideWidget) {
    return (
      <div className="widget-frame widget-frame--textual">
        {analysisLoading && <p>AI is summarizing the tool output…</p>}
        {!analysisLoading && analysis && <p>{analysis}</p>}
        {!analysisLoading && analysisError && (
          <p className="widget-frame__error">Unable to generate a summary: {analysisError}</p>
        )}
        {!analysisLoading && !analysis && !analysisError && (
          <p>The widget is unavailable and no structured data was provided.</p>
        )}
      </div>
    );
  }

  if (!widgetResource) {
    return (
      <div className="widget-frame widget-frame--loading">
        Loading widget <code>{widgetUri}</code>...
      </div>
    );
  }

  return (
    <div className="widget-frame">
      <iframe
        ref={iframeRef}
        title={`Widget ${widgetUri}`}
        sandbox="allow-scripts allow-same-origin"
        loading="lazy"
        {...iframeProps}
        style={iframeHeight ? { height: `${iframeHeight}px` } : undefined}
        scrolling="no"
        onLoad={() => {
          setIframeReady(true);
          syncIframeHeight();
        }}
      />
    </div>
  );
}

function getCustomEventCtor(targetWindow: Window): typeof CustomEvent | null {
  const ctor = (targetWindow as Window & { CustomEvent?: typeof CustomEvent }).CustomEvent;
  if (typeof ctor === 'function') {
    return ctor;
  }
  if (typeof CustomEvent === 'function') {
    return CustomEvent;
  }
  return null;
}

function injectBase(html: string, baseUrl?: string): string {
  if (!baseUrl) return html;
  const baseTag = `<base href="${baseUrl}">`;
  if (/<base\s+/i.test(html)) {
    return html;
  }
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, (match) => `${match}${baseTag}`);
  }
  return `<head>${baseTag}</head>${html}`;
}

function inferUserQuestion(meta?: Record<string, unknown>): string | undefined {
  if (!meta || typeof meta !== 'object') {
    return undefined;
  }
  const candidates = ['userPrompt', 'userQuery', 'question', 'request', 'prompt'];
  for (const key of candidates) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function extractToolName(meta?: Record<string, unknown>): string | undefined {
  if (!meta || typeof meta !== 'object') {
    return undefined;
  }
  const candidates = ['toolName', 'tool', 'openai.toolName', 'openai/toolName'];
  for (const key of candidates) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}
