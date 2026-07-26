"""Backend tests for Project Recall Milestone 1.

Covers: /api/, /api/v1/health, /api/v1/config, /api/v1/me auth guards,
service-role leak check, and CORS preflight.
"""
import os
import json
import pytest

BASE = os.environ.get('EXPO_PUBLIC_BACKEND_URL', '').rstrip('/')


# ---- /api/ root ---------------------------------------------------------
class TestRoot:
    def test_root_ok(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/")
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get('status') == 'ok'
        assert 'service' in data


# ---- /api/v1/health -----------------------------------------------------
class TestHealth:
    def test_health_shape(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/v1/health")
        assert r.status_code == 200, r.text
        d = r.json()
        for key in ('status', 'version', 'env', 'supabase_configured', 'timestamp'):
            assert key in d, f"missing {key} in {d}"
        assert d['status'] == 'ok'
        assert isinstance(d['supabase_configured'], bool)
        assert isinstance(d['timestamp'], (int, float))
        # supabase not configured in preview
        assert d['supabase_configured'] is False


# ---- /api/v1/config -----------------------------------------------------
class TestConfig:
    def test_config_feature_flags_all_false(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/v1/config")
        assert r.status_code == 200, r.text
        d = r.json()
        flags = d.get('feature_flags') or {}
        expected = {'ask_ai_enabled', 'transcription_enabled',
                    'live_transcription_enabled', 'billing_enabled',
                    'ads_enabled', 'admin_enabled'}
        assert expected.issubset(set(flags.keys())), f"missing flags: {flags}"
        for k in expected:
            assert flags[k] is False, f"{k} must be False"

    def test_config_no_service_role_leak(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/v1/config")
        raw = r.text.lower()
        assert 'service_role' not in raw
        assert 'service-role' not in raw
        assert 'jwt_secret' not in raw


# ---- /api/v1/me auth guards --------------------------------------------
class TestMeAuth:
    def test_me_no_token_returns_401(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/v1/me")
        assert r.status_code == 401, r.text
        body = r.json()
        assert 'error' in body
        assert body['error'].get('code') == 'AUTH_SESSION_EXPIRED'

    def test_me_malformed_token_returns_401(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/v1/me",
                           headers={'Authorization': 'Bearer not-a-jwt'})
        assert r.status_code == 401, r.text
        body = r.json()
        assert body.get('error', {}).get('code') == 'AUTH_SESSION_EXPIRED'

    def test_me_wrong_scheme_returns_401(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/v1/me",
                           headers={'Authorization': 'Basic abcdef'})
        assert r.status_code == 401, r.text


# ---- Global service-role leak scan -------------------------------------
class TestLeakScan:
    def test_no_service_role_in_public_endpoints(self, api_client, base_url):
        endpoints = ['/api/', '/api/v1/health', '/api/v1/config']
        for ep in endpoints:
            r = api_client.get(f"{base_url}{ep}")
            txt = r.text.lower()
            assert 'service_role' not in txt, f"{ep} leaks service_role"
            assert 'supabase_service_role_key' not in txt
            assert 'supabase_jwt_secret' not in txt


# ---- CORS ---------------------------------------------------------------
class TestCORS:
    def test_options_preflight(self, api_client, base_url):
        r = api_client.options(
            f"{base_url}/api/v1/health",
            headers={
                'Origin': 'http://localhost:19006',
                'Access-Control-Request-Method': 'GET',
                'Access-Control-Request-Headers': 'content-type',
            },
        )
        # Some ingresses strip CORS but the backend should respond 200/204
        assert r.status_code in (200, 204), f"got {r.status_code}: {r.text}"

    def test_cors_header_on_get(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/v1/health",
                           headers={'Origin': 'http://localhost:19006'})
        # Accept if either 'access-control-allow-origin' exists or absent (ingress dependent)
        # but if present must be * or echo origin
        aco = r.headers.get('access-control-allow-origin')
        if aco is not None:
            assert aco in ('*', 'http://localhost:19006')
