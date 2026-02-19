"""
GrantFinder AI - Backend API
Version 2.6 | FastAPI Backend
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import logging

from routers import auth, grants, processing, profile, export
from config import settings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


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
