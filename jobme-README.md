# JobMe 🎯

AI-powered job search and resume tailoring for international students on F1 OPT/visa.

**$1 per tailored resume · Job search always free · Daily email briefings**

---

## What it does

- Users sign up, build their profile (visa type, skills, experience, target roles)
- Daily AI agent searches Wellfound, LinkedIn, Greenhouse for real open roles matching their profile
- Each role shows why they fit, salary, OPT-friendly badge
- One click generates an AI-tailored .docx resume for that specific job — costs 1 credit ($1)
- Morning email briefing delivered at 9 AM with best matches

---

## Deploy in 15 minutes

### 1. Create a new GitHub repo and push these files
```bash
git init
git add .
git commit -m "JobMe initial"
git remote add origin https://github.com/YOUR_USERNAME/jobme.git
git push -u origin main
```

### 2. Deploy to Railway
1. railway.app → New Project → Deploy from GitHub
2. Select your `jobme` repo
3. Railway auto-detects Node.js

### 3. Set environment variables in Railway → Variables
```
ANTHROPIC_API_KEY      → console.anthropic.com
RESEND_API_KEY         → resend.com (free)
FROM_EMAIL             → onboarding@resend.dev (or your domain)
STRIPE_SECRET_KEY      → dashboard.stripe.com → Developers → API keys
STRIPE_WEBHOOK_SECRET  → (after setting up webhook — see below)
APP_URL                → https://your-railway-url.railway.app
```

### 4. Set up Stripe webhook
1. dashboard.stripe.com → Developers → Webhooks → Add endpoint
2. Endpoint URL: `https://your-railway-url.railway.app/api/webhook`
3. Events: `checkout.session.completed`
4. Copy the signing secret → paste as `STRIPE_WEBHOOK_SECRET`

### 5. Update the frontend
In `jobme.html`, find this line near the bottom:
```js
const API = "https://YOUR_RAILWAY_APP.railway.app";
```
Replace with your actual Railway URL.

### 6. Host the frontend
Upload `jobme.html` to:
- **Netlify**: drag & drop at app.netlify.com → free
- **Vercel**: `npx vercel` → free
- **GitHub Pages**: push to a repo, enable Pages

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | For AI job search + resume tailoring |
| `RESEND_API_KEY` | ✅ | For daily email delivery |
| `FROM_EMAIL` | ✅ | Sender email address |
| `STRIPE_SECRET_KEY` | ✅ | For $1/resume payments |
| `STRIPE_WEBHOOK_SECRET` | ✅ | To verify Stripe webhook events |
| `APP_URL` | ✅ | Your deployed frontend URL |
| `DB_PATH` | ❌ | SQLite path (default: ./jobme.db) |
| `PORT` | ❌ | Server port (Railway sets this automatically) |

---

## Cost estimate (per 100 users)
- Railway: ~$5–10/month
- Resend: free (3K emails/month) → $20/month for more
- Anthropic API: ~$0.10 per job search + $0.05 per resume = ~$0.15 per active user/day
- **Revenue at 10 resumes/user/month**: $1,000

---

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /api/signup | — | Create account |
| POST | /api/login | — | Log in |
| GET | /api/me | ✅ | Get user + profile |
| POST | /api/profile | ✅ | Save/update profile |
| POST | /api/jobs | ✅ | Run job search |
| POST | /api/resume | ✅ | Generate tailored resume (costs 1 credit) |
| POST | /api/buy-credits | ✅ | Create Stripe checkout |
| POST | /api/webhook | — | Stripe webhook |
| GET | /api/stats | ✅ | Admin stats |
| GET | /health | — | Health check |
