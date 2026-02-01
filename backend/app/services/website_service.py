import asyncio
from typing import List, Optional, AsyncGenerator
from urllib.parse import urljoin, urlparse
import aiohttp
from bs4 import BeautifulSoup


class WebsiteService:
    """Service for crawling and extracting content from websites."""

    MAX_PAGES = 25  # Limit pages to crawl
    TIMEOUT = 10  # Seconds per request

    # Common paths to check for Catholic parish/school sites
    PRIORITY_PATHS = [
        "/",
        "/about",
        "/about-us",
        "/about-our-parish",
        "/parish",
        "/school",
        "/our-school",
        "/academics",
        "/ministries",
        "/our-ministries",
        "/staff",
        "/our-staff",
        "/leadership",
        "/pastor",
        "/contact",
        "/news",
        "/announcements",
        "/calendar",
        "/giving",
        "/stewardship",
    ]

    @staticmethod
    async def crawl_website(base_url: str) -> AsyncGenerator[dict, None]:
        """
        Crawl a website and yield status updates and extracted content.
        Yields dictionaries with 'type' (status/content) and data.
        """
        visited = set()
        to_visit = []
        base_domain = urlparse(base_url).netloc

        # Normalize base URL
        if not base_url.startswith(('http://', 'https://')):
            base_url = 'https://' + base_url
        base_url = base_url.rstrip('/')

        # Add priority paths
        for path in WebsiteService.PRIORITY_PATHS:
            full_url = urljoin(base_url, path)
            if full_url not in visited:
                to_visit.append(full_url)

        all_content = []

        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=WebsiteService.TIMEOUT),
            headers={"User-Agent": "GrantFinder AI Bot/1.0"}
        ) as session:
            pages_crawled = 0

            while to_visit and pages_crawled < WebsiteService.MAX_PAGES:
                url = to_visit.pop(0)

                if url in visited:
                    continue

                visited.add(url)

                try:
                    yield {"type": "status", "message": f"Scanning {urlparse(url).path or '/'}..."}

                    async with session.get(url, allow_redirects=True) as response:
                        if response.status != 200:
                            continue

                        content_type = response.headers.get('content-type', '')
                        if 'text/html' not in content_type:
                            continue

                        html = await response.text()
                        soup = BeautifulSoup(html, 'lxml')

                        # Extract text content
                        page_content = WebsiteService._extract_content(soup)

                        if page_content.get("text"):
                            all_content.append({
                                "url": url,
                                "path": urlparse(url).path or "/",
                                **page_content
                            })

                            # Yield extracted items
                            for item in page_content.get("extracted_items", []):
                                yield {"type": "extracted", "item": item}

                        pages_crawled += 1

                        # Find more links (only from same domain)
                        for link in soup.find_all('a', href=True):
                            href = link['href']
                            full_url = urljoin(url, href)
                            parsed = urlparse(full_url)

                            if (parsed.netloc == base_domain and
                                full_url not in visited and
                                not any(ext in parsed.path.lower() for ext in ['.pdf', '.jpg', '.png', '.gif', '.doc'])):
                                to_visit.append(full_url)

                except asyncio.TimeoutError:
                    yield {"type": "warning", "message": f"Timeout: {url}"}
                except Exception as e:
                    yield {"type": "warning", "message": f"Error: {url} - {str(e)[:50]}"}

            yield {
                "type": "complete",
                "pages_crawled": pages_crawled,
                "content": all_content
            }

    @staticmethod
    def _extract_content(soup: BeautifulSoup) -> dict:
        """Extract meaningful content from a page."""
        # Remove script and style elements
        for script in soup(["script", "style", "nav", "footer", "header"]):
            script.decompose()

        # Get page title
        title = ""
        if soup.title:
            title = soup.title.string or ""

        # Get main content
        main_content = soup.find('main') or soup.find('article') or soup.find('div', {'class': 'content'}) or soup.body

        text = ""
        if main_content:
            text = main_content.get_text(separator="\n", strip=True)

        # Try to extract specific items
        extracted_items = []

        # Look for parish/school info patterns
        text_lower = text.lower()

        if "founded" in text_lower or "established" in text_lower:
            # Try to find founding year
            import re
            years = re.findall(r'\b(19|20)\d{2}\b', text)
            if years:
                extracted_items.append(f"Founded/established: may be {years[0]}")

        if "families" in text_lower:
            import re
            families = re.findall(r'(\d{1,3}(?:,\d{3})*|\d+)\s*(?:registered\s+)?families', text_lower)
            if families:
                extracted_items.append(f"Parish size: ~{families[0]} families")

        if "students" in text_lower:
            import re
            students = re.findall(r'(\d{1,3}(?:,\d{3})*|\d+)\s*students', text_lower)
            if students:
                extracted_items.append(f"School enrollment: {students[0]} students")

        if "prek" in text_lower or "pre-k" in text_lower or "kindergarten" in text_lower:
            extracted_items.append("Has PreK/Kindergarten program")

        if any(grade in text_lower for grade in ["8th grade", "grade 8", "k-8", "prek-8"]):
            extracted_items.append("School grades: likely K-8 or PreK-8")

        if "diocese" in text_lower:
            import re
            diocese = re.findall(r'diocese\s+of\s+([A-Za-z\s]+)', text_lower)
            if diocese:
                extracted_items.append(f"Diocese: {diocese[0].strip().title()}")

        # Count ministries mentioned
        ministry_keywords = ["ministry", "ministries", "outreach", "program"]
        if any(kw in text_lower for kw in ministry_keywords):
            extracted_items.append("Has active ministries/programs")

        return {
            "title": title,
            "text": text[:10000],  # Limit text size
            "extracted_items": extracted_items
        }

    @staticmethod
    async def fetch_single_page(url: str) -> Optional[str]:
        """Fetch and extract text from a single page."""
        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=WebsiteService.TIMEOUT),
                headers={"User-Agent": "GrantFinder AI Bot/1.0"}
            ) as session:
                async with session.get(url) as response:
                    if response.status == 200:
                        html = await response.text()
                        soup = BeautifulSoup(html, 'lxml')
                        for script in soup(["script", "style"]):
                            script.decompose()
                        return soup.get_text(separator="\n", strip=True)
        except Exception:
            pass
        return None
