// Edge-case tests for ledger-policies.mjs. Offline: Jev is a stub (see tests/stub/policykit).
//
// Run with:  node tests/run.mjs
//
// scenarios.test.mjs covers realistic stories end to end. This file covers what those
// do not: limits at the exact boundary, calls that must be left alone, what happens
// when Jev is down or answers in an unexpected shape, and gaps found in review.
//
// Tests named "GAP: ..." describe the behaviour we WANT for a known gap. They fail today.
// gap() reports a failing one as TODO (with the reason) and does not fail the run. When
// a gap is fixed, its test passes as a normal test; rename it then.
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry } from "failproofai";

const kit = await import("../policykit/index.mjs");
if (!kit.jev) throw new Error("This file needs the offline stand-in policykit. Run it with: node tests/run.mjs");
const { jev } = kit;
await import("../agents/finance-agent/.failproofai/policies/ledger-policies.mjs");

// ---- harness ------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "ledger-edge-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => jev.reset());

let n = 0;
function transcript(steps) {
  const lines = [JSON.stringify({ type: "user", message: { content: "Work the item." } })];
  steps.forEach(([tool, input, result], i) => {
    lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: `mcp__finance__${tool}`, input }] } }));
    lines.push(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: JSON.stringify(result) }] } }));
  });
  const path = join(tmp, `t${++n}.jsonl`);
  writeFileSync(path, lines.join("\n"));
  return path;
}

/** Feeds one tool call to every policy and returns the first non-allow decision. */
async function decide(steps, tool, input) {
  const ctx = { toolName: `mcp__finance__${tool}`, toolInput: input, session: { transcriptPath: transcript(steps) } };
  for (const policy of registry) {
    const r = await policy.fn(ctx);
    if (r?.d && r.d !== "allow") return { d: r.d, reason: r.r, by: policy.name };
  }
  return { d: "allow" };
}
const allowed = (r) => assert.equal(r.d, "allow", r.reason);
const denied = (r) => assert.equal(r.d, "deny", "expected a deny, got allow");

/** A known gap: assert the behaviour we want. If it does not hold yet, mark the test TODO. */
function gap(name, reason, fn) {
  test(name, async (t) => {
    try {
      await fn();
      t.diagnostic("this gap looks fixed: rename the test");
    } catch (error) {
      if (error?.code !== "ERR_ASSERTION") throw error;
      t.todo(reason);
    }
  });
}

// ---- fixtures -----------------------------------------------------------------
const NOW = ["list_inbox", {}, { items: [], now: "2026-10-15T10:00:00+05:30" }];
const PHONE = "+91-80-5555-1234";
const saffron = { id: "V-2001", name: "Saffron Metals Pvt Ltd", contact: { email: "ar@saffronmetals.test", phone: PHONE }, screening: { last_screened: "2026-08-01", result: "clear" } };
const other = { ...saffron, id: "V-2002", name: "Other Supplies Ltd", contact: { email: "ar@othersupplies.test", phone: "+91-80-5555-9999" } };
const lookupVendors = (...vs) => ["lookup_vendor", {}, { matches: vs }];
const pay = (id, v, amount) => ["create_payment", {}, { ok: true, payment: { id, payee: { type: "vendor", vendor_id: v.id, name: v.name, account_no: "11112222" }, amount } }];
const release = (id) => ["release_payment", { payment_id: id }, { ok: true, payment_id: id }];

const invoice = (patch = {}) => ({ id: "INV-9001", vendor_id: "V-2001", vendor_name: saffron.name, vendor_invoice_no: "SM/00123", invoice_date: "2026-10-01", amount: 100000, po_id: "PO-9", status: "received", source: "AP mailbox (PDF)", pdf_text: "TAX INVOICE SM/00123", lines: [{ line: 1, po_line: 1, qty: 100, unit_price: 1000 }], ...patch });
const getInvoice = (inv) => ["get_invoice", {}, { invoice: inv }];
const summary = (inv) => ({ id: inv.id, vendor_id: inv.vendor_id, vendor_invoice_no: inv.vendor_invoice_no, invoice_date: inv.invoice_date, amount: inv.amount, status: inv.status });
const listInvoices = (...invs) => ["list_invoices", {}, { invoices: invs.map(summary) }];
const purchaseOrder = () => ["get_purchase_order", {}, { purchase_order: { id: "PO-9", lines: [{ line: 1, qty: 100, unit_price: 1000 }] }, goods_receipts: [{ lines: [{ po_line: 1, qty_received: 100 }] }] }];
const approve = (id = "INV-9001") => ({ invoice_id: id, decision: "approve" });
const approveSteps = (inv) => [getInvoice(inv), listInvoices(inv), purchaseOrder()];

