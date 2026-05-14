// setup-admin.js
// Run once after deploy: node setup-admin.js
// This creates your personal account with free access to everything

const bcrypt   = require("bcryptjs");
const Database = require("better-sqlite3");
const crypto   = require("crypto");

const DB_PATH = process.env.DB_PATH || "./jobme.db";
const db      = new Database(DB_PATH);

// ── Your details ───────────────────────────────────────────────────────────
const ADMIN = {
  email:    "joshpraneeth.ambati@gmail.com",
  password: "Praneeth@1",   // ← change this
  name:     "Josh Ambati",
  credits:  9999,   // effectively unlimited
};

// ── Make sure tables exist ─────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
    name TEXT NOT NULL, credits INTEGER DEFAULT 0,
    email_sub INTEGER DEFAULT 0, email_sub_id TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS profiles (
    user_id TEXT PRIMARY KEY, location TEXT, visa_type TEXT DEFAULT 'F1 OPT',
    target_roles TEXT, skills TEXT, experience TEXT,
    salary_min INTEGER DEFAULT 100000, salary_max INTEGER DEFAULT 140000,
    remote_pref TEXT DEFAULT 'hybrid', updated_at INTEGER DEFAULT (unixepoch())
  );
`);

async function run() {
  // Check if already exists
  const existing = db.prepare("SELECT id FROM users WHERE email=?").get(ADMIN.email.toLowerCase());

  if (existing) {
    // Update credits and email_sub
    db.prepare("UPDATE users SET credits=?, email_sub=1, email_sub_id='admin-free' WHERE email=?")
      .run(ADMIN.credits, ADMIN.email.toLowerCase());
    console.log(`✅ Updated existing account: ${ADMIN.email}`);
    console.log(`   Credits: ${ADMIN.credits} | Email sub: ON (free)`);
    return;
  }

  // Create new
  const hash = await bcrypt.hash(ADMIN.password, 10);
  const id   = crypto.randomBytes(16).toString("hex");

  db.prepare("INSERT INTO users (id,email,password,name,credits,email_sub,email_sub_id) VALUES (?,?,?,?,?,1,'admin-free')")
    .run(id, ADMIN.email.toLowerCase(), hash, ADMIN.name, ADMIN.credits);

  // Pre-fill your profile
  db.prepare(`INSERT INTO profiles (user_id,location,visa_type,target_roles,skills,salary_min,salary_max,remote_pref,experience)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(
      id,
      "Chicago, IL",
      "F1 OPT",
      JSON.stringify(["AI Engineer","Full-Stack AI Engineer","Backend Engineer","Founding Engineer"]),
      "Python, TypeScript, JavaScript, Java, React, Node.js, Spring Boot, AWS, Docker, Kubernetes, LLaMA 3, Gemini, GPT-4o-mini, Multi-model Routing, MAG, Claude Agent SDK, MongoDB, Postgres, Redis",
      100000,
      140000,
      "hybrid",
      JSON.stringify([
        {
          company: "Peterson Technology Partners",
          location: "Chicago, IL",
          role: "Full Stack AI Engineer (AI Systems)",
          dates: "Sep 2025 – Present",
          bullets: [
            "Designed and deployed a production-scale AI interview automation system using Gemini 3.0 Flash + Mixtral, processing 3K+ interviews in 1 week at 40% lower per-interview cost.",
            "Built multi-tenant client portal (React, TypeScript, AWS Cognito, SSE) onboarding 12+ tenants, cutting setup time 50%.",
            "Engineered multi-model inference routing reducing latency 35% and compute costs 25%.",
            "Integrated voice AI for automated first-round screening, eliminating 80% of manual recruiter time across 500+ weekly applicants.",
            "Built end-to-end agentic ATS workflow automating candidate evaluation, scoring, and decisions."
          ]
        },
        {
          company: "CDK Global",
          location: "Hyderabad, India",
          role: "Associate Software Engineer",
          dates: "Aug 2021 – Aug 2023",
          bullets: [
            "Modernized 3 legacy systems into microservices (Java, Spring Boot): 75% scalability improvement, 30% less downtime.",
            "Implemented IAM with Kubernetes, OAuth2, SAML for 2,000+ internal users.",
            "Resolved critical production issues via NewRelic within 24 hours.",
            "Improved inter-service communication efficiency 15% across multi-region AWS."
          ]
        }
      ])
    );

  console.log(`✅ Admin account created!`);
  console.log(`   Email:   ${ADMIN.email}`);
  console.log(`   Credits: ${ADMIN.credits} (free)`);
  console.log(`   Email sub: ON (free, no Stripe needed)`);
  console.log(`   Profile: pre-filled with your background`);
  console.log(`\n👉 Log in at your JobMe URL with these credentials.`);
}

run().catch(console.error);
