# -*- coding: utf-8 -*-
"""
ilink-bot —— 腾讯官方 iLink 接口的微信个人助手最小实现
协议逻辑提取自 Attention 的 weixin_oc 适配器，只保留：
  1. 扫码登录（终端二维码 + qrcode.png）
  2. 长轮询接收消息（微信龙虾只与扫码者本人对话，单会话）
  3. 文本回复（大脑可切换 echo / openai / codex），维护一份对话历史

用法: python ilink_bot.py
登录态保存在 state.json，重启通常不用重新扫码。
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import random
import re
import sys
import time
import uuid
from collections import deque
from pathlib import Path

import aiohttp

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
STATE_PATH = BASE_DIR / "state.json"
QR_PNG_PATH = BASE_DIR / "qrcode.png"

SESSION_TIMEOUT_ERRCODE = -14
ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def load_json(path: Path, default: dict) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return default


def save_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------------------------------------------------------------- iLink 客户端

class ILinkClient:
    def __init__(self, base_url: str, timeout_ms: int) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_ms = timeout_ms
        self.token: str | None = None
        self.account_id: str = ""
        self._session: aiohttp.ClientSession | None = None

    async def ensure_session(self) -> None:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=self.timeout_ms / 1000)
            )

    async def close(self) -> None:
        if self._session is not None and not self._session.closed:
            await self._session.close()

    def _headers(self, token_required: bool) -> dict:
        headers = {
            "Content-Type": "application/json",
            "AuthorizationType": "ilink_bot_token",
            "X-WECHAT-UIN": base64.b64encode(
                str(random.getrandbits(32)).encode("utf-8")
            ).decode("utf-8"),
        }
        if token_required and self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    async def request(
        self,
        method: str,
        endpoint: str,
        *,
        params: dict | None = None,
        payload: dict | None = None,
        token_required: bool = False,
        timeout_ms: int | None = None,
        extra_headers: dict | None = None,
    ) -> dict:
        await self.ensure_session()
        assert self._session is not None
        timeout = aiohttp.ClientTimeout(total=(timeout_ms or self.timeout_ms) / 1000)
        headers = self._headers(token_required)
        if extra_headers:
            headers.update(extra_headers)
        url = f"{self.base_url}/{endpoint.lstrip('/')}"
        async with self._session.request(
            method, url, params=params, json=payload, headers=headers, timeout=timeout
        ) as resp:
            text = await resp.text()
            if resp.status >= 400:
                raise RuntimeError(f"{method} {endpoint} HTTP {resp.status}: {text[:200]}")
            if not text:
                return {}
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                raise RuntimeError(f"{method} {endpoint} 返回非 JSON: {text[:200]}")


def api_ok(payload: dict) -> bool:
    return int(payload.get("ret", 0) or 0) == 0 and int(payload.get("errcode", 0) or 0) == 0


# ---------------------------------------------------------------- 消息解析

def extract_text(item_list) -> str:
    if not isinstance(item_list, list):
        return ""
    parts: list[str] = []
    for item in item_list:
        if not isinstance(item, dict):
            continue
        item_type = int(item.get("type") or 0)
        if item_type == 1:
            text = str(item.get("text_item", {}).get("text", "")).strip()
            if text:
                parts.append(text)
        elif item_type == 2:
            parts.append("[图片]")
        elif item_type == 3:
            voice_text = str(item.get("voice_item", {}).get("text", "")).strip()
            parts.append(voice_text if voice_text else "[语音]")
        elif item_type == 4:
            parts.append("[文件]")
        elif item_type == 5:
            parts.append("[视频]")
    return "\n".join(parts).strip()


def build_text_item(text: str) -> dict:
    return {"type": 1, "text_item": {"text": text}}


async def send_text(client: ILinkClient, user_id: str, context_token: str, text: str) -> bool:
    payload = {
        "base_info": {"channel_version": "ilink-mini-bot"},
        "msg": {
            "from_user_id": "",
            "to_user_id": user_id,
            "client_id": uuid.uuid4().hex,
            "message_type": 2,
            "message_state": 2,
            "context_token": context_token,
            "item_list": [build_text_item(text)],
        },
    }
    try:
        data = await client.request(
            "POST", "ilink/bot/sendmessage", payload=payload, token_required=True
        )
    except Exception as e:
        log(f"发送异常: {e}")
        return False
    if not api_ok(data):
        log(f"发送失败: ret={data.get('ret')} errcode={data.get('errcode')} errmsg={data.get('errmsg')}")
        return False
    return True


# ---------------------------------------------------------------- 大脑

async def brain_reply(brain_cfg: dict, history: list, text: str) -> str:
    mode = brain_cfg.get("mode", "echo")
    if mode == "echo":
        return f"[echo] {text}"

    if mode == "openai":
        o = brain_cfg.get("openai", {})
        if not o.get("api_key"):
            return "(未配置 brain.openai.api_key，请在 config.json 填写)"
        url = o.get("api_base", "https://api.openai.com/v1").rstrip("/") + "/chat/completions"
        payload = {
            "model": o.get("model", "gpt-5-codex"),
            "messages": history + [{"role": "user", "content": text}],
        }
        timeout = aiohttp.ClientTimeout(total=300)
        async with aiohttp.ClientSession(timeout=timeout, trust_env=True) as session:
            async with session.post(
                url, json=payload, headers={"Authorization": f"Bearer {o['api_key']}"}
            ) as resp:
                data = json.loads(await resp.text())
                if resp.status != 200:
                    return f"(OpenAI 调用失败: HTTP {resp.status} {str(data)[:200]})"
        return str(data["choices"][0]["message"]["content"]).strip()

    if mode == "codex":
        c = brain_cfg.get("codex", {})
        exe = c.get("exe", "codex")
        out_file = BASE_DIR / f".codex_last_{uuid.uuid4().hex}.txt"
        args = [
            exe, "exec", "--skip-git-repo-check", "--sandbox", "read-only",
            "--output-last-message", str(out_file), "--", text,
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(BASE_DIR),
            )
        except Exception as e:
            return f"(无法启动 codex: {e})"
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=c.get("timeout_sec", 300))
        except asyncio.TimeoutError:
            proc.kill()
            return "(codex 执行超时)"
        reply = ""
        try:
            reply = out_file.read_text(encoding="utf-8", errors="ignore").strip()
        except Exception:
            pass
        finally:
            try:
                out_file.unlink(missing_ok=True)
            except Exception:
                pass
        if not reply:
            reply = ANSI_ESCAPE_RE.sub("", out.decode("utf-8", "ignore")).strip()
        if not reply:
            tail = ANSI_ESCAPE_RE.sub("", err.decode("utf-8", "ignore")).strip()[-300:]
            log(f"codex 无输出，stderr 末尾: {tail}")
            return "(codex 未返回内容，详情见终端日志)"
        return reply

    return f"(未知 brain 模式: {mode})"


# ---------------------------------------------------------------- 二维码登录

def render_qr(url: str) -> None:
    log(f"二维码内容: {url}")
    try:
        import qrcode
        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.make(fit=True)
        try:
            qr.make_image().save(QR_PNG_PATH)
            log(f"二维码图片已保存: {QR_PNG_PATH}")
            try:
                os.startfile(QR_PNG_PATH)  # Windows 自动打开图片
            except Exception:
                pass
        except Exception as e:
            log(f"PNG 生成失败(缺 Pillow?): {e}")
        try:
            qr.print_ascii(invert=True)
        except Exception:
            pass
    except ImportError:
        log("未安装 qrcode 库，请用任意二维码工具扫描上面的链接")


async def do_login(client: ILinkClient, cfg: dict) -> bool:
    expired_count = 0
    long_poll = cfg.get("long_poll_timeout_ms", 35000)
    while True:
        try:
            data = await client.request(
                "GET", "ilink/bot/get_bot_qrcode",
                params={"bot_type": cfg.get("bot_type", "3")},
                timeout_ms=15000,
            )
        except Exception as e:
            log(f"获取二维码失败: {e}")
            await asyncio.sleep(5)
            continue
        qrcode = str(data.get("qrcode", "")).strip()
        qr_url = str(data.get("qrcode_img_content", "")).strip()
        if not qrcode or not qr_url:
            log(f"二维码响应异常: {str(data)[:200]}")
            await asyncio.sleep(5)
            continue
        render_qr(qr_url)
        log("请使用手机微信扫码登录（二维码有效期约 5 分钟）...")
        while True:
            try:
                st = await client.request(
                    "GET", "ilink/bot/get_qrcode_status",
                    params={"qrcode": qrcode},
                    timeout_ms=long_poll,
                    extra_headers={"iLink-App-ClientVersion": "1"},
                )
            except asyncio.TimeoutError:
                continue
            except Exception as e:
                log(f"轮询二维码状态失败: {e}")
                await asyncio.sleep(2)
                continue
            status = str(st.get("status", "wait")).strip()
            if status == "confirmed":
                token = st.get("bot_token")
                if not token:
                    log("登录确认但未返回 bot_token")
                    return False
                client.token = str(token)
                client.account_id = str(st.get("ilink_bot_id") or "")
                baseurl = str(st.get("baseurl") or "").strip()
                if baseurl:
                    client.base_url = baseurl.rstrip("/")
                log(f"登录成功! account={client.account_id} base_url={client.base_url}")
                return True
            if status == "expired":
                expired_count += 1
                log(f"二维码过期({expired_count}/3)，刷新中...")
                if expired_count > 3:
                    log("二维码连续过期，稍后重试")
                    return False
                break
            # wait / scanned: 继续长轮询


# ---------------------------------------------------------------- 主循环

async def run() -> None:
    cfg = load_json(CONFIG_PATH, {})
    if not cfg:
        log(f"缺少配置文件: {CONFIG_PATH}")
        return
    state = load_json(STATE_PATH, {})
    brain_cfg = cfg.get("brain", {})

    client = ILinkClient(
        cfg.get("base_url", "https://ilinkai.weixin.qq.com"),
        cfg.get("api_timeout_ms", 120000),
    )
    client.token = state.get("token") or None
    client.account_id = state.get("account_id", "")
    if state.get("base_url"):
        client.base_url = str(state["base_url"]).rstrip("/")
    sync_buf = str(state.get("sync_buf", ""))
    context_tokens: dict[str, str] = dict(state.get("context_tokens", {}))
    history: deque = deque(maxlen=int(brain_cfg.get("history_len", 20)))

    def persist() -> None:
        save_json(STATE_PATH, {
            "token": client.token or "",
            "account_id": client.account_id,
            "base_url": client.base_url,
            "sync_buf": sync_buf,
            "context_tokens": context_tokens,
        })

    log(f"ilink-bot 启动 brain={brain_cfg.get('mode', 'echo')}（个人助手，单会话）")

    try:
        while True:
            if not client.token:
                if not await do_login(client, cfg):
                    await asyncio.sleep(5)
                    continue
                persist()

            try:
                data = await client.request(
                    "POST", "ilink/bot/getupdates",
                    payload={
                        "base_info": {"channel_version": "ilink-mini-bot"},
                        "get_updates_buf": sync_buf,
                    },
                    token_required=True,
                    timeout_ms=cfg.get("long_poll_timeout_ms", 35000),
                )
            except asyncio.TimeoutError:
                continue
            except Exception as e:
                log(f"getupdates 异常: {e}")
                await asyncio.sleep(5)
                continue

            errcode = int(data.get("errcode", 0) or 0)
            if not api_ok(data):
                if errcode == SESSION_TIMEOUT_ERRCODE:
                    log("登录会话超时，清除登录态，等待重新扫码")
                    client.token = None
                    sync_buf = ""
                    context_tokens.clear()
                    persist()
                    continue
                log(f"getupdates 错误: ret={data.get('ret')} errcode={errcode} errmsg={data.get('errmsg')}")
                await asyncio.sleep(5)
                continue

            if data.get("get_updates_buf"):
                sync_buf = str(data["get_updates_buf"])
                persist()

            for msg in data.get("msgs") or []:
                if not isinstance(msg, dict):
                    continue
                from_uid = str(msg.get("from_user_id", "")).strip()
                if not from_uid:
                    continue
                ct = str(msg.get("context_token", "")).strip()
                if ct:
                    context_tokens[from_uid] = ct

                text = extract_text(msg.get("item_list", []))
                log(f"收到: {text!r}")

                if not text:
                    reply = str(brain_cfg.get("non_text_reply", ""))
                elif text.strip() == "/reset":
                    history.clear()
                    reply = "已重置对话历史。"
                else:
                    try:
                        reply = await brain_reply(brain_cfg, list(history), text)
                    except Exception as e:
                        reply = f"(处理失败: {e})"
                    history.append({"role": "user", "content": text})
                    history.append({"role": "assistant", "content": reply})

                if reply:
                    ok = await send_text(client, from_uid, context_tokens.get(from_uid, ct), reply)
                    log(f"回复{'成功' if ok else '失败'}: {reply[:80]!r}")
                persist()
    finally:
        await client.close()


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        log("已退出")


if __name__ == "__main__":
    main()
