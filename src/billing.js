// Assinatura via Stripe (API REST direta, sem SDK). Cobrança por usuário (quantidade = nº de usuários).
const crypto = require("node:crypto");
const config = require("./config");
const { one, all, run, now } = require("./db");
const { HttpError } = require("./http");

function form(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v, key, out); else out.append(key, String(v));
  }
  return out;
}
async function stripe(method, path, params) {
  if (!config.features.stripe) throw new HttpError(503, "Cobrança ainda não configurada. Defina STRIPE_SECRET_KEY e STRIPE_PRICE_ID.");
  const res = await fetch("https://api.stripe.com/v1" + path, {
    method,
    headers: { Authorization: `Bearer ${config.stripe.secretKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params ? form(params).toString() : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new HttpError(502, "Stripe: " + (data.error?.message || res.status));
  return data;
}

const seats = companyId => one("SELECT COUNT(*) AS n FROM users WHERE company_id = ?", companyId).n;

// Situação da assinatura que o app usa para liberar ou bloquear o uso.
function access(company) {
  const t = now();
  if (company.status === "active") return { ok: true, status: "active" };
  if (company.status === "trialing" && company.trial_ends_at > t) return { ok: true, status: "trialing", daysLeft: Math.ceil((company.trial_ends_at - t) / 864e5) };
  if (company.status === "past_due") return { ok: true, status: "past_due", warning: "Pagamento pendente. Atualize a forma de pagamento para não perder o acesso." };
  return { ok: false, status: company.status === "trialing" ? "trial_ended" : company.status };
}

async function ensureCustomer(company, user) {
  if (company.stripe_customer_id) return company.stripe_customer_id;
  const c = await stripe("POST", "/customers", { name: company.name, email: user.email, metadata: { company_id: company.id } });
  run("UPDATE companies SET stripe_customer_id = ? WHERE id = ?", c.id, company.id);
  return c.id;
}

async function checkout(company, user) {
  const customer = await ensureCustomer(company, user);
  const s = await stripe("POST", "/checkout/sessions", {
    mode: "subscription", customer,
    line_items: { 0: { price: config.stripe.priceId, quantity: Math.max(1, seats(company.id)) } },
    success_url: `${config.appUrl}/app?assinatura=ok`,
    cancel_url: `${config.appUrl}/app?assinatura=cancelada`,
    allow_promotion_codes: "true",
    client_reference_id: String(company.id),
    subscription_data: { metadata: { company_id: company.id } }
  });
  return s.url;
}

async function portal(company) {
  if (!company.stripe_customer_id) throw new HttpError(400, "Ainda não há assinatura para gerenciar.");
  const s = await stripe("POST", "/billing_portal/sessions", { customer: company.stripe_customer_id, return_url: `${config.appUrl}/app` });
  return s.url;
}

// Mantém a quantidade de licenças igual ao número de usuários.
async function syncSeats(companyId) {
  const c = one("SELECT * FROM companies WHERE id = ?", companyId);
  if (!c?.stripe_subscription_id || !config.features.stripe) return;
  try {
    const sub = await stripe("GET", `/subscriptions/${c.stripe_subscription_id}`);
    const item = sub.items?.data?.[0];
    const n = Math.max(1, seats(companyId));
    if (item && item.quantity !== n) await stripe("POST", `/subscriptions/${sub.id}`, { items: { 0: { id: item.id, quantity: n } }, proration_behavior: "create_prorations" });
  } catch (e) { console.error("[stripe] falha ao atualizar licenças:", e.message); }
}

function verifyWebhook(raw, header) {
  if (!config.stripe.webhookSecret) throw new HttpError(503, "STRIPE_WEBHOOK_SECRET não configurado.");
  const parts = Object.fromEntries(String(header || "").split(",").map(p => p.split("=")));
  const t = Number(parts.t);
  const sigs = String(header || "").split(",").filter(p => p.startsWith("v1=")).map(p => p.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) throw new HttpError(400, "Assinatura do webhook inválida.");
  const expected = crypto.createHmac("sha256", config.stripe.webhookSecret).update(`${t}.${raw.toString("utf8")}`).digest("hex");
  const ok = sigs.some(s => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw new HttpError(400, "Assinatura do webhook inválida.");
  return JSON.parse(raw.toString("utf8"));
}

const STATUS = { active: "active", trialing: "active", past_due: "past_due", unpaid: "past_due", canceled: "canceled", incomplete_expired: "canceled", incomplete: "past_due", paused: "canceled" };

function handleEvent(evt) {
  const o = evt.data?.object || {};
  const byCustomer = id => one("SELECT * FROM companies WHERE stripe_customer_id = ?", id);
  switch (evt.type) {
    case "checkout.session.completed": {
      const c = one("SELECT * FROM companies WHERE id = ?", Number(o.client_reference_id)) || byCustomer(o.customer);
      if (c && o.subscription) run("UPDATE companies SET stripe_subscription_id = ?, status = 'active', stripe_customer_id = COALESCE(stripe_customer_id, ?) WHERE id = ?", o.subscription, o.customer, c.id);
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.created":
    case "customer.subscription.deleted": {
      const c = byCustomer(o.customer);
      if (c) run("UPDATE companies SET stripe_subscription_id = ?, status = ? WHERE id = ?", o.id, evt.type.endsWith("deleted") ? "canceled" : (STATUS[o.status] || "past_due"), c.id);
      break;
    }
    case "invoice.payment_failed": {
      const c = byCustomer(o.customer);
      if (c && c.status === "active") run("UPDATE companies SET status = 'past_due' WHERE id = ?", c.id);
      break;
    }
  }
}

module.exports = { access, checkout, portal, syncSeats, verifyWebhook, handleEvent, seats };
