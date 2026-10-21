"""One-shot, unprivileged Agent-Reach adapter. No upstream code is vendored here.

The audit hook is defense in depth for the reviewed urllib-based WebChannel;
it is NOT a security sandbox for arbitrary Python or native code. Run this only
inside the resource-limited, credential-free container described in README.md.
"""

from __future__ import annotations

import contextlib
import importlib
import importlib.metadata
import ipaddress
import json
import os
import re
import signal
import sys
import urllib.error
from typing import Callable
from urllib.parse import parse_qsl, unquote, urlsplit

UPSTREAM_VERSION = "1.5.0"
UPSTREAM_COMMIT = "f65526cbaaad3879473acc1ba6dbefd195caf2be"
MAX_INPUT_BYTES = 16 * 1024
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_URL_BYTES = 8192
DEADLINE_SECONDS = 35
SUPPORTED_KINDS = {"generic_web", "wechat_official_article", "douyin"}
FAILURE_CODES = frozenset({
    "invalid_request", "invalid_url", "unsafe_url", "reader_not_configured",
    "upstream_unavailable", "upstream_incompatible", "upstream_timeout",
    "upstream_failed", "upstream_output_too_large", "upstream_empty",
    "upstream_policy_blocked",
})
REF_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z", re.ASCII)
SENSITIVE_PARAMETER = re.compile(
    r"(?:^|[_-])(?:access[_-]?token|token|auth|authorization|credential|password|"
    r"passwd|secret|signature|signed|sig|api[_-]?key|private[_-]?key|key|cookie|"
    r"session|sessionid|jwt|oauth|code)(?:$|[_-])", re.IGNORECASE,
)
SENSITIVE_COMPACT = {
    "accesstoken", "refreshtoken", "idtoken", "authtoken", "apikey",
    "privatekey", "sessionid", "sessionkey", "clientsecret", "xsectoken",
}
LOCAL_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home", ".onion", ".arpa")


class WorkerFailure(Exception):
    """Only this fixed code, never exception text, crosses the process boundary."""

    def __init__(self, code: str):
        self.code = code if code in FAILURE_CODES else "upstream_failed"
        super().__init__(self.code)


class DiscardOutput:
    def write(self, text: str) -> int:
        return len(text)

    def flush(self) -> None:
        pass


def is_public_ip(raw: str) -> bool:
    try:
        if "%" in raw:
            return False
        address = ipaddress.ip_address(raw)
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
        return address.is_global and not (address.is_multicast or address.is_reserved)
    except ValueError:
        return False


def _matches_host(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


def validate_url(raw: object, source_kind: str) -> str:
    if not isinstance(raw, str) or not raw:
        raise WorkerFailure("invalid_url")
    try:
        if len(raw.encode("utf-8")) > MAX_URL_BYTES:
            raise WorkerFailure("invalid_url")
    except UnicodeError:
        raise WorkerFailure("invalid_url") from None
    if any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in raw):
        raise WorkerFailure("unsafe_url")
    if "\\" in raw:
        raise WorkerFailure("unsafe_url")
    try:
        parts = urlsplit(raw)
        host = (parts.hostname or "").encode("idna").decode("ascii").lower().rstrip(".")
        port = parts.port
    except (ValueError, UnicodeError):
        raise WorkerFailure("invalid_url") from None
    if parts.scheme not in {"http", "https"} or not host:
        raise WorkerFailure("invalid_url")
    if parts.username is not None or parts.password is not None or parts.fragment:
        raise WorkerFailure("unsafe_url")
    if port is not None and port != (443 if parts.scheme == "https" else 80):
        raise WorkerFailure("unsafe_url")
    if "%" in host or host == "localhost" or host.endswith(LOCAL_SUFFIXES):
        raise WorkerFailure("unsafe_url")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        # Reject legacy numeric/hex address spellings that remote URL parsers may
        # reinterpret as private IPv4, as well as single-label local hostnames.
        labels = host.split(".")
        if len(labels) < 2 or all(re.fullmatch(r"(?:[0-9]+|0x[0-9a-f]+)", label) for label in labels):
            raise WorkerFailure("unsafe_url")
        if any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels):
            raise WorkerFailure("unsafe_url")
    else:
        if not is_public_ip(host):
            raise WorkerFailure("unsafe_url")
    if _matches_host(host, "xiaohongshu.com") or _matches_host(host, "xhslink.com"):
        raise WorkerFailure("reader_not_configured")
    if source_kind == "wechat_official_article" and host != "mp.weixin.qq.com":
        raise WorkerFailure("unsafe_url")
    if source_kind == "douyin" and not any(_matches_host(host, domain) for domain in ("douyin.com", "iesdouyin.com")):
        raise WorkerFailure("unsafe_url")
    # Decode nested parameter spellings defensively. Never resolve the source
    # hostname here: the approved path hands public URLs to Jina via upstream.
    query = parts.query
    for _ in range(3):
        if any(ord(character) < 32 or ord(character) == 127 for character in query):
            raise WorkerFailure("unsafe_url")
        try:
            parameters = parse_qsl(query, keep_blank_values=True, max_num_fields=128)
        except ValueError:
            raise WorkerFailure("unsafe_url") from None
        for key, _value in parameters:
            compact = re.sub(r"[^a-z0-9]", "", key.lower())
            if SENSITIVE_PARAMETER.search(key) or compact in SENSITIVE_COMPACT:
                raise WorkerFailure("unsafe_url")
        decoded = unquote(query)
        if decoded == query:
            break
        query = decoded
    else:
        # Refuse ambiguous deeply encoded queries rather than handing credentials
        # hidden under another decoding layer to the remote service.
        raise WorkerFailure("unsafe_url")
    return parts.geturl()


