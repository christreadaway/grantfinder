# Contributing to GrantFinder AI

Thank you for your interest in contributing to GrantFinder AI! This project helps Catholic parishes and schools find and match with grant opportunities.

## Getting Started

1. Fork the repository
2. Clone your fork
3. Set up the development environment (see README.md)
4. Create a new branch for your feature or fix

## Development Setup

### Backend (Python/FastAPI)

```bash
cd backend
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your credentials
uvicorn main:app --reload
```

### Frontend (Next.js)

```bash
cd frontend
npm install
cp .env.example .env.local
# Edit .env.local with your credentials
npm run dev
```

## Code Style

- **Python**: Follow PEP 8 guidelines
- **TypeScript/JavaScript**: Follow ESLint configuration
- **Commits**: Use clear, descriptive commit messages

## Pull Request Process

1. Create a feature branch (`git checkout -b feature/amazing-feature`)
2. Make your changes
3. Run tests and linting
4. Commit your changes (`git commit -m 'Add amazing feature'`)
5. Push to your fork (`git push origin feature/amazing-feature`)
6. Open a Pull Request

## Reporting Issues

- Use the GitHub issue tracker
- Include steps to reproduce the issue
- Include relevant logs or screenshots
- Specify your environment (OS, browser, etc.)

## Code of Conduct

Be respectful and constructive in all interactions. We're building this to help Catholic communities, so let's embody those values in how we work together.

## Questions?

Open an issue or reach out via [Patreon](https://patreon.com/christreadaway).

Thank you for contributing!
