# ilink-bot（iLink 微信单人私聊最小机器人）

协议逻辑提取自 AstrBot v4.27.2 的 weixin_oc 适配器。
接收策略：**所有单人私聊消息都接收，群聊消息一律忽略**；每个好友独立维护对话历史。

## 运行
    D:\akasha\venv\Scripts\python.exe D:\akasha\ilink-bot\ilink_bot.py

1. 首次运行会显示/弹出二维码（qrcode.png），用手机微信扫码并确认登录
   - 需要手机微信 iOS >= 8.0.70 / Android >= 8.0.69，且微信里有 ClawBot 插件
2. 登录态保存在 state.json，之后重启一般不用重新扫码

## 切换大脑（config.json -> brain.mode）
- echo: 原样回复（测试链路用）
- openai: 调 OpenAI 兼容 API，填 brain.openai.api_key / api_base / model
  （国内直连不了 OpenAI 时，先设置环境变量 HTTPS_PROXY=http://127.0.0.1:7890 再启动）
- codex: 调用本机 Codex CLI（codex exec），使用你的 ChatGPT 订阅，较慢

## 聊天命令
- /reset  清空当前这个好友的对话历史

## 文件说明
- ilink_bot.py  主程序（单文件）
- config.json   配置
- state.json    登录态（token、同步游标、context_token），勿删
- qrcode.png    最近一次登录二维码
