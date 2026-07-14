"""
GrantFinder AI - Backend API
Version 2.6 | FastAPI Backend
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import logging
import logging.handlers
import os
from pathlib import Path

from routers import auth, grants, processing, profile, export, discovery, writer
from config import settings

logging.basicConfig(level=logging.DEBUG if os.getenv("LOG_LEVEL", "").lower() == "debug" else logging.INFO)
logger = logging.getLogger(__name__)

# File-based logs with daily rotation (~/logs/grantfinder/), per writer PRD S8.
# Failure to create the log dir must never block startup.
try:
    _log_dir = Path.home() / "logs" / "grantfinder"
    _log_dir.mkdir(parents=True, exist_ok=True)
    _file_handler = logging.handlers.TimedRotatingFileHandler(
        _log_dir / "grantfinder.log", when="midnight", backupCount=14, encoding="utf-8"
    )
    _file_handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s %(message)s"
    ))
    logging.getLogger().addHandler(_file_handler)
except Exception as _e:  # pragma: no cover
    logger.warning(f"File logging unavailable: {_e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan management."""
    logger.info("GrantFinder AI Backend starting up...")
    yield
    logger.info("GrantFinder AI Backend shutting down...")


app = FastAPI(
    title="GrantFinder AI",
    description="Intelligent grant discovery and matching platform for Catholic parishes and schools",
    version="2.6.0",
    lifespan=lifespan,
)

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(auth.router, prefix="/api/auth", tags=["Authentication"])
app.include_router(grants.router, prefix="/api/grants", tags=["Grants"])
app.include_router(processing.router, prefix="/api/processing", tags=["AI Processing"])
app.include_router(profile.router, prefix="/api/profile", tags=["Organization Profile"])
app.include_router(export.router, prefix="/api/export", tags=["Export"])
app.include_router(discovery.router, prefix="/api/discovery", tags=["Grant Discovery"])
app.include_router(writer.router, prefix="/api/writer", tags=["Application Writer"])


@app.get("/")
async def root():
    """Health check endpoint."""
    return {
        "name": "GrantFinder AI",
        "version": "2.6.0",
        "status": "healthy",
        "message": "Upload your documents. Enter your website. Get every grant opportunity scored and ranked.",
    }


@app.get("/api/health")
async def health_check():
    """Detailed health check."""
    return {
        "status": "healthy",
        "services": {
            "api": True,
            "database": True,
        },
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
