import "./index.css";
import {
  initBv,
  bvApi,
  type BvSession,
  mountShell,
  statRow,
  dataTable,
  card,
  emptyState,
  pill,
  openModal,
  flash,
  fmtDate,
  skeletonCard,
  h,
} from "./bv-init";

interface Stats {
  staff: number;
  active: number;
  pending: number;
  roles: number;
}
interface Permission {
  key: string;
  label: string;
}
interface Role {
  id: number;
  name: string;
  permissions: string[];
  is_system: boolean;
  members: number;
}
interface Staff {
  id: number;
  name: string;
  email: string | null;
  status: "invited" | "active" | "disabled";
  role_id: number | null;
  role: string | null;
  invite_url: string | null;
  created_at: string;
  accepted_at: string | null;
}

let session: BvSession;
let permsCache: Permission[] = [];
let rolesCache: Role[] = [];

const STATUS_TONE: Record<string, string> = { active: "ok", invited: "warning", disabled: "bad" };

boot();

async function boot() {
  try {
    session = await initBv();
  } catch (err) {
    renderFatal(err);
    return;
  }
  mountShell({
    brandIcon: "user",
    brandLogo: "/logo.svg",
    title: "Team Access",
    subtitle: `${session.merchant.name || "Your business"} · staff & roles`,
    poweredBy: "Marketplace",
    tabs: [
      { id: "overview", label: "Overview", icon: "user", render: renderOverview },
      { id: "staff", label: "Staff", icon: "users", render: renderStaff },
      { id: "roles", label: "Roles", icon: "settings", render: renderRoles },
    ],
  });
}

function renderFatal(err: unknown) {
  const root = document.getElementById("root")!;
  root.innerHTML = "";
  root.append(
    h(
      "div",
      { class: "bv-fatal" },
      h("strong", null, "Couldn't start"),
      h("p", { class: "bv-muted" }, (err as any)?.message || "No session token found."),
    ),
  );
}

async function loadPerms() {
  if (!permsCache.length) {
    const d = await bvApi<{ permissions: Permission[] }>("/api/permissions").catch(() => ({ permissions: [] as Permission[] }));
    permsCache = d.permissions;
  }
  return permsCache;
}
async function loadRoles() {
  const d = await bvApi<{ roles: Role[] }>("/api/roles").catch(() => ({ roles: [] as Role[] }));
  rolesCache = d.roles;
  return rolesCache;
}

async function renderOverview(host: HTMLElement) {
  host.innerHTML = "";
  host.append(skeletonCard());
  const data = await bvApi<{ stats: Stats; recent: Staff[] }>("/api/overview").catch(() => null);
  await loadRoles();
  host.innerHTML = "";
  if (!data) {
    host.append(emptyState({ icon: "alert", title: "Couldn't load", text: "Please try again." }));
    return;
  }
  const s = data.stats;
  host.append(
    statRow([
      { k: "Staff", v: String(s.staff), icon: "users" },
      { k: "Active", v: String(s.active), icon: "check", tone: "ok" },
      { k: "Pending invites", v: String(s.pending), icon: "user", tone: Number(s.pending) > 0 ? "accent" : undefined },
      { k: "Roles", v: String(s.roles), icon: "settings" },
    ]),
  );

  host.append(
    card({
      title: "Invite a teammate",
      action: h("button", { class: "primary", onClick: () => openInvite(host) }, "Invite staff"),
      body: h("p", { class: "bv-muted" }, "Define roles and build your staff roster, then share an invite link. This is your team directory — roles document who does what; they don't yet grant Inkress dashboard logins."),
    }),
  );

  host.append(
    card({
      title: "Recent staff",
      body: data.recent.length
        ? dataTable<Staff>({
            columns: [
              { head: "Name", cell: (r) => r.name },
              { head: "Role", cell: (r) => r.role || "—" },
              { head: "Status", cell: (r) => pill(r.status, STATUS_TONE[r.status] || "") },
              { head: "Added", cell: (r) => fmtDate(r.created_at) },
            ],
            rows: data.recent,
          })
        : emptyState({ icon: "users", title: "No staff yet", text: "Invite your first teammate to get started." }),
    }),
  );
}

