/**
 * Team access / Staff & custom roles — backend.
 *
 * Self-contained: lets the merchant define custom roles (named permission sets)
 * and invite staff into them, with a public invite-accept page. State lives in
 * its own Postgres schema (team_access). Uses only merchant_profile:read — it
 * manages the app's own access data, not core. (A real deployment would gate the
 * dashboard's own surfaces on these permissions; here it owns the directory.)
 *
 *   GET  /api/overview            KPIs (staff, active, roles, pending) + recent
 *   GET  /api/permissions         the permission catalogue
 *   GET/POST /api/roles           list / create / update roles (name + permissions)
 *   POST /api/roles/:id/delete    remove a role (staff fall back to no role)
 *   GET  /api/staff               roster
 *   POST /api/staff               invite a staff member → invite link
 *   POST /api/staff/:id/role      reassign role
 *   POST /api/staff/:id/status    enable / disable
 *   GET  /invite/:token           public invite-accept page (no session)
 *   POST /invite/:token           accept (set name → active)
 */
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { mountAppCore } from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const BASE = process.env.PUBLIC_BASE_URL || "";

for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) {
    console.error(`[team-access] Missing env: ${k}`);
    process.exit(1);
  }
}

// Fixed permission catalogue the merchant composes roles from.
const PERMISSIONS = [
  { key: "view_orders", label: "View orders" },
  { key: "manage_orders", label: "Manage orders" },
  { key: "issue_refunds", label: "Issue refunds" },
  { key: "view_customers", label: "View customers" },
  { key: "manage_products", label: "Manage products" },
  { key: "view_reports", label: "View reports" },
  { key: "manage_payouts", label: "Manage payouts" },
  { key: "manage_staff", label: "Manage staff" },
  { key: "manage_settings", label: "Manage settings" },
];
const PERM_KEYS = new Set(PERMISSIONS.map((p) => p.key));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS roles (
  id          bigserial PRIMARY KEY,
  merchant_id bigint NOT NULL,
  name        text NOT NULL,
  permissions jsonb NOT NULL DEFAULT '[]',
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS staff (
  id           bigserial PRIMARY KEY,
  merchant_id  bigint NOT NULL,
  name         text NOT NULL,
  email        text,
  role_id      bigint,
  status       text NOT NULL DEFAULT 'invited',
  invite_token text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  accepted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS roles_merchant_idx ON roles (merchant_id);
CREATE INDEX IF NOT EXISTS staff_merchant_idx ON staff (merchant_id, status);
CREATE TABLE IF NOT EXISTS merchant_meta (
  merchant_id bigint PRIMARY KEY,
  name        text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
`;

const app = express();
const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE,
  frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
});
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
const db = await openPg("team_access", SCHEMA);

// One-time: earlier builds allowed duplicate role names (you'd see two
// identical "Shift Lead" roles and couldn't tell them apart). Suffix the
// duplicates so every name is distinct; uniqueness is enforced going forward.
async function runMigrations() {
  await db.run(`CREATE TABLE IF NOT EXISTS _migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  if (await db.one(`SELECT 1 FROM _migrations WHERE id='dedupe_role_names_v1'`)) return;
  await db.run(`
    UPDATE roles r SET name = r.name || ' ' || sub.rn
      FROM (SELECT id, row_number() OVER (PARTITION BY merchant_id, lower(name) ORDER BY created_at, id) AS rn
              FROM roles) sub
     WHERE r.id = sub.id AND sub.rn > 1`);
  await db.run(`INSERT INTO _migrations (id) VALUES ('dedupe_role_names_v1') ON CONFLICT DO NOTHING`);
}
await runMigrations();

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
const token = () => crypto.randomBytes(9).toString("base64url");
const cleanPerms = (v) => (Array.isArray(v) ? [...new Set(v.filter((k) => PERM_KEYS.has(k)))] : []);

// Seed three sensible default roles the first time a merchant opens the app.
async function ensureSeed(mid) {
  const { count } = await db.one("SELECT count(*)::int AS count FROM roles WHERE merchant_id=$1", [mid]);
  if (count > 0) return;
  const all = PERMISSIONS.map((p) => p.key);
  const manager = ["view_orders", "manage_orders", "issue_refunds", "view_customers", "view_reports"];
  const cashier = ["view_orders", "manage_orders", "view_customers"];
  await db.run("INSERT INTO roles (merchant_id, name, permissions, is_system) VALUES ($1,'Owner',$2,true),($1,'Manager',$3,false),($1,'Cashier',$4,false)", [
    mid, JSON.stringify(all), JSON.stringify(manager), JSON.stringify(cashier),
  ]);
}

app.get("/api/overview", core.requireSession, async (req, res) => {
  try {
    const mid = req.session.merchantId;
    await db.run("INSERT INTO merchant_meta (merchant_id, name) VALUES ($1,$2) ON CONFLICT (merchant_id) DO UPDATE SET name=$2, updated_at=now()", [mid, req.session.merchant?.name || null]).catch(() => {});
    await ensureSeed(mid);
    const stats = await db.one(
      `SELECT
         (SELECT count(*) FROM staff WHERE merchant_id=$1) AS staff,
         (SELECT count(*) FROM staff WHERE merchant_id=$1 AND status='active') AS active,
         (SELECT count(*) FROM staff WHERE merchant_id=$1 AND status='invited') AS pending,
         (SELECT count(*) FROM roles WHERE merchant_id=$1) AS roles`,
      [mid],
    );
    const recent = await db.q(
      `SELECT s.id, s.name, s.email, s.status, s.created_at, r.name AS role
         FROM staff s LEFT JOIN roles r ON r.id=s.role_id
        WHERE s.merchant_id=$1 ORDER BY s.created_at DESC LIMIT 12`,
      [mid],
    );
    res.json({ stats, recent, business: req.session.merchant?.name || "Your business" });
  } catch (err) {
    res.status(500).json({ error: "overview_failed", message: err?.message });
  }
});

app.get("/api/permissions", core.requireSession, (req, res) => res.json({ permissions: PERMISSIONS }));

app.get("/api/roles", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  await ensureSeed(mid);
  const rows = await db.q(
    `SELECT r.*, (SELECT count(*)::int FROM staff WHERE role_id=r.id) AS members
       FROM roles r WHERE r.merchant_id=$1 ORDER BY r.is_system DESC, r.created_at`,
    [mid],
  );
  res.json({ roles: rows });
});

app.post("/api/roles", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  const b = req.body || {};
  const name = String(b.name || "Role").slice(0, 60);
  const perms = JSON.stringify(cleanPerms(b.permissions));
  const dup = await db.one("SELECT id FROM roles WHERE merchant_id=$1 AND lower(name)=lower($2) AND id<>$3", [mid, name, int(b.id, 0)]);
  if (dup) return res.status(422).json({ error: "A role with that name already exists." });
  if (b.id) {
    await db.run("UPDATE roles SET name=$2, permissions=$3 WHERE id=$1 AND merchant_id=$4 AND is_system=false", [int(b.id, 0), name, perms, mid]);
  } else {
    await db.run("INSERT INTO roles (merchant_id, name, permissions) VALUES ($1,$2,$3)", [mid, name, perms]);
  }
  res.json({ roles: await db.q("SELECT r.*, (SELECT count(*)::int FROM staff WHERE role_id=r.id) AS members FROM roles r WHERE r.merchant_id=$1 ORDER BY r.is_system DESC, r.created_at", [mid]) });
});

