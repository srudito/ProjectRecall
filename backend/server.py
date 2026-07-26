"""
Project Recall — FastAPI backend (Milestone 1).

Scope:
* Health check at /api/v1/health
* Public runtime config at /api/v1/config
* Supabase JWT verification helper (JWKS + fallback to /auth/v1/user)
* Centralized settings, structured logging, CORS

No AI, transcription, storage, or database endpoints in this milestone.
"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwk, jwt
from pydantic import BaseModel
from starlette.middleware.cors import CORSMiddleware

# ---------------------------------------------------------------------------
# Settings & logging
# ---------------------------------------------------------------------------
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")


class Settings(BaseModel):
    app_env: str = os.getenv("APP_ENV", "development")
    log_level: str = os.getenv("LOG_LEVEL", "INFO")
    supabase_url: str = os.getenv("SUPABASE_URL", "")
    supabase_anon_key: str = os.getenv("SUPABASE_ANON_KEY", "")
    supabase_jwt_secret: str = os.getenv("SUPABASE_JWT_SECRET", "")
    cors_allowed_origins: str = os.getenv("CORS_ALLOWED_ORIGINS", "*")
    # Client-visible values for /api/v1/config
    public_supabase_url: str = os.getenv("EXPO_PUBLIC_SUPABASE_URL", "")


settings = Settings()


logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)
logger = logging.getLogger("project_recall")


# ---------------------------------------------------------------------------
# App bootstrap
# ---------------------------------------------------------------------------
app = FastAPI(title="Project Recall API", version="1.0.0")

origins_raw = settings.cors_allowed_origins.strip()
if origins_raw == "*" or origins_raw == "":
    allowed_origins = ["*"]
else:
    allowed_origins = [o.strip() for o in origins_raw.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def structured_log(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    duration_ms = int((time.time() - start) * 1000)
    logger.info(
        "http_request path=%s method=%s status=%s duration_ms=%s",
        request.url.path,
        request.method,
        response.status_code,
        duration_ms,
    )
    return response


# ---------------------------------------------------------------------------
# Safe error envelope
# ---------------------------------------------------------------------------
class ApiError(Exception):
    def __init__(self, code: str, http_status: int = 400, message: Optional[str] = None):
        self.code = code
        self.http_status = http_status
        self.message = message
        super().__init__(message or code)


@app.exception_handler(ApiError)
async def api_error_handler(_: Request, exc: ApiError):
    return JSONResponse(
        status_code=exc.http_status,
        content={"error": {"code": exc.code, "message": exc.message}},
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(_: Request, exc: Exception):
    logger.exception("Unhandled error", exc_info=exc)
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "UNKNOWN_ERROR"}},
    )


# ---------------------------------------------------------------------------
# JWT verification helper
# ---------------------------------------------------------------------------
bearer_scheme = HTTPBearer(auto_error=False)

_jwks_cache: dict[str, Any] = {"keys": None, "fetched_at": 0.0}
_JWKS_TTL_SEC = 60 * 60


async def _fetch_jwks() -> Optional[list[dict[str, Any]]]:
    if not settings.supabase_url:
        return None
    if _jwks_cache["keys"] and time.time() - _jwks_cache["fetched_at"] < _JWKS_TTL_SEC:
        return _jwks_cache["keys"]
    url = f"{settings.supabase_url}/auth/v1/.well-known/jwks.json"
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            resp = await client.get(url)
            if resp.status_code == 200:
                keys = resp.json().get("keys")
                _jwks_cache["keys"] = keys
                _jwks_cache["fetched_at"] = time.time()
                return keys
        except httpx.HTTPError:
            logger.warning("jwks_fetch_failed url=%s", url)
    return None


async def verify_supabase_jwt(token: str) -> dict[str, Any]:
    """Verify a Supabase-issued JWT and return the decoded payload.

    Tries local JWKS verification first (RS256), then falls back to shared
    secret (HS256) if configured, then to a live /auth/v1/user check.
    """
    try:
        header = jwt.get_unverified_header(token)
    except JWTError as exc:
        raise ApiError("AUTH_SESSION_EXPIRED", 401, "Malformed token") from exc
    alg = header.get("alg")
    kid = header.get("kid")

    keys = await _fetch_jwks()
    if keys and alg in ("RS256", "ES256"):
        key_dict = next((k for k in keys if k.get("kid") == kid), None)
        if key_dict:
            try:
                public_key = jwk.construct(key_dict)
                return jwt.decode(
                    token,
                    public_key.to_pem().decode("utf-8"),
                    algorithms=[alg],
                    options={"verify_aud": False},
                )
            except JWTError as e:
                raise ApiError("AUTH_SESSION_EXPIRED", 401, str(e))

    if alg == "HS256" and settings.supabase_jwt_secret:
        try:
            return jwt.decode(
                token,
                settings.supabase_jwt_secret,
                algorithms=["HS256"],
                options={"verify_aud": False},
            )
        except JWTError as e:
            raise ApiError("AUTH_SESSION_EXPIRED", 401, str(e))

    # Last-resort live check against Supabase.
    if settings.supabase_url and settings.supabase_anon_key:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{settings.supabase_url}/auth/v1/user",
                headers={
                    "apikey": settings.supabase_anon_key,
                    "Authorization": f"Bearer {token}",
                },
            )
            if resp.status_code == 200:
                user = resp.json()
                return {"sub": user.get("id"), "email": user.get("email")}
            raise ApiError("AUTH_SESSION_EXPIRED", 401, "Token rejected by Supabase")

    raise ApiError("AUTH_SESSION_EXPIRED", 401, "JWT verification not configured")


async def require_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> dict[str, Any]:
    if creds is None or (creds.scheme or "").lower() != "bearer":
        raise ApiError("AUTH_SESSION_EXPIRED", 401, "Missing bearer credentials")
    payload = await verify_supabase_jwt(creds.credentials)
    return {"id": payload.get("sub"), "email": payload.get("email"), "raw": payload}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

from fastapi import APIRouter  # noqa: E402  (kept below to avoid confusion)

root_router = APIRouter(prefix="/api")
v1_router = APIRouter(prefix="/api/v1")


class HealthResponse(BaseModel):
    status: str
    version: str
    env: str
    supabase_configured: bool
    timestamp: float


@v1_router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        version="1.0.0",
        env=settings.app_env,
        supabase_configured=bool(settings.supabase_url),
        timestamp=time.time(),
    )


class PublicConfigResponse(BaseModel):
    supabase_url: str
    supabase_anon_key_present: bool
    feature_flags: dict[str, bool]


@v1_router.get("/config", response_model=PublicConfigResponse)
async def public_config() -> PublicConfigResponse:
    return PublicConfigResponse(
        supabase_url=settings.public_supabase_url,
        supabase_anon_key_present=bool(os.getenv("EXPO_PUBLIC_SUPABASE_ANON_KEY", "")),
        feature_flags={
            "ask_ai_enabled": False,
            "transcription_enabled": False,
            "live_transcription_enabled": False,
            "billing_enabled": False,
            "ads_enabled": False,
            "admin_enabled": False,
        },
    )


class WhoAmIResponse(BaseModel):
    id: Optional[str]
    email: Optional[str]


@v1_router.get("/me", response_model=WhoAmIResponse)
async def whoami(user: dict[str, Any] = Depends(require_user)) -> WhoAmIResponse:
    return WhoAmIResponse(id=user.get("id"), email=user.get("email"))


# Legacy compatibility.
@root_router.get("/")
async def root_ok() -> dict[str, str]:
    return {"service": "project-recall-api", "status": "ok"}


@root_router.get("/health")
async def root_health() -> dict[str, str]:
    # Alias for infra probes hitting /api/health.
    return {"status": "ok"}


app.include_router(root_router)
app.include_router(v1_router)


@app.on_event("startup")
async def _startup() -> None:
    logger.info(
        "startup env=%s supabase_configured=%s",
        settings.app_env,
        bool(settings.supabase_url),
    )