async function renderStaff(host: HTMLElement) {
  host.innerHTML = "";
  await loadRoles();
  const list = h("div");
  const load = async () => {
    list.innerHTML = "";
    list.append(skeletonCard());
    const d = await bvApi<{ staff: Staff[] }>("/api/staff").catch(() => ({ staff: [] as Staff[] }));
    list.innerHTML = "";
    list.append(
      d.staff.length
        ? dataTable<Staff>({
            columns: [
              { head: "Name", cell: (r) => r.name },
              { head: "Email", cell: (r) => r.email || "—" },
              { head: "Role", cell: (r) => r.role || "—" },
              { head: "Status", cell: (r) => pill(r.status, STATUS_TONE[r.status] || "") },
            ],
            rows: d.staff,
            rowActions: (r) =>
              h(
                "div",
                { class: "bv-row" },
                r.invite_url ? h("button", { class: "ghost", onClick: () => copyLink(r.invite_url!) }, "Invite link") : null,
                h("button", { class: "ghost", onClick: () => openRoleChange(r, load) }, "Role"),
                r.status === "active" ? h("button", { class: "ghost", onClick: () => setStatus(r, "disabled", load) }, "Disable") : null,
                r.status === "disabled" ? h("button", { class: "ghost", onClick: () => setStatus(r, "active", load) }, "Enable") : null,
              ),
          })
        : emptyState({ icon: "users", title: "No staff yet", text: "Invite a teammate from the button above." }),
    );
  };
  host.append(card({ title: "Staff", action: h("button", { class: "primary", onClick: () => openInvite(host) }, "Invite staff"), body: list }));
  load();
}

function openInvite(host: HTMLElement) {
  const name = h("input", { type: "text", placeholder: "Full name" }) as HTMLInputElement;
  const email = h("input", { type: "email", placeholder: "email@example.com" }) as HTMLInputElement;
  const role = h("select", null, h("option", { value: "" }, "No role"), ...rolesCache.map((r) => h("option", { value: String(r.id) }, r.name))) as HTMLSelectElement;
  let close = () => {};
  const handle = openModal({
    title: "Invite staff",
    body: h("div", { class: "bv-stack" }, field("Name", name), field("Email", email), field("Role", role)),
    actions: [
      { label: "Cancel" },
      {
        label: "Create invite",
        primary: true,
        onClick: () => {
          if (!name.value.trim() && !email.value.trim()) {
            flash("Name or email required", "error");
            return true;
          }
          bvApi<{ staff: Staff }>("/api/staff", {
            method: "POST",
            body: JSON.stringify({ name: name.value.trim(), email: email.value.trim() || null, role_id: role.value || null }),
          })
            .then((r) => {
              close();
              showInvite(r.staff.invite_url || "");
              renderStaff(host);
            })
            .catch((e) => flash(e?.message || "Failed", "error"));
          return true;
        },
      },
    ],
  });
  close = handle.close;
}

function showInvite(link: string) {
  const input = h("input", { type: "text", value: link, readOnly: true }) as HTMLInputElement;
  openModal({
    title: "Invite link ready",
    body: h(
      "div",
      { class: "bv-stack" },
      h("p", { class: "bv-muted" }, "Send this link to your teammate. They'll set their name and their access goes live."),
      input,
    ),
    actions: [
      { label: "Done" },
      {
        label: "Copy link",
        primary: true,
        onClick: () => {
          input.select();
          navigator.clipboard?.writeText(link).then(() => flash("Copied", "success"), () => flash("Press ⌘/Ctrl+C", "info"));
          return true;
        },
      },
    ],
  });
}

function openRoleChange(s: Staff, reload: () => void) {
  const role = h("select", null, h("option", { value: "" }, "No role"), ...rolesCache.map((r) => h("option", { value: String(r.id) }, r.name))) as HTMLSelectElement;
  role.value = s.role_id ? String(s.role_id) : "";
  let close = () => {};
  const handle = openModal({
    title: `Role — ${s.name}`,
    body: h("div", { class: "bv-stack" }, field("Assigned role", role)),
    actions: [
      { label: "Cancel" },
      {
        label: "Save",
        primary: true,
        onClick: () => {
          bvApi(`/api/staff/${s.id}/role`, { method: "POST", body: JSON.stringify({ role_id: role.value || null }) })
            .then(() => {
              flash("Role updated", "success");
              close();
              reload();
            })
            .catch(() => flash("Failed", "error"));
          return true;
        },
      },
    ],
  });
  close = handle.close;
}