app.post("/api/roles/:id/delete", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  const id = int(req.params.id, 0);
  const r = await db.one("DELETE FROM roles WHERE id=$1 AND merchant_id=$2 AND is_system=false RETURNING id", [id, mid]);
  if (!r) return res.status(409).json({ error: "cannot_delete" });
  await db.run("UPDATE staff SET role_id=NULL WHERE role_id=$1 AND merchant_id=$2", [id, mid]);
  res.json({ ok: true });
});

app.get("/api/staff", core.requireSession, async (req, res) => {
  const rows = await db.q(
    `SELECT s.id, s.name, s.email, s.status, s.role_id, s.invite_token, s.created_at, s.accepted_at, r.name AS role
       FROM staff s LEFT JOIN roles r ON r.id=s.role_id
      WHERE s.merchant_id=$1 ORDER BY s.created_at DESC LIMIT 300`,
    [req.session.merchantId],
  );
  res.json({ staff: rows.map((s) => ({ ...s, invite_url: s.status === "invited" ? `${BASE}/invite/${s.invite_token}` : null })) });
});

app.post("/api/staff", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  const b = req.body || {};
  if (!b.name && !b.email) return res.status(400).json({ error: "name_or_email_required" });
  const role = b.role_id ? await db.one("SELECT id FROM roles WHERE id=$1 AND merchant_id=$2", [int(b.role_id, 0), mid]) : null;
  const row = await db.one(
    "INSERT INTO staff (merchant_id, name, email, role_id, invite_token) VALUES ($1,$2,$3,$4,$5) RETURNING *",
    [mid, String(b.name || b.email).slice(0, 120), b.email ? String(b.email).slice(0, 160) : null, role?.id || null, token()],
  );
  res.json({ staff: { ...row, invite_url: `${BASE}/invite/${row.invite_token}` } });
});

