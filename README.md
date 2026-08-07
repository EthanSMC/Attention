# ilink-bot（iLink 微信个人助手最小机器人）

协议逻辑提取自 AstrBot v4.27.2 的 weixin_oc 适配器。
微信龙虾（ClawBot）只与扫码者本人对话，因此本程序是单会话个人助手，
维护一份对话历史（长度见 config.json 的 brain.history_len）。

## 运行
    D:\akasha\venv\Scripts\python.exe D:\akasha\ilink-bot\ilink_bot.py
或直接双击 start-bot.bat

1. 首次运行会显示/弹出二维码（qrcode.png），用手机微信扫码并确认登录
   - 需要手机微信 iOS >= 8.0.70 / Android >= 8.0.69，且微信里有 ClawBot 插件
2. 登录态保存在 state.json，之后重启一般不用重新扫码
3. 在微信里找到龙虾会话，发消息即可与本机 AI 对话

## 切换大脑（config.json -> brain.mode）
- echo: 原样回复（测试链路用）
- openai: 调 OpenAI 兼容 API，填 brain.openai.api_key / api_base / model
  （国内直连不了 OpenAI 时，先设置环境变量 HTTPS_PROXY=http://127.0.0.1:7890 再启动）
- codex: 调用本机 Codex CLI（codex exec，只读沙箱），使用你的 ChatGPT 订阅，较慢

## 聊天命令
- /reset  清空对话历史

## 文件说明
- ilink_bot.py  主程序（单文件）
- config.json   配置
- state.json    登录态（token、同步游标、context_token），勿删
- qrcode.png    最近一次登录二维码
- AGENTS.md     Codex 大脑的行为指南（中文简洁、只读）
