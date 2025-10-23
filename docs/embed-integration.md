## MCP Chat Embed Integration Guide

This document describes how partners can embed the MCP Chat experience into their own pages and control the chat input over `postMessage`.

### 1. Embed URL

Load the chat UI inside an iframe with the `embed=1` flag. You can optionally supply the MCP endpoint the user picked with the `mcp` query parameter.

```
<iframe
  id="mcp-chat"
  src="https://your-hosted-chat.app/?embed=1&mcp=https://example.com/mcp"
  referrerpolicy="no-referrer"
  allow="clipboard-read; clipboard-write"
></iframe>
```

> The `mcp` parameter is optional. If omitted, the iframe will render an empty MCP field and the end-user can fill it in manually.

### 2. Runtime Messaging API

Once the iframe has loaded you can pre-fill or replace the chat composer content using `window.postMessage`.

Send a message to the iframe’s `contentWindow` with either of the following payloads:

```ts
iframe.contentWindow?.postMessage('请帮我查询上海的天气', '*');
```

```ts
iframe.contentWindow?.postMessage(
  {
    type: 'mcp-chat:setInput', // also accepts "mcpChat.setInput" or "set-chat-input"
    text: 'List open pull requests assigned to me.',
    focus: true, // optional, defaults to true
  },
  '*',
);
```

Rules:

* The latest message **replaces** anything currently typed in the composer.
* `text` must be a string. Use an empty string to clear the composer.
* `focus` (optional) controls whether the composer keeps input focus after text is injected. Defaults to `true`.
* The iframe does not enforce origin checks so make sure you only post from trusted code paths.

There are no outbound postMessage events from the iframe today; the integration is write-only.

### 3. Example

```html
<script>
  const iframe = document.querySelector('#mcp-chat');
  function sendPrompt(promptText) {
    iframe.contentWindow?.postMessage(
      { type: 'mcp-chat:setInput', text: promptText, focus: true },
      '*',
    );
  }

  document.querySelector('#demo-send').addEventListener('click', () => {
    sendPrompt(document.querySelector('#prompt').value.trim());
  });
</script>
```

### 4. Error handling

If the iframe cannot be reached (for example, due to sandbox restrictions), `postMessage` will silently do nothing. You can wrap the call in a `try/catch` if you need to surface diagnostics.
