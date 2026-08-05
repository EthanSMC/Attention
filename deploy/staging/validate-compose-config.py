#!/usr/bin/env python3
"""Validate security boundaries in Docker Compose's rendered JSON model."""

from __future__ import annotations

import json
import sys
from typing import Any


def fail(message: str) -> None:
    raise SystemExit(message)


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: validate-compose-config.py <expected-postgres-data-path>")

    expected_data_path = sys.argv[1]
    config: dict[str, Any] = json.load(sys.stdin)
    if config.get("name") != "attention-staging":
        fail("Compose project must remain attention-staging")
    services = config.get("services", {})

    for service in ("postgres", "fetcher", "web", "worker"):
        if service not in services:
            fail(f"required Compose service is missing: {service}")

    if services["postgres"].get("ports"):
        fail("PostgreSQL must not publish a host port")
    if services["fetcher"].get("ports"):
        fail("Fetcher must not publish a host port")
    if services["worker"].get("ports"):
        fail("Worker must not publish a host port")
    for service_name, service in services.items():
        if service_name not in {"web", "wechat-adapter"} and service.get("ports"):
            fail(f"only reviewed edge services may publish host ports: {service_name}")

    web_ports = services["web"].get("ports", [])
    loopback_web = (
        len(web_ports) == 1
        and isinstance(web_ports[0], dict)
        and str(web_ports[0].get("published")) == "9199"
        and str(web_ports[0].get("target")) == "3000"
        and web_ports[0].get("host_ip") == "127.0.0.1"
    )
    if not loopback_web:
        fail("Web must publish exactly one loopback port: 127.0.0.1:9199 to 3000")

    if "wechat-adapter" in services:
        wechat_ports = services["wechat-adapter"].get("ports", [])
        loopback_wechat = (
            len(wechat_ports) == 1
            and isinstance(wechat_ports[0], dict)
            and str(wechat_ports[0].get("published")) == "9299"
            and str(wechat_ports[0].get("target")) == "4200"
            and wechat_ports[0].get("host_ip") == "127.0.0.1"
        )
        if not loopback_wechat:
            fail("WeChat adapter must publish exactly one loopback port: 127.0.0.1:9299 to 4200")

    for service_name, service in services.items():
        if service.get("privileged"):
            fail(f"service must not be privileged: {service_name}")
        if service.get("network_mode") == "host" or service.get("pid") == "host":
            fail(f"service must not share a host namespace: {service_name}")
        for volume in service.get("volumes", []):
            source = volume.get("source", "") if isinstance(volume, dict) else str(volume)
            if source in {"/var/run/docker.sock", "/run/docker.sock"}:
                fail(f"service must not mount the Docker socket: {service_name}")

    database_network = config.get("networks", {}).get("database", {})
    if not database_network.get("internal"):
        fail("database network must remain internal")

    postgres_volume = config.get("volumes", {}).get("postgres_data", {})
    if postgres_volume.get("name") != "attention-staging-postgres-data":
        fail("PostgreSQL volume must remain dedicated to Attention staging")
    device = postgres_volume.get("driver_opts", {}).get("device")
    if device != expected_data_path:
        fail("PostgreSQL data volume is not bound to the staging data path")


if __name__ == "__main__":
    main()
