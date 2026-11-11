# Contributor compatibility and privacy

MetaVeil injects short, static operating guidance into each verified Contributor request before the ordinary redaction/scanner pipeline. It explains the intentional boundaries, refusal-marker paths, reviewer failures and the expectation to continue independent authorized work. This works across projects without relying on Muse to discover an AGENTS.md file. The tool list and enforced decisions remain authoritative.

The guidance grants no tools or filesystem roots, cannot satisfy the sandbox guard, does not alter the model or Contributor header, and does not bypass a denial. Desktop/browser capture and control, personal stores, outside-project file access and the existing denied commands remain restricted. Existing approval-mode choices are unchanged. A reviewer failure is never treated as approval.

Tool calls are buffered until the final item or completed response establishes their arguments. Their emitted delta, arguments.done, item.done and response.completed use a consistent, policy-checked value. A later frame cannot replace a finalized call with unchecked arguments. Refusals retain only fixed category markers; original denied arguments are not copied into the marker or guidance.

Token-prefix and JWT detection also checks literal escaped newline/tab separators in JSON snippets embedded inside larger messages. Scanning uses an equal-length separator view, so it preserves original offsets and ordinary content. Secret values remain one-way and are never restored.

## Verification

Run `npm test` for the privacy and compatibility regression suite. The loopback smoke test is Windows-only and uses an installed Muse CLI:

```powershell
node scripts/smoke-cli-loopback.mjs
```

The test uses the real CLI and MetaVeil with Contributor mode and the shell sandbox enabled, but replaces the model endpoint with a scripted loopback server. It checks consistent streaming arguments, an intentional harmless policy refusal, continuation of a permitted file write, and redaction of synthetic canaries and the local home path. It sends no requests to Meta or Jev and measures CLI compatibility rather than Wonder's reasoning quality. Its temporary diagnostics stay local under the ignored `.metaveil-tmp` directory. Live Jev accuracy and future model behavior are not established by this test.

Source changes require the proxy to restart. The installed hook must also be updated from `src/hook/policy.cjs`; do not reinstall or change ACLs just to update refusal wording. New guidance is applied to subsequent requests after restart, including resumed sessions.

## Usability fixes from real sessions (2026-11-11)

Measured on the audit log and the Muse session journals from 2026-11-06 to 11-10:

| Problem | What the model saw | Fix |
|---|---|---|
| Jev hid content in 38% of requests, about 62,000 lines, mostly whole 8,000-character blocks flagged at p ≈ 0.57 | Files and logs replaced by one withheld line; edits made blind | Single lines are withheld at `p >= 0.7`; a block flagged only as a whole is withheld only at `p >= 0.85` and when it has at most 20 lines. Everything else passes as `passed_uncertain`. Layer 1 is unchanged. |
| Denied command patterns (`screenshot`, `reg query` and so on) were checked against file contents | Writing ordinary code that mentioned a screenshot was refused, intermittently | Patterns apply to calls that run something. Writes, edits, todos, questions and search queries are only path-checked. |
| Refusals said "use another approach" without naming one | Up to 26 identical blocked calls in a row | Every refusal names the standing fallback: a temporary Codex worker through Orca, with a sanitized report. The guidance says so too. |
| Muse's own long tool output (`…\.local\share\muse\sessions\…\tool-outputs\`) counted as outside the project | Long build and test logs could not be read back | `read_file` of those spill files is allowed. Nothing else in that folder is. |
| Withheld markers were copied into deliverables | `BUG_REVIEW.md` contained the marker text | The hook refuses writes and edits whose text contains a metaveil marker. |
| No `web_search`, no `request_user_input` | 43 `web_fetch` calls scraping search engines; no way to ask | Both allowed. Search goes through `POST /muse-code/search`, redacted like a model request, and only for a verified session. |
| Audit labelled Jev's own withholds as "scanner unavailable" | Misleading diagnosis | The audit records the marker the model actually saw. |

The Codex fallback is the user's own standing instruction. The worker runs outside Contributor
mode, so it can do what Muse may not: desktop control, the user's browser, outside-project
files, credentialed git. Its report reaches Meta only as tool output through this proxy, where
it is redacted and scanned like anything else. The brief asks for outcome, changed file names
and check results only.