app.post("/api/staff/:id/role", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  const id = int(req.params.id, 0);
  const roleId = req.body?.role_id ? int(req.body.role_id, 0) : null;
  if (roleId) {
    const role = await db.one("SELECT id FROM roles WHERE id=$1 AND merchant_id=$2", [roleId, mid]);
    if (!role) return res.status(404).json({ error: "role_not_found" });
  }
  await db.run("UPDATE staff SET role_id=$2 WHERE id=$1 AND merchant_id=$3", [id, roleId, mid]);
  res.json({ ok: true });
});

app.post("/api/staff/:id/status", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  const id = int(req.params.id, 0);
  const status = ["active", "disabled"].includes(req.body?.status) ? req.body.status : "disabled";
  await db.run("UPDATE staff SET status=$2 WHERE id=$1 AND merchant_id=$3 AND status<>'invited'", [id, status, mid]);
  res.json({ ok: true });
});

// ---- public invite-accept page (no session) -----------------------------
function page(body) {
  return `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1">
  <title>Join the team</title><style>
  body{font:16px/1.5 system-ui,sans-serif;background:#eef8f6;margin:0;color:#14302b;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{background:#fff;border:1px solid #d4ece6;border-radius:18px;padding:30px;max-width:430px;width:92%;box-shadow:0 8px 30px rgba(15,60,50,.07)}
  h1{font-size:21px;margin:0 0 4px}.muted{color:#6a857d;font-size:14px;margin:0 0 16px}
  .role{display:inline-block;background:#e7f6f1;color:#0f766e;font-weight:600;padding:5px 12px;border-radius:999px;font-size:13px;margin-bottom:14px}
  label{display:block;font-size:13px;font-weight:600;margin:10px 0 4px}
  input{width:100%;box-sizing:border-box;border:1px solid #d8ebe6;border-radius:11px;padding:11px;font:inherit}
  button{margin-top:16px;width:100%;background:#0d9488;color:#fff;border:0;border-radius:11px;padding:13px;font:600 16px system-ui;cursor:pointer}
  </style></head><body><div class=card>${body}</div></body></html>`;
}

app.get("/invite/:token", async (req, res) => {
  const s = await db.one(
    "SELECT s.*, r.name AS role, mm.name AS business FROM staff s LEFT JOIN roles r ON r.id=s.role_id LEFT JOIN merchant_meta mm ON mm.merchant_id=s.merchant_id WHERE s.invite_token=$1",
    [req.params.token],
  );
  if (!s) return res.status(404).send(page("<h1>Invite not found</h1><p class=muted>This invite link is invalid.</p>"));
  if (s.status !== "invited") return res.send(page("<h1>Already accepted</h1><p class=muted>This invite has already been used.</p>"));
  const invited = s.business
    ? `<strong>${esc(s.business)}</strong> has invited you to join their team${s.role ? ` as <strong>${esc(s.role)}</strong>` : ""}.`
    : `You've been invited to join the team${s.role ? ` as <strong>${esc(s.role)}</strong>` : ""}.`;
  res.send(page(`
    <h1>You're invited 👋</h1>
    <p class=muted>${invited}</p>
    ${s.role ? `<div class=role>${esc(s.role)}</div>` : ""}
    <form method=post action="/invite/${esc(req.params.token)}">
      <label>Your name</label>
      <input name=name required value="${esc(s.name || "")}" placeholder="Full name">
      <button type=submit>Accept invite</button>
    </form>`));
});

app.post("/invite/:token", async (req, res) => {
  const s = await db.one("SELECT * FROM staff WHERE invite_token=$1", [req.params.token]);
  if (!s) return res.status(404).send(page("<h1>Invite not found</h1>"));
  if (s.status !== "invited") return res.send(page("<h1>Already accepted</h1>"));
  const name = String(req.body?.name || "").slice(0, 120).trim() || s.name || "Team member";
  await db.run("UPDATE staff SET name=$2, status='active', accepted_at=now() WHERE id=$1", [s.id, name]);
  const mm = await db.one("SELECT name FROM merchant_meta WHERE merchant_id=$1", [s.merchant_id]);
  const biz = mm?.name ? esc(mm.name) : "the team";
  res.send(page(`<h1>Welcome aboard, ${esc(name)}! 🎉</h1><p class=muted>You're now listed on ${biz}'s team roster. Any system logins (such as your own Inkress dashboard account) are set up separately by your manager — this just confirms your place on the team.</p>`));
});

app.listen(PORT, HOST, () => console.log(`[team-access] listening on ${HOST}:${PORT}`));
