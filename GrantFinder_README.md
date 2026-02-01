# GrantFinder AI

**Match your parish or school to the right grants — and eventually apply automatically.**

GrantFinder AI scans your website, reads your bulletins and meeting minutes, asks smart questions based on actual grant requirements, and recommends which grants are the best fit. Future versions will draft and submit applications with human approval.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Status](https://img.shields.io/badge/status-in%20development-yellow.svg)

---

## 🎯 What It Does

1. **Scan your website** — AI crawls your church/school site to learn about your organization
2. **Upload your grant database** — Excel file with grant opportunities
3. **Upload parish documents** — Bulletins, meeting minutes, newsletters, strategic plans
4. **Answer a smart questionnaire** — AI generates questions based on what grants actually require
5. **Review your profile** — AI shows what it learned about your parish for you to verify
6. **Get matched** — Ranked recommendations with explanations of why each grant fits

### Terminal-Style Processing

Watch the AI work in real-time with a terminal interface:

```
[14:32:03] Scanning https://sttheresa.org/about...
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
| **v2.0** | AI drafts grant applications for human review |
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

- Python 3.10+
- Node.js 18+
- Claude API key from [Anthropic](https://console.anthropic.com/)
- Google Cloud project with OAuth configured

### Local Development

```bash
# Clone the repo
git clone https://github.com/[your-username]/grantfinder-ai.git
cd grantfinder-ai

# Backend setup
cd backend
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your credentials
uvicorn main:app --reload

# Frontend setup (new terminal)
cd frontend
npm install
cp .env.example .env.local
# Edit .env.local with your credentials
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### Setup in the App

1. **Sign in with Google**
2. **Enter your Claude API key** — [Get one from Anthropic](https://console.anthropic.com/)
3. **Add your website URLs** — Church site and/or school site
4. **Upload your grant database** — Excel file with opportunities
5. **Start matching!**

### Deploy to Cloud

**Frontend (Vercel):**
```bash
cd frontend
vercel
```

**Backend (Railway):**
```bash
cd backend
railway up
```

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

[Download sample template](./docs/sample-grants-template.xlsx)

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

**Formats:** PDF, DOCX, TXT

---

## 🎨 Interface

- **Dark mode by default** (light mode available)
- **Terminal-style processing view** — watch the AI work in real-time
- **Mobile responsive** — works on phone, tablet, desktop

---

## 🔐 Privacy & Security

- **Google OAuth only** — We never store passwords
- **Your API key** — Stored encrypted, used only for your requests
- **Your documents** — Processed to extract grant-relevant info only
- **No sharing** — Your data is never shared or used to train models

---

## 🛠 Tech Stack

| Component | Technology |
|-----------|------------|
| Frontend | Next.js |
| Backend | FastAPI (Python) |
| Database | PostgreSQL (Supabase) |
| Auth | Google OAuth |
| AI | Claude API (Anthropic) |
| File Storage | Supabase Storage |

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

- Open an [issue](https://github.com/[your-username]/grantfinder-ai/issues)
- Or reach out via [Patreon](https://patreon.com/christreadaway)

---

**Made with ❤️ for Catholic communities**
