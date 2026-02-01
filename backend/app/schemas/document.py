from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel


class DocumentResponse(BaseModel):
    id: int
    filename: str
    file_type: str
    file_size: int
    status: str
    extracted_needs: Optional[List[dict]] = None
    error_message: Optional[str] = None
    uploaded_at: datetime
    processed_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class DocumentUploadResponse(BaseModel):
    documents: List[DocumentResponse]
    message: str
