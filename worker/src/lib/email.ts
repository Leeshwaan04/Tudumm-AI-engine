// Transactional email via the Resend HTTP API — only when RESEND_API_KEY and EMAIL_FROM exist.
// Every function reports failure by return value; nothing here throws or logs addresses.
import type { Env } from "../env";
import { logError } from "./log";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export function emailConfigured(env: Pick<Env, "RESEND_API_KEY" | "EMAIL_FROM">): boolean {
  return !!(env.RESEND_API_KEY && env.EMAIL_FROM);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export function simpleHtml(text: string): string {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#111">${escapeHtml(text)
    .split("\n")
    .map((l) => `<p style="margin:0 0 10px">${l || "&nbsp;"}</p>`)
    .join("")}</div>`;
}

function payload(env: Pick<Env, "EMAIL_FROM">, m: EmailMessage) {
  return { from: env.EMAIL_FROM, to: [m.to], subject: m.subject, text: m.text, html: m.html ?? simpleHtml(m.text) };
}

export async function sendEmail(env: Pick<Env, "RESEND_API_KEY" | "EMAIL_FROM">, m: EmailMessage): Promise<boolean> {
  if (!emailConfigured(env)) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(payload(env, m)),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) logError("email.send", new Error(`resend status ${res.status}`));
    return res.ok;
  } catch (err) {
    logError("email.send", err);
    return false;
  }
}

/** Up to 100 messages in ONE subrequest (Resend batch API). Extra messages are dropped. */
export async function sendEmailBatch(env: Pick<Env, "RESEND_API_KEY" | "EMAIL_FROM">, msgs: EmailMessage[]): Promise<number> {
  if (!emailConfigured(env) || msgs.length === 0) return 0;
  const batch = msgs.slice(0, 100);
  try {
    const res = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(batch.map((m) => payload(env, m))),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      logError("email.batch", new Error(`resend status ${res.status}`), { count: batch.length });
      return 0;
    }
    return batch.length;
  } catch (err) {
    logError("email.batch", err, { count: batch.length });
    return 0;
  }
}

/** "sumit.b@gmail.com" -> "su***@g***.com" (for the dev outbox / admin views that need less). */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local.slice(0, 2)}***@${host.slice(0, 1)}***${tld}`;
}
