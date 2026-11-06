import { createPathDetector } from './paths.js';
import { createIdentityDetector } from './identity.js';
import { createPatternDetectors } from './patterns.js';

/**
 * Detector order matters for overlap resolution: an earlier detector wins an
 * overlap. Paths run before identity so the account name inside a recognized
 * home path is covered by the path span, not double-tokenized.
 */
export function createDetectors(config) {
  const patterns = createPatternDetectors();
  const [privateKeys, sandboxAccounts, emails, tokenPatterns, ssn, phones, ipv4, cards, env, entropy] = patterns;
  return [
    privateKeys,
    createPathDetector(config),
    emails,
    sandboxAccounts,
    tokenPatterns,
    createIdentityDetector(config),
    ssn,
    phones,
    ipv4,
    cards,
    env,
    entropy,
  ];
}
