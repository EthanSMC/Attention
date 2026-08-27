# @attention/dsh

DeepSeek Harness plugin for Attention — 人筛选，AI 整理的信息层与个人收藏工具。

## 安装

```bash
dsh plugin add @attention/dsh
```

## 配置

设置环境变量或在 DSH profile 中配置：

```bash
export ATTENTION_API_KEY=your-api-key        # Attention API Key
export ATTENTION_BASE_URL=http://127.0.0.1:3000  # Attention 服务地址
```

## 能力

- **15 个 MCP 工具** — 收藏管理、公开内容浏览、AI 检索、日报订阅、社区审核
- **iLink 微信 Channel** — 扫码登录微信，自动收藏链接，回复处理结果
- **Runtime Reporter** — 可选健康上报（不上传聊天内容或凭证）

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
```
