from fastapi import APIRouter

from app.api.routes import auth, users, organizations, grants, documents, matching

api_router = APIRouter()

api_router.include_router(auth.router, prefix="/auth", tags=["authentication"])
api_router.include_router(users.router, prefix="/users", tags=["users"])
api_router.include_router(organizations.router, prefix="/organizations", tags=["organizations"])
api_router.include_router(grants.router, prefix="/grants", tags=["grants"])
api_router.include_router(documents.router, prefix="/documents", tags=["documents"])
api_router.include_router(matching.router, prefix="/matching", tags=["matching"])