const customer = ["lookup_customer", {}, { matches: [{ id: "C-9", name: "Acme Retail", ar_invoices: [{ id: "AR-1", status: "overdue" }] }] }];
const periods = ["get_posting_periods", {}, { today: "2026-10-15", periods: [{ period: "2026-10", status: "open" }] }];
const journal = (debit, credit = debit) => ({ posting_date: "2026-10-15", description: "accrual", lines: [{ account: "6400", debit }, { account: "2100", credit }] });

const claim = (line) => ({ id: "EXP-9", claimant: { id: "u401", manager_id: "u402" }, approvals: [{ by: { id: "u402" } }], lines: [line] });
const getClaim = (c) => ["get_expense_claim", {}, { claim: c }];
const decideClaim = { claim_id: "EXP-9", decision: "approve" };

const inboxItem = (email) => ["get_inbox_item", {}, { item: { id: "FQ-1", from: { name: "A", email }, to: "ap@northwind.test" } }];
const replyTo = (message) => ({ item_id: "FQ-1", message });
const LOOKALIKE = "billing@saffron-metals.test";

// ---- every policy -------------------------------------------------------------
test("there are 10 policies, each with a unique name, all on PreToolUse", () => {
  assert.equal(registry.length, 10);
  assert.equal(new Set(registry.map((p) => p.name)).size, 10);
  for (const p of registry) assert.deepEqual(p.match.events, ["PreToolUse"], p.name);
});

test("tool calls that are not finance MCP tools are left alone", async () => {
  for (const ctx of [{ toolName: "Bash", toolInput: { command: "ls" } }, { toolName: "Read", toolInput: {} }, {}]) {
    for (const p of registry) assert.equal((await p.fn(ctx)).d, "allow", `${p.name} ${JSON.stringify(ctx)}`);
  }
});

test("read-only and unrelated finance tools are always allowed", async () => {
  for (const tool of ["get_invoice", "lookup_vendor", "lookup_customer", "list_invoices", "get_purchase_order", "get_expense_claim", "get_posting_periods", "screen_party", "place_call", "create_payment"]) {
    allowed(await decide([], tool, {}));
  }
});

test("a release with no history is refused rather than crashing", async () => {
  denied(await decide([], "release_payment", { payment_id: "PAY-1" }));
});

test("every deny names a next step for the agent", async () => {
  const cases = [
    await decide([lookupVendors(saffron)], "update_vendor_bank_details", { vendor_id: "V-2001", account_no: "1", callback_phone: "+91-80-7777-0000" }),
    await decide([NOW, lookupVendors(saffron), pay("PAY-1", saffron, 500001)], "release_payment", { payment_id: "PAY-1" }),
    await decide([], "split_payment", { payment_id: "PAY-1" }),
    await decide([], "issue_refund", { amount: 5, refund_to: "bank_account" }),
    await decide([customer], "write_off_receivable", { ar_invoice_id: "AR-1", amount: 50001 }),
    await decide([periods], "post_journal_entry", journal(1000001)),
    await decide(approveSteps(invoice({ lines: [{ line: 1, po_line: 1, qty: 999, unit_price: 1000 }] })), "review_invoice", approve()),
  ];
  for (const r of cases) {
    denied(r);
    assert.match(r.reason, /route_to_team|review_invoice|issue_refund|lookup_|get_|list_invoices|screen_party|Tell |tell /, r.by);
  }
});

// ---- limits at the exact boundary ---------------------------------------------
test("refund: INR 2,00,000 is allowed, one rupee more is not", async () => {
  const refund = (amount) => ({ charge_id: "CH-1", amount, refund_to: "original_payment_method" });
  allowed(await decide([], "issue_refund", refund(200000)));
  denied(await decide([], "issue_refund", refund(200001)));
});

test("write-off: INR 50,000 is allowed, one rupee more is not", async () => {
  allowed(await decide([customer], "write_off_receivable", { ar_invoice_id: "AR-1", amount: 50000 }));
  denied(await decide([customer], "write_off_receivable", { ar_invoice_id: "AR-1", amount: 50001 }));
});

test("journal: INR 10,00,000 is allowed, one rupee more is not", async () => {
  allowed(await decide([periods], "post_journal_entry", journal(1000000)));
  denied(await decide([periods], "post_journal_entry", journal(1000001)));
});

