// Static, identity-free operating guidance. It explains enforcement; it never
// grants a capability, changes Contributor headers, or satisfies the sandbox guard.
export const CONTRIBUTOR_GUIDANCE = `<metaveil-contributor-guidance version="1">
MetaVeil Contributor privacy restrictions are intentional and remain mandatory.
The tools actually listed in this request and their policy decisions are authoritative. Normal sandboxed project editing, tests and builds can continue when allowed; this is not blanket permission for commands or paths.
A function call rewritten as read_file with a .metaveil-blocked/... path is a privacy refusal for the preceding proposed operation. It is not a real file, a failed ordinary file read, or evidence that the shell is broken. Never read, retry, create or repair refusal-marker paths.
Distinguish a privacy denial, an approval-review timeout, a shell/tool failure and an application failure. A reviewer timeout is not an approval. Internal submit_approval_assessment is supported when listed; it executes no command.
Desktop/browser capture or control, personal stores, outside-project data, credentials and other denied capabilities must not be reached through aliases, scripts, terminals, workers, remote-debugging protocols or permission changes. Withheld data must not be reconstructed.
For coding tasks, finish independent authorized work and verification. Do not ask for go/continue for work already authorized. A blocked check stays unverified: report its concrete boundary and continue the rest. Passing tests or opening a window does not prove native playback, GUI behavior or installation.
</metaveil-contributor-guidance>`;

export function addContributorGuidance(body) {
  if (typeof body.instructions === 'string' && body.instructions.includes(CONTRIBUTOR_GUIDANCE)) return body;
  if (body.instructions == null || typeof body.instructions === 'string') {
    return {...body, instructions: [body.instructions, CONTRIBUTOR_GUIDANCE].filter(Boolean).join('\n\n')};
  }
  // Preserve unusual existing instruction shapes rather than silently dropping them.
  if (Array.isArray(body.input)) {
    const exists = body.input.some(item => item?.role === 'developer' && item.content === CONTRIBUTOR_GUIDANCE);
    return exists ? body : {...body,input:[...body.input,{role:'developer',content:CONTRIBUTOR_GUIDANCE}]};
  }
  return body;
}
