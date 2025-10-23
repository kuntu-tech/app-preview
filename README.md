# MCP Chat + Widget Client Demo

一个基于 React + TypeScript + Vite 的前端示例，实现了可直接运行的 MCP Client：

- 聊天消息列表与输入框；
- JSON-RPC `tools/list` / `tools/call` 封装；
- 自动根据 `_meta["openai/outputTemplate"]` 加载组件（Widget iframe）；
- `structuredContent` + `_meta` 数据注入；
- 组件内部通过 `postMessage` 回调触发工具调用；
- 与 OpenAI Apps SDK / MCP Server 完全兼容。

> ✅ 假设你已经开发好了 MCP Server（OpenAI Apps SDK），此仓库提供可直接运行的 Web 前端。

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（内置 Node 代理，解决 CORS）
MCP_TARGET=https://your-mcp-endpoint npm run dev

# 生产构建
npm run build

# 生产部署（基于构建产物 + Node 代理）
MCP_TARGET=https://your-mcp-endpoint npm start
```

若希望启用自动参数解析，需要在运行命令前额外设置 `OPENAI_API_KEY`（以及可选的 `OPENAI_MODEL`）。例如：

```bash
OPENAI_API_KEY=sk-xxx MCP_TARGET=https://your-mcp-endpoint npm run dev
```

`npm run dev` 会启动一个基于 Express 的小型服务器：

- 默认监听 `http://localhost:5174`；
- 将前端请求代理到 `MCP_TARGET`（默认 `http://localhost:3000`）；
- 通过 Vite 中间件提供热更新，不再依赖浏览器直接访问远端，从而规避 CORS。

相关环境变量：

| 变量名 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | 前端开发服务器监听端口 | `5174` |
| `HOST` | 监听地址 | `0.0.0.0` |
| `MCP_TARGET` | 实际 MCP Server 基地址（无需带 `/mcp`） | `http://localhost:3000` |
| `MCP_PROXY_SECURE` | 是否验证目标 HTTPS 证书（设为 `false` 可跳过自签证书检查） | `true` |
| `OPENAI_API_KEY` | 用于自动生成工具参数的 OpenAI API Key（必填以启用自动模式） | `—` |
| `OPENAI_MODEL` | 调用的 OpenAI 模型 | `gpt-4.1-mini` |
| `OPENAI_BASE_URL` | （可选）自定义 OpenAI API Base URL | `https://api.openai.com/v1` |

前端依旧通过 `fetch('/mcp', …)` 调用；服务器会将 `HMR`、静态文件与 `/mcp` 请求统一处理。

## 项目结构

```
├── index.html                    # 入口 HTML
├── package.json                  # 依赖与脚本
├── public/
│   └── widgets/
│       └── kanban-board.html     # 示例 Widget（postMessage 协议）
├── src/
│   ├── App.tsx                   # 核心聊天逻辑与 UI
│   ├── components/
│   │   └── WidgetFrame.tsx       # iframe Loader + 组件交互桥
│   ├── lib/
│   │   ├── mcpClient.ts          # MCP JSON-RPC 请求封装
│   │   └── mcpTypes.ts           # 基础类型定义
│   ├── env.d.ts                  # 环境变量类型
│   ├── main.tsx                  # React 渲染入口
│   └── styles.css                # 基础样式
├── tsconfig.json
└── vite.config.ts
```

## 功能亮点

- **工具发现**：初始化时调用 `tools/list` 显示所有 MCP 工具；
- **聊天 + 工具调用**：聊天面板支持自动参数模式或手动 JSON 参数；
- **Widget Loader**：识别 `_meta["openai/outputTemplate"]`，自动加载组件 iframe；
- **组件通信**：父页面与 iframe 通过 `postMessage` 发送 `openai.toolOutput`、`openai.callTool`、`openai.toolResult`、`openai.toolError`；
- **本地 Widget 资源**：`ui://widget/...` 会映射到 `/widgets/...`；如果 MCP Server 支持 `resources/read`，也会优先尝试远程加载；
- **组件内交互**：`public/widgets/kanban-board.html` 演示如何在组件里触发 `create-task`、`advance-task` 等工具。
- **自动参数解析**：开启对话模式后，会调用本地服务器的 OpenAI 代理，根据所有可用工具自动选择最合适的一个，并生成其输入参数（需要配置 `OPENAI_API_KEY`）。
  - 解析结果与被选中的工具会在界面中展示为只读 JSON，方便核对。

## 集成 MCP Server

1. 在 MCP Server 端暴露 `/mcp`（或自定义）的 JSON-RPC 入口；
2. 返回数据符合 OpenAI Apps SDK 规范：`content`、`structuredContent`、`_meta`；
3. 当 `_meta["openai/outputTemplate"] = "ui://widget/kanban-board.html"` 时：
   - 如果可通过 `resources/read` 下发 HTML，将会被自动注入 iframe；
   - 或者将静态 HTML 文件放到 `public/widgets/kanban-board.html`。
4. 组件内通过 `window.parent.postMessage({ type: 'openai.callTool', tool, args })` 触发工具调用，前端会自动转发给 MCP Server。

## 自定义

- 将更多 Widget HTML 文件放在 `public/widgets/` 下即可；
- 如需强制使用远程 `resources/read`，可设置 `VITE_WIDGET_BASE=''` 并确保服务端实现该方法；
- 扩展 UI/状态管理时，可参考 `WidgetFrame` 的封装方式。

## 许可

MIT License