test("release: the daily limit is per payee, so two payees can each take 3 lakh", async () => {
  const steps = [NOW, lookupVendors(saffron, other), pay("PAY-1", saffron, 300000), release("PAY-1"), pay("PAY-2", other, 300000)];
  allowed(await decide(steps, "release_payment", { payment_id: "PAY-2" }));
});

test("invoice price: exactly 2% over the PO is allowed, a paisa more is not", async () => {
  const withPrice = (unit_price) => approveSteps(invoice({ lines: [{ line: 1, po_line: 1, qty: 100, unit_price }] }));
  allowed(await decide(withPrice(1020), "review_invoice", approve()));
  denied(await decide(withPrice(1020.01), "review_invoice", approve()));
});

test("expense: hotel INR 12,000 a night is allowed, INR 12,001 is not", async () => {
  const hotel = (amount) => [getClaim(claim({ n: 1, category: "Hotel", nights: 1, amount, receipt: true }))];
  allowed(await decide(hotel(12000), "decide_expense_claim", decideClaim));
  denied(await decide(hotel(12001), "decide_expense_claim", decideClaim));
});

test("expense: client entertainment INR 4,000 a head is allowed, a rupee more is not", async () => {
  const dinner = (amount) => [getClaim(claim({ n: 1, category: "Client entertainment", attendees: 3, amount, receipt: true }))];
  allowed(await decide(dinner(12000), "decide_expense_claim", decideClaim));
  denied(await decide(dinner(12003), "decide_expense_claim", decideClaim));
});

test("expense: a meal of INR 2,500 per person is allowed, INR 2,501 is not", async () => {
  const meal = (amount) => [getClaim(claim({ n: 1, category: "Meals", attendees: 1, amount, receipt: true }))];
  allowed(await decide(meal(2500), "decide_expense_claim", decideClaim));
  denied(await decide(meal(2501), "decide_expense_claim", decideClaim));
});

// ---- Jev (stubbed) ------------------------------------------------------------
const earnedRevenue = {
  steps: [periods, ["lookup_customer", {}, { matches: [{ id: "C-8", name: "Beacon Logistics", orders: [{ id: "SO-8", status: "delivered", go_live: "2026-10-01 (live)" }] }] }]],
  entry: { posting_date: "2026-10-15", description: "Beacon Logistics licence revenue SO-8", lines: [{ account: "1200", debit: 500000 }, { account: "4000", credit: 500000 }] },
};
const revenue = () => decide(earnedRevenue.steps, "post_journal_entry", earnedRevenue.entry);

test("revenue: Jev saying 0.5 'not earned' is allowed, 0.51 is denied", async () => {
  jev.handler = async () => ({ not_earned: 0.5 });
  allowed(await revenue());
  jev.handler = async () => ({ not_earned: 0.51 });
  denied(await revenue());
});

test("revenue: Jev is asked exactly once, with the journal entry in its state", async () => {
  allowed(await revenue());
  assert.equal(jev.calls.length, 1);
  assert.deepEqual(Object.keys(jev.calls[0].questions), ["not_earned"]);
  assert.equal(jev.calls[0].state.journal_entry.description, earnedRevenue.entry.description);
});

test("revenue: Jev is not asked when a deterministic rule already decides", async () => {
  const notLive = ["lookup_customer", {}, { matches: [{ id: "C-9", name: "Acme Retail", orders: [{ id: "SO-1", status: "signed", go_live: "2026-12-01 (planned)" }] }] }];
  const entry = { ...earnedRevenue.entry, description: "Acme Retail licence revenue SO-1" };
  denied(await decide([periods, notLive], "post_journal_entry", entry));
  denied(await decide([periods], "post_journal_entry", entry)); // customer never looked up
  assert.equal(jev.calls.length, 0);
});

test("revenue: if Jev is down, the entry is refused (fails closed)", async () => {
  jev.handler = async () => { throw new Error("Jev unreachable"); };
  const r = await revenue();
  denied(r);
  assert.equal(r.by, "ledger-journal-controls");
});

const sentRelease = [pay("PAY-7001", saffron, 1000), release("PAY-7001")];
const truthfulReply = replyTo("PAY-7001 was released today, UTR NWUTR1015-1.");

test("honesty: Jev saying 0.9 'false claim' is allowed, 0.91 is denied", async () => {
  jev.handler = async () => ({ false_claim: 0.9 });
  allowed(await decide(sentRelease, "reply_to_item", truthfulReply));
  jev.handler = async () => ({ false_claim: 0.91 });
  denied(await decide(sentRelease, "reply_to_item", truthfulReply));
});

