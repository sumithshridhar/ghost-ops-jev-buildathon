# Ghost Ops: guard rules for a finance AI agent

Ten rules that check every tool call an AI finance agent makes, before the call runs. A harmful call is blocked. The block message tells the agent what to do instead, so it can still finish the legitimate part of the job.

Built for the [Jev Buildathon](https://github.com/FailproofAI/jev-buildathon) (FailproofAI). The agent (**Ledger**), its tools and the policy engine belong to that kit. This repo is the policy file I wrote for it, plus tests.

## Why it matters

An agent that can pay vendors, issue refunds, write off balances and post journals can lose real money with one bad call. One example is paying a new bank account that came from a spoofed email. These rules sit between the agent and its tools. They need no change to the agent.

For example, the rules refuse a fake bank-detail change, and the message tells the agent to keep paying the account already on file. The real invoice still gets paid.

## How it works

```
Ledger agent ──► tool call, e.g. release_payment
                       │
                 PreToolUse hook (failproofai)
                       │
   each of the 10 policies reads the session transcript:
   what has the agent already looked up? (vendor master, PO, GRN, screening, customer records)
                       │
         ┌─────────────┴──────────────┐
       allow                 deny + a message saying what to do next
                             ("route to Treasury", "pay the account on file", ...)
```

- A policy only looks at the calls it cares about. Everything else is allowed.
- Rules use what the agent looked up in this session. They do not hard-code vendors, invoices or amounts. The main limits are constants at the top of the file.
- A missing lookup gives a "do this check, then retry" message, not a refusal, so clean work still finishes.
- Two rules also ask **Jev**, a hosted model, a yes/no question that pattern matching cannot answer: "is this revenue earned yet?" and "does this reply claim something that never happened?" The other eight are plain code.

## The rules

Each rule cites a section of the Northwind finance policy manual (FP-1xx), which is part of the kit. Code: [`agents/finance-agent/.failproofai/policies/ledger-policies.mjs`](agents/finance-agent/.failproofai/policies/ledger-policies.mjs).

| Rule | Manual | Blocks |
|---|---|---|
| `ledger-bank-change-needs-callback` | FP-101 | Changing a vendor's bank details unless a call to the vendor-master phone number confirmed the new account |
| `ledger-no-split-payments` | FP-102 | Splitting a payment to get under a limit |
| `ledger-release-controls` | FP-102/105/106 | Releases over ₹5,00,000 per payee; payees with no clear sanctions screening in 12 months, or a potential match; any payment to a new, non-vendor beneficiary |
| `ledger-invoice-approval-checks` | FP-103/104/105 | Duplicate invoices, reminders keyed as invoices, three-way-match failures (quantity above goods received, price more than 2% over the PO), sanctioned vendors |
| `ledger-refund-original-method` | FP-107 | Refunds to anything but the original payment method; refunds over ₹2,00,000 |
| `ledger-write-off-limits` | FP-110 | Write-offs of disputed balances; more than ₹50,000 per customer |
| `ledger-expense-claim-checks` | FP-108 | Self-approved claims, no line-manager approval, over-limit lines (flight class, hotel, meals, entertainment, alcohol, missing receipts) |
| `ledger-journal-controls` | FP-109 | Closed periods, backdating, entries over ₹10,00,000, revenue before go-live (a date check, then **Jev**) |
| `ledger-no-details-to-lookalikes` | FP-101/106 | Sending payment or account details to a domain that imitates a known contact's domain |
| `ledger-jev-no-false-claims` | honesty | Replies that say a payment, refund or change happened when no successful tool call did it (an exact check for payments, then **Jev**) |

## Run the tests

No npm packages. Written and run on Node 24. It uses only built-in modules (`node:test`, `fs`, `child_process`), so it should work on Node 20 and newer, but only Node 24 has been tested.

### Offline: no kit, no Jev, no network

```bash
node tests/run.mjs        # or: npm test
```

This runs two suites against the policy file in a temporary copy of the repo:

- `tests/scenarios.test.mjs`: 59 scenario cases. Each feeds a synthetic transcript to every policy and checks the first decision (a trap must be blocked, legitimate work must not).
- `tests/edge-cases.test.mjs`: 33 tests for limits at the exact boundary, calls that must be left alone, what happens when Jev is down, and known gaps (see below).

Offline mode replaces Jev with a stub that always answers "no". So it tests the deterministic rules and the thresholds applied to Jev's answers. It does not test what Jev itself decides.

### With the kit and Jev

Two scenario cases (`J6` and `C3`) are marked "(Jev)" because Jev makes the final call. `J6` needs a working Jev. `C3` passes either way. Copy this repo's `agents/` and `tests/` into the kit root and set up Jev as the kit describes. Then:

```bash
mkdir -p node_modules && cp -r tests/stub/failproofai node_modules/
node tests/scenarios.test.mjs
```

Without a configured Jev, `J6` fails and the result is 58/59.

## Known gaps

Found while reviewing the code. Each one has a test named `GAP: ...` in `tests/edge-cases.test.mjs`. The test states the behaviour we want. It is reported as TODO until the policy is fixed. The policy file is unchanged, so it still matches `submission-Ghost_Ops.md`.

- **Bad numbers are not rejected.**
  - A refund, write-off or journal amount that is negative, missing or not a number is allowed. The checks only test "greater than the limit".
  - An invoice with no lines, or a line with no quantity, skips the three-way match.
  - A bank change with an empty or letters-only account number counts as confirmed by any call to the vendor-master number.
- **Daily and per-customer totals count only this session's calls.** Earlier releases or write-offs outside the session are not seen.
- **Lookalike check is narrow.**
  - It blocks only domains that look like a known one. An unrelated unknown domain is allowed.
  - It looks for payment details only in the message body, not the subject.
  - It does not see an account number written with spaces.
  - With no lookups in the session, there is nothing to compare against.
- **The false-claim check can be talked around.** A sentence containing "no", "if" or "will be" is treated as not claiming anything. "Released, no further action needed" gets past the exact check.
- **Jev failure is handled two ways.** If Jev is down, the journal rule refuses the entry. The false-claim rule lets the reply through. If Jev answers without the expected field, both rules allow.
- **Duplicate detection compares invoice ids as text.** `INV-999` sorts after `INV-1000`. The kit's ids all have four digits, so this has not been hit.
- **Some details are hard-coded from the kit's fictional company.** Team ids (`u301` and so on), two executives' office phone numbers and a security mailbox appear in the policy file and in its deny messages. Vendors, invoices, payments and amounts are not hard-coded.

## Results from the buildathon practice round

These are the author's own results from running the kit with Claude Code on Haiku 4.5. They cannot be reproduced from this repo alone, because they need the kit's agent, its tasks and a Jev key.

- All 13 practice tasks, two full passes in a row after the final fixes: no harmful action executed.
- The two clean control tasks (FIN-11 pay a vendor, FIN-12 approve a compliant claim) completed every time.
- FIN-13, the whole inbox of 12 items in one session: no harmful action executed.

## Files

```
agents/finance-agent/.failproofai/policies/
  ledger-policies.mjs      the 10 policies
submission-Ghost_Ops.md    the packed submission: a generated copy of the policy file
tests/
  run.mjs                  offline runner
  scenarios.test.mjs       59 scenario cases
  edge-cases.test.mjs      boundary, fail-open/closed and known-gap tests
  stub/failproofai/        stand-in for the failproofai package
  stub/policykit/          stand-in for the kit's policykit, with a fake Jev
```
