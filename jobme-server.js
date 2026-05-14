const Anthropic  = require("@anthropic-ai/sdk");
const { Resend } = require("resend");
const cron       = require("node-cron");
const http       = require("http");
const crypto     = require("crypto");
const bcrypt     = require("bcryptjs");
const Stripe     = require("stripe");
const Database   = require("better-sqlite3");

// ── Env ────────────────────────────────────────────────────────────────────
const {
  ANTHROPIC_API_KEY, RESEND_API_KEY, FROM_EMAIL,
  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
  APP_URL = "http://localhost:3000",
  PORT    = 3000,
  DB_PATH = "./jobme.db"
} = process.env;

const REQUIRED = ["ANTHROPIC_API_KEY","RESEND_API_KEY","FROM_EMAIL","STRIPE_SECRET_KEY"];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) { console.error("❌ Missing:", missing.join(", ")); process.exit(1); }

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const resend    = new Resend(RESEND_API_KEY);
const stripe    = new Stripe(STRIPE_SECRET_KEY);

// ── DB ─────────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id               TEXT PRIMARY KEY,
    email            TEXT UNIQUE NOT NULL,
    password         TEXT NOT NULL,
    name             TEXT NOT NULL,
    credits          INTEGER DEFAULT 0,
    email_sub        INTEGER DEFAULT 0,
    email_sub_id     TEXT,
    created_at       INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS profiles (
    user_id       TEXT PRIMARY KEY REFERENCES users(id),
    location      TEXT,
    visa_type     TEXT DEFAULT 'F1 OPT',
    target_roles  TEXT,
    skills        TEXT,
    experience    TEXT,
    salary_min    INTEGER DEFAULT 100000,
    salary_max    INTEGER DEFAULT 140000,
    remote_pref   TEXT DEFAULT 'hybrid',
    updated_at    INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT REFERENCES users(id),
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS resumes (
    id         TEXT PRIMARY KEY,
    user_id    TEXT REFERENCES users(id),
    job_title  TEXT,
    company    TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS payments (
    id         TEXT PRIMARY KEY,
    user_id    TEXT REFERENCES users(id),
    stripe_id  TEXT,
    type       TEXT,
    credits    INTEGER DEFAULT 0,
    amount     INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  );
`);

// ── Helpers ────────────────────────────────────────────────────────────────
const cors = res => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
};
const send    = (res, status, data) => { res.writeHead(status, {"Content-Type":"application/json"}); res.end(JSON.stringify(data)); };
const readBody = req => new Promise(r => { let b=""; req.on("data",c=>b+=c); req.on("end",()=>{ try{r(JSON.parse(b||"{}"))}catch{r({})} }); });
const readRaw  = req => new Promise(r => { const c=[]; req.on("data",d=>c.push(d)); req.on("end",()=>r(Buffer.concat(c))); });
const uid      = ()  => crypto.randomBytes(16).toString("hex");
const now      = ()  => Math.floor(Date.now()/1000);

// ── Sessions ───────────────────────────────────────────────────────────────
function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)").run(token, userId, now()+60*60*24*30);
  return token;
}
function getUser(req) {
  const token = (req.headers.authorization||"").replace("Bearer ","").trim();
  if (!token) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE token=? AND expires_at>?").get(token, now());
  if (!s) return null;
  return db.prepare("SELECT * FROM users WHERE id=?").get(s.user_id);
}

// ── AI: jobs ───────────────────────────────────────────────────────────────
async function searchJobs(profile, filters=[]) {
  const roles  = JSON.parse(profile.target_roles||'["AI Engineer","Full-Stack Engineer","Backend Engineer"]');
  const remote = filters.includes("remote");
  const startup= filters.includes("startup");

  const prompt = `You are a senior tech recruiter. Today is ${new Date().toDateString()}.
Find 6 real open job postings for:
Name: ${profile.name} | Location: ${profile.location||"Chicago, IL"} | Visa: ${profile.visa_type||"F1 OPT"} — needs OPT hire + H1B sponsor
Roles: ${roles.join(", ")} | Skills: ${profile.skills||"Python, TypeScript, React, Node.js, AWS"}
Salary: $${Math.floor((profile.salary_min||100000)/1000)}K–$${Math.floor((profile.salary_max||140000)/1000)}K
${startup?"Startups/scale-ups (Series A–C) only. ":""}${remote?"Remote roles only. ":""}
Prioritize companies with H1B history. Avoid Fortune 500. Search Wellfound, LinkedIn, Greenhouse, Lever.
Return ONLY a JSON array, no markdown:
[{"title":"","company":"","location":"","salary":"","remote":true,"opt_friendly":true,"hot":false,"description":"2 sentences.","why_fit":"2 sentences.","apply_url":"https://...","source":""}]`;

  const res = await anthropic.messages.create({
    model:"claude-sonnet-4-20250514", max_tokens:4000,
    tools:[{type:"web_search_20250305",name:"web_search"}],
    messages:[{role:"user",content:prompt}]
  });
  const text  = res.content.filter(b=>b.type==="text").map(b=>b.text).join("");
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("Could not parse jobs");
  return JSON.parse(match[0]);
}

// ── AI: resume ─────────────────────────────────────────────────────────────
async function tailorResume(profile, job) {
  const exp = JSON.parse(profile.experience||"[]");
  const prompt = `Tailor this resume for the job. Return ONLY JSON, no markdown.
JOB: ${job.title} at ${job.company}. ${job.description}
CANDIDATE: ${profile.name} | ${profile.location} | ${profile.visa_type}
Skills: ${profile.skills}
Experience: ${JSON.stringify(exp)}
Rules: rewrite summary (3 sentences) for this role; reorder skills by relevance; reframe bullets; keep ALL real metrics; 1 page.
Return: {"summary":"...","skills":[{"label":"...","value":"..."}],"experience":[{"company":"...","location":"...","role":"...","dates":"...","bullets":["..."]}],"projects":[{"name":"...","url":"...","bullets":["..."]}],"education":[{"school":"...","location":"...","degree":"...","dates":"..."}]}`;

  const res = await anthropic.messages.create({
    model:"claude-sonnet-4-20250514", max_tokens:3000,
    messages:[{role:"user",content:prompt}]
  });
  const text  = res.content.filter(b=>b.type==="text").map(b=>b.text).join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Could not parse resume");
  return JSON.parse(match[0]);
}

// ── Email ──────────────────────────────────────────────────────────────────
function buildEmail(name, jobs) {
  const dateStr = new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});
  const cards = jobs.map(j=>`
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:20px;margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
        <div><div style="font-size:16px;font-weight:700;color:#111;">${j.title}</div>
          <div style="font-size:13px;color:#059669;margin-top:2px;">${j.company}${j.location?" · "+j.location:""}</div></div>
        ${j.salary?`<div style="background:#e8ff47;color:#111;padding:3px 10px;border-radius:5px;font-size:13px;font-weight:700;">${j.salary}</div>`:""}
      </div>
      <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;">
        ${j.opt_friendly?`<span style="background:#edfaf0;color:#1a6b3c;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">✓ OPT Friendly</span>`:""}
        ${j.hot?`<span style="background:#fff4f2;color:#ff3d2e;padding:2px 8px;border-radius:4px;font-size:11px;">🔥 Hot</span>`:""}
        ${j.remote?`<span style="background:#eef0ff;color:#1a3aff;padding:2px 8px;border-radius:4px;font-size:11px;">Remote</span>`:""}
      </div>
      <p style="font-size:13px;color:#555;line-height:1.6;margin:0 0 10px;">${j.description}</p>
      <div style="background:#f9f9f7;border-left:3px solid #e8ff47;padding:10px 14px;border-radius:0 6px 6px 0;margin-bottom:12px;">
        <div style="font-size:10px;font-weight:700;color:#999;text-transform:uppercase;margin-bottom:3px;">Why you fit</div>
        <div style="font-size:13px;color:#111;line-height:1.6;">${j.why_fit}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${j.apply_url?`<a href="${j.apply_url}" style="display:inline-block;background:#111014;color:#e8ff47;padding:8px 16px;border-radius:6px;font-size:12px;font-weight:700;text-decoration:none;">Apply →</a>`:""}
        <a href="${APP_URL}" style="display:inline-block;background:#f3f4f6;color:#374151;padding:8px 16px;border-radius:6px;font-size:12px;font-weight:600;text-decoration:none;">Generate Resume ($1) →</a>
      </div>
    </div>`).join("");

  return `<!DOCTYPE html><html><body style="margin:0;background:#f7f4ee;font-family:'Helvetica Neue',sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:32px 16px 60px;">
    <div style="background:#111014;border-radius:12px;padding:28px;margin-bottom:24px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:0.15em;color:#e8ff47;text-transform:uppercase;margin-bottom:6px;">// JobMe daily briefing</div>
      <div style="font-size:24px;font-weight:700;color:#fff;margin-bottom:4px;">Good morning, ${name} 👋</div>
      <div style="font-size:13px;color:#9ca3af;">${dateStr}</div>
    </div>
    <div style="display:flex;gap:12px;margin-bottom:24px;">
      <div style="flex:1;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;text-align:center;">
        <div style="font-size:26px;font-weight:800;color:#111;">${jobs.length}</div><div style="font-size:10px;color:#9ca3af;text-transform:uppercase;margin-top:4px;">Roles</div></div>
      <div style="flex:1;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;text-align:center;">
        <div style="font-size:26px;font-weight:800;color:#111;">${jobs.filter(j=>j.opt_friendly).length}</div><div style="font-size:10px;color:#9ca3af;text-transform:uppercase;margin-top:4px;">OPT Friendly</div></div>
      <div style="flex:1;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;text-align:center;">
        <div style="font-size:26px;font-weight:800;color:#111;">${jobs.filter(j=>j.hot).length}</div><div style="font-size:10px;color:#9ca3af;text-transform:uppercase;margin-top:4px;">Hot 🔥</div></div>
    </div>
    ${cards}
    <div style="text-align:center;padding-top:20px;border-top:1px solid #e2ded6;margin-top:8px;">
      <a href="${APP_URL}" style="display:inline-block;background:#111014;color:#e8ff47;padding:12px 28px;border-radius:8px;font-size:13px;font-weight:700;text-decoration:none;margin-bottom:16px;">Open JobMe →</a>
      <div style="font-size:12px;color:#9ca3af;">JobMe · AI job search for international students</div>
    </div>
  </div></body></html>`;
}

// ── Cron: 9 AM Chicago ─────────────────────────────────────────────────────
function utcFor9AM() {
  const n = new Date();
  const chi = new Date(n.toLocaleString("en-US",{timeZone:"America/Chicago"}));
  const utc = new Date(n.toLocaleString("en-US",{timeZone:"UTC"}));
  return 9 + Math.round((utc-chi)/3600000);
}
const utcHour = utcFor9AM();
console.log(`[startup] ⏰ Cron UTC ${utcHour}:00 = 9AM Chicago`);

cron.schedule(`0 ${utcHour} * * 1-5`, async () => {
  // Only email users with active email subscription
  const users = db.prepare(`
    SELECT u.*, p.* FROM users u
    JOIN profiles p ON u.id=p.user_id
    WHERE u.email_sub=1
  `).all();
  console.log(`[cron] Sending to ${users.length} subscribers`);
  for (const u of users) {
    try {
      const jobs = await searchJobs(u);
      await resend.emails.send({
        from:FROM_EMAIL, to:u.email,
        subject:`🎯 ${jobs.length} new roles · ${jobs.filter(j=>j.opt_friendly).length} OPT-friendly`,
        html: buildEmail(u.name, jobs)
      });
      console.log(`[cron] ✅ ${u.email}`);
    } catch(e) { console.error(`[cron] ❌ ${u.email}:`, e.message); }
  }
});

// ── HTTP Server ────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  cors(res);
  if (req.method==="OPTIONS") { res.writeHead(204); res.end(); return; }
  const url = req.url.split("?")[0];

  // ── POST /api/signup ──
  if (req.method==="POST" && url==="/api/signup") {
    const {email,password,name} = await readBody(req);
    if (!email||!password||!name) return send(res,400,{ok:false,error:"All fields required"});
    if (password.length<8)        return send(res,400,{ok:false,error:"Password must be 8+ characters"});
    if (db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase())) return send(res,409,{ok:false,error:"Email already registered"});
    const hash=await bcrypt.hash(password,10), id=uid();
    db.prepare("INSERT INTO users (id,email,password,name) VALUES (?,?,?,?)").run(id,email.toLowerCase(),hash,name);
    return send(res,201,{ok:true,token:createSession(id),user:{id,email,name,credits:0,email_sub:0}});
  }

  // ── POST /api/login ──
  if (req.method==="POST" && url==="/api/login") {
    const {email,password} = await readBody(req);
    const u = db.prepare("SELECT * FROM users WHERE email=?").get((email||"").toLowerCase());
    if (!u||!await bcrypt.compare(password||"",u.password)) return send(res,401,{ok:false,error:"Invalid email or password"});
    return send(res,200,{ok:true,token:createSession(u.id),user:{id:u.id,email:u.email,name:u.name,credits:u.credits,email_sub:!!u.email_sub}});
  }

  // ── Auth guard ──
  const PUBLIC = ["/api/signup","/api/login","/api/webhook","/health"];
  const user   = getUser(req);
  if (url.startsWith("/api/") && !PUBLIC.includes(url) && !user) return send(res,401,{ok:false,error:"Unauthorized"});

  // ── GET /api/me ──
  if (req.method==="GET" && url==="/api/me") {
    const p = db.prepare("SELECT * FROM profiles WHERE user_id=?").get(user.id);
    return send(res,200,{ok:true,user:{id:user.id,email:user.email,name:user.name,credits:user.credits,email_sub:!!user.email_sub},profile:p||null});
  }

  // ── POST /api/profile ──
  if (req.method==="POST" && url==="/api/profile") {
    const b = await readBody(req);
    const d = {
      location:     b.location||"",
      visa_type:    b.visa_type||"F1 OPT",
      target_roles: JSON.stringify(b.target_roles||[]),
      skills:       b.skills||"",
      experience:   JSON.stringify(b.experience||[]),
      salary_min:   b.salary_min||100000,
      salary_max:   b.salary_max||140000,
      remote_pref:  b.remote_pref||"hybrid",
    };
    if (db.prepare("SELECT user_id FROM profiles WHERE user_id=?").get(user.id))
      db.prepare("UPDATE profiles SET location=?,visa_type=?,target_roles=?,skills=?,experience=?,salary_min=?,salary_max=?,remote_pref=?,updated_at=? WHERE user_id=?").run(...Object.values(d),now(),user.id);
    else
      db.prepare("INSERT INTO profiles (user_id,location,visa_type,target_roles,skills,experience,salary_min,salary_max,remote_pref) VALUES (?,?,?,?,?,?,?,?,?)").run(user.id,...Object.values(d));
    return send(res,200,{ok:true});
  }

  // ── POST /api/jobs (FREE) ──
  if (req.method==="POST" && url==="/api/jobs") {
    const p = db.prepare("SELECT * FROM profiles WHERE user_id=?").get(user.id);
    if (!p) return send(res,400,{ok:false,error:"Complete your profile first"});
    try {
      const {filters} = await readBody(req);
      return send(res,200,{ok:true,jobs:await searchJobs({...user,...p},filters||[])});
    } catch(e) { return send(res,500,{ok:false,error:e.message}); }
  }

  // ── POST /api/resume ($1 credit) ──
  if (req.method==="POST" && url==="/api/resume") {
    if (user.credits<1) return send(res,402,{ok:false,error:"no_credits"});
    const p = db.prepare("SELECT * FROM profiles WHERE user_id=?").get(user.id);
    if (!p) return send(res,400,{ok:false,error:"Complete your profile first"});
    try {
      const {job} = await readBody(req);
      const resume = await tailorResume({...user,...p},job);
      db.prepare("UPDATE users SET credits=credits-1 WHERE id=?").run(user.id);
      db.prepare("INSERT INTO resumes (id,user_id,job_title,company) VALUES (?,?,?,?)").run(uid(),user.id,job.title,job.company);
      const updated = db.prepare("SELECT credits FROM users WHERE id=?").get(user.id);
      return send(res,200,{ok:true,resume,credits:updated.credits});
    } catch(e) { return send(res,500,{ok:false,error:e.message}); }
  }

  // ── POST /api/buy-credits (one-time Stripe checkout) ──
  if (req.method==="POST" && url==="/api/buy-credits") {
    const {quantity=10} = await readBody(req);
    const qty = Math.min(Math.max(parseInt(quantity)||10,1),100);
    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types:["card"],
        line_items:[{price_data:{currency:"usd",unit_amount:100,product_data:{name:"JobMe Resume Credits",description:"1 credit = 1 AI-tailored resume"}},quantity:qty}],
        mode:"payment",
        success_url:`${APP_URL}?payment=credits&qty=${qty}`,
        cancel_url: `${APP_URL}?payment=cancelled`,
        metadata:{user_id:user.id,type:"credits",credits:qty},
        customer_email:user.email,
      });
      return send(res,200,{ok:true,url:session.url});
    } catch(e) { return send(res,500,{ok:false,error:e.message}); }
  }

  // ── POST /api/subscribe-email ($5/month Stripe subscription) ──
  if (req.method==="POST" && url==="/api/subscribe-email") {
    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types:["card"],
        line_items:[{price_data:{currency:"usd",unit_amount:500,recurring:{interval:"month"},product_data:{name:"JobMe Daily Email Briefing",description:"6 AI-curated job matches every weekday morning"}},quantity:1}],
        mode:"subscription",
        success_url:`${APP_URL}?payment=email_sub`,
        cancel_url: `${APP_URL}?payment=cancelled`,
        metadata:{user_id:user.id,type:"email_sub"},
        customer_email:user.email,
      });
      return send(res,200,{ok:true,url:session.url});
    } catch(e) { return send(res,500,{ok:false,error:e.message}); }
  }

  // ── POST /api/cancel-email-sub ──
  if (req.method==="POST" && url==="/api/cancel-email-sub") {
    const subId = user.email_sub_id;
    if (subId) {
      try { await stripe.subscriptions.cancel(subId); } catch(e) { console.error("Cancel sub error:", e.message); }
    }
    db.prepare("UPDATE users SET email_sub=0, email_sub_id=NULL WHERE id=?").run(user.id);
    return send(res,200,{ok:true});
  }

  // ── POST /api/webhook ──
  if (req.method==="POST" && url==="/api/webhook") {
    const raw = await readRaw(req);
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = STRIPE_WEBHOOK_SECRET
        ? stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET)
        : JSON.parse(raw.toString());
    } catch(e) { return send(res,400,{error:"Webhook error"}); }

    if (event.type==="checkout.session.completed") {
      const s     = event.data.object;
      const uid2  = s.metadata?.user_id;
      const type  = s.metadata?.type;
      const credits = parseInt(s.metadata?.credits||0);
      if (uid2 && type==="credits" && credits>0) {
        db.prepare("UPDATE users SET credits=credits+? WHERE id=?").run(credits,uid2);
        db.prepare("INSERT INTO payments (id,user_id,stripe_id,type,credits,amount) VALUES (?,?,?,?,?,?)").run(uid(),uid2,s.id,"credits",credits,s.amount_total);
        console.log(`[payment] +${credits} credits → ${uid2}`);
      }
      if (uid2 && type==="email_sub") {
        db.prepare("UPDATE users SET email_sub=1, email_sub_id=? WHERE id=?").run(s.subscription, uid2);
        db.prepare("INSERT INTO payments (id,user_id,stripe_id,type,amount) VALUES (?,?,?,?,?)").run(uid(),uid2,s.id,"email_sub",500);
        console.log(`[payment] email_sub → ${uid2}`);
      }
    }

    if (event.type==="customer.subscription.deleted") {
      const subId = event.data.object.id;
      // Never cancel admin-free accounts
      db.prepare("UPDATE users SET email_sub=0, email_sub_id=NULL WHERE email_sub_id=? AND email_sub_id != 'admin-free'").run(subId);
      console.log(`[sub] Cancelled ${subId}`);
    }
    return send(res,200,{received:true});
  }

  // ── GET /api/stats ──
  if (req.method==="GET" && url==="/api/stats") {
    return send(res,200,{ok:true,stats:{
      users:   db.prepare("SELECT COUNT(*) as c FROM users").get().c,
      subs:    db.prepare("SELECT COUNT(*) as c FROM users WHERE email_sub=1").get().c,
      resumes: db.prepare("SELECT COUNT(*) as c FROM resumes").get().c,
      revenue: db.prepare("SELECT SUM(amount) as s FROM payments").get().s||0,
    }});
  }

  // ── Health ──
  if (url==="/health") return send(res,200,{status:"ok",users:db.prepare("SELECT COUNT(*) as c FROM users").get().c});

  res.writeHead(200,{"Content-Type":"text/plain"}); res.end("JobMe API ✅");

}).listen(PORT, ()=>console.log(`[startup] 🚀 JobMe on port ${PORT} | APP_URL: ${APP_URL}`));