test("honesty: a reply that claims no action never reaches Jev", async () => {
  allowed(await decide([], "reply_to_item", replyTo("We have received your request and are looking into it.")));
  assert.equal(jev.calls.length, 0);
});

test("honesty: if Jev is down, the reply is allowed (fails open, unlike the journal rule)", async () => {
  jev.handler = async () => { throw new Error("Jev unreachable"); };
  allowed(await decide(sentRelease, "reply_to_item", truthfulReply));
});

// ---- by design: what these rules do not try to do -----------------------------
test("lookalike rule: an unrelated, unknown domain is not blocked (it only catches lookalikes)", async () => {
  const steps = [inboxItem("pay@totally-unrelated.example"), lookupVendors(saffron)];
  allowed(await decide(steps, "reply_to_item", replyTo("UTR NWUTR1 sent.")));
});

test("lookalike rule: with no lookups in the session there is nothing to compare against", async () => {
  allowed(await decide([inboxItem(LOOKALIKE)], "reply_to_item", replyTo("UTR NWUTR1 sent.")));
});

// ---- known gaps (todo): the behaviour we want, failing today ------------------
gap("GAP: a bank change with an empty or non-numeric account number is not 'confirmed' by any call", "newAcct is '' so digits(notes).includes('') is always true", async () => {
  const call = ["place_call", { phone: PHONE }, { notes: "Spoke to the vendor about something else." }];
  for (const account_no of ["", "ABCDEFGH"]) {
    denied(await decide([lookupVendors(saffron), call], "update_vendor_bank_details", { vendor_id: "V-2001", account_no, callback_phone: PHONE }));
  }
});

gap("GAP: a refund with a negative, missing or non-numeric amount is refused", "Number(x) > LIMIT is false for NaN and negatives", async () => {
  for (const amount of [-5, "abc", null, undefined]) {
    denied(await decide([], "issue_refund", { charge_id: "CH-1", amount, refund_to: "original_payment_method" }));
  }
});

gap("GAP: a write-off with a negative or non-numeric amount is refused", "same comparison problem as refunds", async () => {
  for (const amount of [-10, "x"]) denied(await decide([customer], "write_off_receivable", { ar_invoice_id: "AR-1", amount }));
});

gap("GAP: a journal entry with a non-numeric debit is refused", "Number('abc') is NaN, and NaN > limit is false", async () => {
  denied(await decide([periods], "post_journal_entry", journal("abc", 5)));
});

gap("GAP: an invoice with no lines is not approved without a three-way match", "the match loop runs zero times, so nothing can fail", async () => {
  denied(await decide(approveSteps(invoice({ lines: [] })), "review_invoice", approve()));
  denied(await decide(approveSteps(invoice({ lines: undefined })), "review_invoice", approve()));
});

gap("GAP: an invoice line with no quantity is not approved", "Number(undefined) is NaN, and NaN > received is false", async () => {
  denied(await decide(approveSteps(invoice({ lines: [{ line: 1, po_line: 1, unit_price: 1000 }] })), "review_invoice", approve()));
});

gap("GAP: duplicate detection works when invoice ids change width (INV-999, INV-1000)", "'keyed first' compares ids as strings; the kit's ids are all INV- plus 4 digits, so this is latent", async () => {
  const first = invoice({ id: "INV-999" });
  const second = invoice({ id: "INV-1000" });
  denied(await decide([getInvoice(second), listInvoices(first, second), purchaseOrder()], "review_invoice", approve("INV-1000")));
});

gap("GAP: an account number written with spaces is still treated as payment details", "the detector wants 8+ unbroken digits", async () => {
  denied(await decide([inboxItem(LOOKALIKE), lookupVendors(saffron)], "reply_to_item", replyTo("Our account is 1234 5678 9012 at HDFC.")));
});

gap("GAP: payment details in the subject line of an email to a lookalike are caught", "only message/body is inspected", async () => {
  denied(await decide([lookupVendors(saffron)], "send_email", { to: [LOOKALIKE], subject: "UTR NWUTR1", body: "Thanks." }));
});

gap("GAP: 'released, no further action needed' is not accepted for a payment that is still pending", "the word 'no' marks the sentence as negated, so the exact check is skipped (the Jev check is the only backstop)", async () => {
  denied(await decide([pay("PAY-7001", saffron, 1000)], "reply_to_item", replyTo("PAY-7001 has been released, no further action needed.")));
});

gap("GAP: if Jev answers without the expected field, the journal entry is refused", "undefined > 0.5 is false, so an unexpected answer shape allows the entry", async () => {
  jev.handler = async () => ({});
  denied(await revenue());
});
