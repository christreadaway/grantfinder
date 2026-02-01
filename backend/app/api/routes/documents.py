from typing import List
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import json

from app.core.database import get_db
from app.api.dependencies.auth import get_current_user, get_current_user_with_api_key
from app.models.user import User
from app.models.organization import Organization
from app.models.document import Document
from app.schemas.document import DocumentResponse, DocumentUploadResponse
from app.services.document_service import DocumentService
from app.services.ai_service import AIService


router = APIRouter()

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB
MAX_DOCUMENTS = 20


@router.get("/{org_id}", response_model=List[DocumentResponse])
async def list_documents(
    org_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """List all documents for an organization."""
    # Verify ownership
    result = await db.execute(
        select(Organization).where(
            Organization.id == org_id,
            Organization.user_id == current_user.id
        )
    )
    org = result.scalar_one_or_none()

    if org is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found"
        )

    result = await db.execute(
        select(Document).where(Document.organization_id == org_id)
    )
    return result.scalars().all()


@router.post("/{org_id}/upload", response_model=DocumentUploadResponse)
async def upload_documents(
    org_id: int,
    files: List[UploadFile] = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Upload documents for processing."""
    # Verify ownership
    result = await db.execute(
        select(Organization).where(
            Organization.id == org_id,
            Organization.user_id == current_user.id
        )
    )
    org = result.scalar_one_or_none()

    if org is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found"
        )

    # Check existing document count
    result = await db.execute(
        select(Document).where(Document.organization_id == org_id)
    )
    existing_count = len(result.scalars().all())

    if existing_count + len(files) > MAX_DOCUMENTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Maximum {MAX_DOCUMENTS} documents allowed per organization"
        )

    uploaded_docs = []
    errors = []

    for file in files:
        # Validate file type
        file_type = DocumentService.get_file_type(file.filename)
        if file_type is None:
            errors.append(f"{file.filename}: Unsupported file type")
            continue

        # Read content
        content = await file.read()

        # Check file size
        if len(content) > MAX_FILE_SIZE:
            errors.append(f"{file.filename}: File too large (max 50MB)")
            continue

        # Create document record
        doc = Document(
            organization_id=org_id,
            filename=file.filename,
            file_type=file_type,
            file_size=len(content),
            status="pending",
        )
        db.add(doc)
        await db.flush()

        # Extract text
        try:
            extracted_text, doc_type = await DocumentService.extract_text(
                content, file_type, file.filename
            )
            doc.extracted_text = extracted_text
            doc.status = "completed"
            doc.processed_at = datetime.utcnow()
        except ValueError as e:
            doc.status = "failed"
            doc.error_message = str(e)

        await db.refresh(doc)
        uploaded_docs.append(doc)

    message = f"Uploaded {len(uploaded_docs)} document(s)"
    if errors:
        message += f". Errors: {', '.join(errors)}"

    return DocumentUploadResponse(
        documents=[DocumentResponse.model_validate(d) for d in uploaded_docs],
        message=message
    )


@router.post("/{org_id}/process")
async def process_documents(
    org_id: int,
    current_user: User = Depends(get_current_user_with_api_key),
    db: AsyncSession = Depends(get_db)
):
    """Process all documents with AI to extract grant-relevant needs."""
    # Verify ownership
    result = await db.execute(
        select(Organization).where(
            Organization.id == org_id,
            Organization.user_id == current_user.id
        )
    )
    org = result.scalar_one_or_none()

    if org is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found"
        )

    # Get documents
    result = await db.execute(
        select(Document).where(
            Document.organization_id == org_id,
            Document.status == "completed"
        )
    )
    documents = result.scalars().all()

    if not documents:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No processed documents found"
        )

    async def generate_events():
        """Generate Server-Sent Events for document processing."""
        ai_service = AIService(current_user.api_key_encrypted)
        all_needs = []

        for doc in documents:
            yield f"data: {json.dumps({'type': 'status', 'message': f'Reading {doc.filename}...'})}\n\n"

            if doc.extracted_text:
                doc_type = DocumentService._guess_document_type(doc.filename)

                yield f"data: {json.dumps({'type': 'status', 'message': f'Analyzing {doc.filename} with AI...'})}\n\n"

                needs = await ai_service.extract_from_document(
                    doc.extracted_text,
                    doc_type,
                    doc.filename
                )

                doc.extracted_needs = needs

                for need in needs:
                    yield f"data: {json.dumps({'type': 'extracted', 'item': need['need'], 'source': doc.filename})}\n\n"
                    all_needs.append({
                        **need,
                        "source": doc.filename,
                        "source_type": "document"
                    })

                yield f"data: {json.dumps({'type': 'status', 'message': f'✓ Extracted {len(needs)} grant-relevant items from {doc.filename}'})}\n\n"

        # Update organization with all extracted needs
        org.extracted_needs = all_needs
        await db.flush()

        yield f"data: {json.dumps({'type': 'complete', 'total_needs': len(all_needs), 'documents_processed': len(documents)})}\n\n"

    return StreamingResponse(
        generate_events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )


@router.delete("/{org_id}/{doc_id}")
async def delete_document(
    org_id: int,
    doc_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Delete a document."""
    # Verify ownership
    result = await db.execute(
        select(Organization).where(
            Organization.id == org_id,
            Organization.user_id == current_user.id
        )
    )
    org = result.scalar_one_or_none()

    if org is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found"
        )

    result = await db.execute(
        select(Document).where(
            Document.id == doc_id,
            Document.organization_id == org_id
        )
    )
    doc = result.scalar_one_or_none()

    if doc is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found"
        )

    await db.delete(doc)
    return {"message": "Document deleted"}
