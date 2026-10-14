# GrantFinder AI

**Match your parish or school to the right grants, then draft the application.**

GrantFinder AI scans your website, reads your bulletins and meeting minutes, asks smart questions based on actual grant requirements, and recommends which grants are the best fit. Its GrantWriter then drafts the application with you, section by section, grounded in your own evidence. You review and submit; nothing is ever sent to a funder automatically.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Status](https://img.shields.io/badge/status-in%20development-yellow.svg)

---

## 🎯 What It Does

1. **Build your grant database** — a curated starter database, live Grants.gov search, AI web discovery, and/or your own Excel file
2. **Scan your website** — AI crawls your church/school site to learn about your organization (or type the basics if your site blocks bots)
3. **Answer a smart questionnaire** — AI generates questions based on what grants actually require
4. **Upload parish documents** — Bulletins, meeting minutes, newsletters, strategic plans, prior grant reports
5. **Get matched** — Ranked recommendations with explanations of why each grant fits
6. **Write the application** — requirements, fit and gap analysis, stakeholder questions, drafts in your voice, a rubric self-score, and Word/portal exports

### Terminal-Style Processing

Watch the AI work in real-time with a terminal interface:

```
[14:32:03] Scanning https://yourparish.org/about...
[14:32:04] ✓ Extracted: Parish founded 1978
[14:32:04] ✓ Extracted: ~1,200 registered families
[14:32:05] Scanning /school...
[14:32:06] ✓ Extracted: PreK-8, 250 students
```

### Product Roadmap

| Version | Capability |
|---------|------------|
| **v1.0** | Grant discovery + probability scoring (0-100% match scores) |
| **v1.5** | Teacher Edition — lighter version for classroom grants |
| **v2.0** | AI drafts grant applications for human review (available now: GrantWriter) |
| **v3.0** | Autonomous application submission with human approval gate |

### Match Scoring

Every grant gets a probability score:

| Score | Meaning |
|-------|---------|
| 🟢 85-100% | Excellent match — prioritize this |
| 🟡 70-84% | Good match — worth exploring |
| 🟠 50-69% | Possible — verify requirements |
| 🔴 25-49% | Weak — unlikely but not impossible |
| ⚫ 0-24% | Not eligible |

### Example Match

```
┌──────────────────────────────────────────────────────┐
│ 92%  KaBOOM! Build It Yourself Grant                 │
│      Up to $15,000  |  Due: Rolling                  │
│      ───────────────────────────────────────────     │
│      Your March 15 bulletin mentioned "playground    │
│      equipment is 30 years old." KaBOOM! funds       │
│      playground equipment for churches and schools.  │
└──────────────────────────────────────────────────────┘
```

Every match shows: **Score**, **Amount**, **Due Date**, and **Why it fits**.

---

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- Claude API key from [Anthropic](https://console.anthropic.com/)
- Optional: Google Cloud project with OAuth configured (guest sign-in works without it)

### Local Development

The whole app (website and engine) is one Next.js project in `frontend/`:

```bash
cd ~/grantfinder/frontend
sfw npm install
cp .env.example .env.local
npm run dev
```

If `sfw` isn't installed, use `npm install`. `.env.example` turns on guest sign-in, so no Google
setup is needed locally.

Open [http://localhost:3000](http://localhost:3000)

### Setup in the App

1. **Sign in with Google** (or **Continue as guest** when guest sign-in is on)
2. **Enter your Claude API key** — [Get one from Anthropic](https://console.anthropic.com/)
3. **Load grants**: the starter database, Grants.gov, AI web discovery, and/or your own Excel file
4. **Add your website URLs**: church site and/or school site (or enter the basics by hand)
5. **Answer the questions and add documents**, then **Find Matches**
6. **Write Application** on any match to open the GrantWriter

Your work is saved as you go. Come back later and the dashboard picks up where you left off,
with your applications listed at the top.

### Deploy to the Web

Everything deploys to **Netlify**: the website, the engine API, the AI background worker, and
storage (Netlify Blobs). Follow [docs/deployment.md](docs/deployment.md): about 15 minutes, click by click.
How the pieces fit together: [docs/engine.md](docs/engine.md).

---

## 📁 Grant Database Format

Upload an Excel file (.xlsx) with these columns:

| Column | Required | Description |
|--------|----------|-------------|
| Grant Name | ✅ | Name of the grant |
| Granting Authority | ✅ | Foundation or organization |
| Deadline | | Date (YYYY-MM-DD) or "Rolling" |
| Amount Min | | Minimum grant amount |
| Amount Max | | Maximum grant amount |
| Description | ✅ | What the grant funds |
| Eligibility | | Requirements to apply |
| Apply URL | | Link to application |
| Geographic Restriction | | State/region limits |
| Categories | | Tags (comma-separated) |

Sheet names and every accepted column are in [docs/grant-template-format.md](./docs/grant-template-format.md).
Uploads merge into your database (nothing is deleted), up to 4 MB per file.

---

## 📄 Supported Documents

**Church:**
- Weekly bulletins / e-bulletins
- Pastor's letters
- Parish annual reports
- Ministry updates

**School:**
- School newsletters
- Principal updates
- Curriculum plans

**Both:**
- Meeting minutes (finance council, school board, pastoral council)
- Strategic plans
- Capital campaign materials
- Budget documents

**Formats:** PDF, DOCX, TXT (up to 4 MB each). What Claude finds is added to your profile as
evidence the GrantWriter can cite.

---

## 🎨 Interface

- **Dark mode by default** (light mode available)
- **Terminal-style processing view** — watch the AI work in real-time
- **Mobile responsive** — works on phone, tablet, desktop

---

## 🔐 Privacy & Security

- **Google sign-in or guest sign-in** — We never store passwords
- **Your API key** — Encrypted (AES-256-GCM) before it is stored, used only for your requests, never logged
- **Your documents** — Processed to extract grant-relevant facts; the file itself is not kept
- **Your data** — Stored in your own Netlify site's storage (Netlify Blobs), separated per user
- **No sharing** — Your data is never shared or used to train models

---

## 🛠 Tech Stack

| Component | Technology |
|-----------|------------|
| Website | Next.js 16, React 19, TypeScript, Tailwind |
| Engine | TypeScript API routes (`frontend/src/server`) + a Netlify background function for AI jobs |
| Database | Netlify Blobs |
| Auth | Google OAuth or guest sign-in; signed session tokens |
| AI | Claude API via the Anthropic TypeScript SDK (model set by `CLAUDE_MODEL`) |
| Hosting | Netlify |

The original Python (FastAPI) engine is kept in `backend/` as reference only.

---

## 🤝 Contributing

Contributions are welcome! Please read our [Contributing Guidelines](CONTRIBUTING.md) before submitting a PR.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 💖 Support This Project

If GrantFinder AI helps your parish or school find funding, consider supporting continued development:

**[patreon.com/christreadaway](https://patreon.com/christreadaway)**

Your support helps keep this project free and open source for Catholic communities everywhere.

---

## 📜 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- Built for Catholic parishes and schools seeking grant funding
- Powered by [Claude](https://anthropic.com) from Anthropic
- Inspired by the challenge of matching limited time to unlimited grant opportunities

---

## 📬 Contact

Questions? Issues? Feature requests?

- Open an [issue](https://github.com/christreadaway/grantfinder/issues)
- Or reach out via [Patreon](https://patreon.com/christreadaway)

---

**Made with ❤️ for Catholic communities**