def audit_event(event: str, args: tuple) -> None:
    """Constrain the reviewed upstream network path, including HTTP redirects."""
    if event == "urllib.Request":
        try:
            parts = urlsplit(args[0])
            allowed = (
                parts.scheme == "https" and parts.hostname == "r.jina.ai"
                and parts.port in (None, 443) and parts.username is None
                and parts.password is None
            )
        except (ValueError, TypeError, IndexError):
            allowed = False
        if not allowed:
            raise WorkerFailure("upstream_policy_blocked")
    elif event == "socket.getaddrinfo":
        if args[0] != "r.jina.ai" or args[1] != 443:
            raise WorkerFailure("upstream_policy_blocked")
    elif event == "socket.connect":
        address = args[1]
        if not isinstance(address, tuple) or len(address) < 2 or address[1] != 443 or not is_public_ip(address[0]):
            raise WorkerFailure("upstream_policy_blocked")
    elif event in {"subprocess.Popen", "os.system", "os.posix_spawn", "os.fork", "os.forkpty", "os.exec", "pty.spawn"}:
        raise WorkerFailure("upstream_policy_blocked")


def load_reader() -> Callable[[str], str]:
    try:
        if importlib.metadata.version("agent-reach") != UPSTREAM_VERSION:
            raise WorkerFailure("upstream_incompatible")
        package = importlib.import_module("agent_reach")
        if getattr(package, "__version__", None) != UPSTREAM_VERSION:
            raise WorkerFailure("upstream_incompatible")
        module = importlib.import_module("agent_reach.channels.web")
        reader = module.WebChannel().read
        if not callable(reader):
            raise WorkerFailure("upstream_incompatible")
        return reader
    except (importlib.metadata.PackageNotFoundError, ModuleNotFoundError):
        raise WorkerFailure("upstream_unavailable") from None
    except AttributeError:
        raise WorkerFailure("upstream_incompatible") from None


def _reference(request: object, key: str) -> str:
    value = request.get(key) if isinstance(request, dict) else None
    return value if isinstance(value, str) and REF_PATTERN.fullmatch(value) else ""


def _base_response(request: object) -> dict:
    return {
        "schema_version": 1,
        "request_ref": _reference(request, "request_ref"),
        "attempt_ref": _reference(request, "attempt_ref"),
        "upstream_version": UPSTREAM_VERSION,
    }


def _reject_duplicate_keys(pairs: list[tuple]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise WorkerFailure("invalid_request")
        result[key] = value
    return result


def handle_request(raw: bytes, loader: Callable = load_reader) -> dict:
    request = None
    result = _base_response(request)
    try:
        if len(raw) > MAX_INPUT_BYTES:
            raise WorkerFailure("invalid_request")
        request = json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)
        result = _base_response(request)
        if not isinstance(request, dict) or set(request) != {"schema_version", "url", "source_kind", "request_ref", "attempt_ref"}:
            raise WorkerFailure("invalid_request")
        if type(request["schema_version"]) is not int or request["schema_version"] != 1:
            raise WorkerFailure("invalid_request")
        if not result["request_ref"] or not result["attempt_ref"]:
            raise WorkerFailure("invalid_request")
        source_kind = request["source_kind"]
        if not isinstance(source_kind, str):
            raise WorkerFailure("invalid_request")
        if source_kind not in SUPPORTED_KINDS:
            raise WorkerFailure("reader_not_configured")
        url = validate_url(request["url"], source_kind)
        # Any library diagnostics are suppressed; returned page text is data.
        with contextlib.redirect_stdout(DiscardOutput()), contextlib.redirect_stderr(DiscardOutput()):
            text = loader()(url)
        if not isinstance(text, str):
            raise WorkerFailure("upstream_incompatible")
        if not text.strip():
            raise WorkerFailure("upstream_empty")
        if len(text) > MAX_OUTPUT_BYTES:
            raise WorkerFailure("upstream_output_too_large")
        success = {**result, "outcome": "ok", "text": text}
        if len(encode_response(success)) > MAX_OUTPUT_BYTES:
            raise WorkerFailure("upstream_output_too_large")
        return success
    except WorkerFailure as error:
        code = error.code
    except (json.JSONDecodeError, UnicodeError, ValueError, RecursionError):
        code = "invalid_request" if request is None else "upstream_failed"
    except TimeoutError:
        code = "upstream_timeout"
    except urllib.error.URLError as error:
        code = "upstream_timeout" if isinstance(error.reason, TimeoutError) else "upstream_failed"
    except Exception:
        code = "upstream_failed"
    return {**result, "outcome": "failed", "code": code}


def encode_response(result: dict) -> bytes:
    return (json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def _deadline(_signum: int, _frame: object) -> None:
    raise WorkerFailure("upstream_timeout")


def main() -> None:
    # The parent must also supply a clean container environment. Clearing here
    # happens before upstream imports, and prevents urllib proxy inheritance.
    os.environ.clear()
    os.environ.update({"HOME": "/tmp/attention-empty-home", "LANG": "C.UTF-8"})
    signal.signal(signal.SIGALRM, _deadline)
    signal.alarm(DEADLINE_SECONDS)
    sys.addaudithook(audit_event)
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        response = handle_request(raw)
    except WorkerFailure as error:
        response = {**_base_response(None), "outcome": "failed", "code": error.code}
    finally:
        signal.alarm(0)
    sys.stdout.buffer.write(encode_response(response))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
