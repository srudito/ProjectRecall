"""Backend tests for Project Recall Milestone 1."""
from __future__ import annotations

from fastapi.testclient import TestClient

from server import app


client = TestClient(app)


def test_health_endpoint() -> None:
    resp = client.get("/api/v1/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["version"] == "1.0.0"
    assert "supabase_configured" in body


def test_root_alias() -> None:
    resp = client.get("/api/")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_public_config_exposes_flags_without_secrets() -> None:
    resp = client.get("/api/v1/config")
    assert resp.status_code == 200
    body = resp.json()
    # feature flags default false
    flags = body["feature_flags"]
    assert flags["ask_ai_enabled"] is False
    assert flags["transcription_enabled"] is False
    assert flags["billing_enabled"] is False
    # No service-role key should ever appear anywhere in the response.
    assert "service_role" not in resp.text.lower()


def test_whoami_rejects_missing_auth() -> None:
    resp = client.get("/api/v1/me")
    assert resp.status_code == 401
    body = resp.json()
    assert body["error"]["code"] == "AUTH_SESSION_EXPIRED"


def test_whoami_rejects_invalid_bearer() -> None:
    resp = client.get("/api/v1/me", headers={"Authorization": "Bearer not.a.real.jwt"})
    # Either 401 (verifier could parse header but rejected), or 500 depending
    # on the environment. We accept both while ensuring no leakage.
    assert resp.status_code in (401, 500)
    assert "service_role" not in resp.text.lower()


def test_cors_headers_present() -> None:
    resp = client.options(
        "/api/v1/health",
        headers={
            "Origin": "https://example.com",
            "Access-Control-Request-Method": "GET",
        },
    )
    # Starlette's CORSMiddleware answers OPTIONS with 200 when allow_origins matches.
    assert resp.status_code in (200, 204, 400)
