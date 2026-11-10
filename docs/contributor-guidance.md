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