async function setStatus(s: Staff, status: string, reload: () => void) {
  const ok = await bvApi(`/api/staff/${s.id}/status`, { method: "POST", body: JSON.stringify({ status }) }).then(() => true).catch(() => false);
  flash(ok ? `${s.name} ${status === "active" ? "enabled" : "disabled"}` : "Failed", ok ? "success" : "error");
  if (ok) reload();
}

async function renderRoles(host: HTMLElement) {
  host.innerHTML = "";
  await loadPerms();
  const head = h(
    "div",
    { class: "bv-row", style: { justifyContent: "space-between", alignItems: "center", marginBottom: "12px" } },
    h("h2", { style: { margin: "0", fontSize: "1.05rem" } }, "Roles"),
    h("button", { class: "primary", onClick: () => openRole(host) }, "New role"),
  );
  const grid = h("div", { class: "bv-grid" });
  host.append(head, grid);
  grid.append(skeletonCard());
  const roles = await loadRoles();
  grid.innerHTML = "";
  if (!roles.length) {
    grid.append(emptyState({ icon: "settings", title: "No roles", text: "Create a role to assign permissions." }));
    return;
  }
  const labelFor = (k: string) => permsCache.find((p) => p.key === k)?.label || k;
  for (const r of roles) {
    const body = h("div");
    body.append(
      h(
        "div",
        { class: "bv-row", style: { justifyContent: "space-between", alignItems: "center" } },
        h("strong", null, r.name),
        r.is_system ? pill("system", "") : pill(`${r.members} member${r.members === 1 ? "" : "s"}`, "accent"),
      ),
      h(
        "div",
        { style: { display: "flex", flexWrap: "wrap", gap: "6px", margin: "10px 0" } },
        ...(r.permissions.length ? r.permissions.map((k) => pill(labelFor(k), "ok")) : [h("span", { class: "bv-muted" }, "No permissions")]),
      ),
    );
    if (!r.is_system) {
      body.append(
        h(
          "div",
          { class: "bv-row" },
          h("button", { class: "secondary", onClick: () => openRole(host, r) }, "Edit"),
          h("button", { class: "ghost", onClick: () => deleteRole(r, host) }, "Delete"),
        ),
      );
    }
    grid.append(card({ body }));
  }
}

function openRole(host: HTMLElement, role?: Role) {
  const name = h("input", { type: "text", value: role?.name || "", placeholder: "e.g. Shift lead" }) as HTMLInputElement;
  const checks: Record<string, HTMLInputElement> = {};
  const permList = h(
    "div",
    { class: "bv-stack", style: { gap: "6px" } },
    ...permsCache.map((p) => {
      const cb = h("input", { type: "checkbox" }) as HTMLInputElement;
      cb.checked = !!role?.permissions?.includes(p.key);
      checks[p.key] = cb;
      return h("label", { class: "bv-row", style: { gap: "8px", alignItems: "center" } }, cb, h("span", null, p.label));
    }),
  );
  let close = () => {};
  const handle = openModal({
    title: role ? "Edit role" : "New role",
    body: h("div", { class: "bv-stack" }, field("Role name", name), h("div", { class: "bv-label" }, "Permissions"), permList),
    actions: [
      { label: "Cancel" },
      {
        label: "Save",
        primary: true,
        onClick: () => {
          if (!name.value.trim()) {
            flash("Name required", "error");
            return true;
          }
          const permissions = Object.keys(checks).filter((k) => checks[k]!.checked);
          bvApi("/api/roles", { method: "POST", body: JSON.stringify({ id: role?.id, name: name.value.trim(), permissions }) })
            .then(() => {
              flash("Role saved", "success");
              close();
              renderRoles(host);
            })
            .catch((e) => flash(e?.message || "Failed", "error"));
          return true;
        },
      },
    ],
  });
  close = handle.close;
}

async function deleteRole(r: Role, host: HTMLElement) {
  const ok = await bvApi(`/api/roles/${r.id}/delete`, { method: "POST" }).then(() => true).catch(() => false);
  flash(ok ? `Role "${r.name}" removed` : "Couldn't delete", ok ? "success" : "error");
  if (ok) renderRoles(host);
}

function copyLink(link: string) {
  navigator.clipboard?.writeText(link).then(() => flash("Invite link copied", "success"), () => flash(link, "info"));
}

function field(label: string, input: HTMLElement): HTMLElement {
  return h("div", { class: "bv-field" }, h("label", { class: "bv-label" }, label), input);
}
