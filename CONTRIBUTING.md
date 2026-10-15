# Contributing to GrantFinder AI

Thank you for your interest in contributing to GrantFinder AI! This project helps Catholic parishes and schools find and match with grant opportunities.

## Getting Started

1. Fork the repository
2. Clone your fork
3. Set up the development environment (see README.md)
4. Create a new branch for your feature or fix

## Development Setup

The website and the engine are one Next.js app in `frontend/` (the engine is TypeScript in
`frontend/src/server`; see `docs/engine.md`). The old Python engine in `backend/` is reference only.

```bash
cd ~/grantfinder/frontend
sfw npm install            # if sfw isn't installed, use: npm install
cp .env.example .env.local
# Optional: edit .env.local (guest sign-in is on by default)
npm run dev
```

Run the tests before opening a pull request:

```bash
cd ~/grantfinder
bash tests/engine/run_all.sh   # 7 engine suites (515 checks), mock Claude, no API key needed
bash tests/e2e/run_e2e.sh      # browser test of the whole journey, 436 checks (setup at the top of the script)
```

## Code Style

- **TypeScript/JavaScript**: Follow ESLint configuration (`cd ~/grantfinder/frontend && npx eslint src/server` must stay clean)
- **Python** (legacy `backend/` only): Follow PEP 8 guidelines
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
