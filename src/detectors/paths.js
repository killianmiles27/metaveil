import {
  parseWindowsPath,
  buildPathFamily,
  isUnderPath,
  formatWindowsPath,
  separatorDepth,
  readPathTail,
  canonicalTail,
  applyDepthToTail,
} from '../winpath.js';
import { decodePercentWithMap, mapDecodedRange } from '../util.js';

function formatAlias(value, depth) {
  const parsed = parseWindowsPath(value);
  return parsed ? formatWindowsPath(parsed, depth) : String(value);
}

function pathDepth(matched, parsed, jsonContext) {
  return Math.max(jsonContext ? 2 : 1, separatorDepth(matched, parsed));
}

function overlap(span, accepted) {
  return accepted.some((other) => span.start < other.end && span.end > other.start);
}

/**
 * Path layer. One stable rule:
 *  - the request's workspace root maps to workspaceAlias and its subtree stays
 *    readable beneath that alias;
 *  - other paths under home map to homeAlias with a LOCAL_PATH_n tail token;
 *  - paths under home but outside the workspace never expose their tail.
 *
 * The workspace root is per request (ctx.workspaceRoot), with config.workspaceRoot
 * as an optional fallback. The same alias is used by the restorer for this request.
 */
export function createPathDetector(config) {
  const home = parseWindowsPath(config.homeDir);
  if (!home) throw new Error('metaveil: homeDir must be a Windows drive path');
  const homeFamily = buildPathFamily(home);

  return {
    name: 'paths',
    scan(text, ctx = {}) {
      const workspaceRoot = ctx.workspaceRoot ?? config.workspaceRoot;
      const workspaceAlias = ctx.workspaceAlias ?? config.workspaceAlias;
      const workspace = workspaceRoot ? parseWindowsPath(workspaceRoot) : null;
      const workspaceFamily = workspace ? buildPathFamily(workspace) : null;
      const jsonContext = Boolean(ctx.jsonContext);

      const collect = (scanText, map, priorityBase) => {
        const workspaceSpans = [];
        const homeSpans = [];

        const toOriginal = (span) => {
          if (!map) return span;
          const mapped = mapDecodedRange(map, span.start, span.end, text.length);
          return { ...span, start: mapped.start, end: mapped.end };
        };

        if (workspaceFamily) {
          const workspaceRegex = new RegExp(workspaceFamily.source, 'gi');
          let match;
          while ((match = workspaceRegex.exec(scanText)) !== null) {
            const start = match.index;
            const rootEnd = start + match[0].length;
            const tailEnd = readPathTail(scanText, rootEnd, { jsonContext });
            const tail = canonicalTail(scanText.slice(rootEnd, tailEnd));
            const depth = pathDepth(match[0], workspace, jsonContext);
            const alias = formatAlias(workspaceAlias, depth);
            workspaceSpans.push(toOriginal({
              start,
              end: tailEnd,
              category: 'PATH_ALIAS',
              replacement: `${alias}${applyDepthToTail(tail, depth)}`,
              placeholder: alias,
              priority: priorityBase + 3,
            }));
            if (tailEnd > workspaceRegex.lastIndex) workspaceRegex.lastIndex = tailEnd;
          }
        }

        const homeRegex = new RegExp(homeFamily.source, 'gi');
        let match;
        while ((match = homeRegex.exec(scanText)) !== null) {
          const start = match.index;
          const homeEnd = start + match[0].length;
          const tailEnd = readPathTail(scanText, homeEnd, { jsonContext });
          const tail = canonicalTail(scanText.slice(homeEnd, tailEnd));
          const depth = pathDepth(match[0], home, jsonContext);
          const alias = formatAlias(config.homeAlias, depth);
          const fullCanonical = `${home.canonical}${tail}`;

          if (workspace && isUnderPath(fullCanonical, workspace.canonical)) {
            const relative = fullCanonical.slice(workspace.canonical.length).replace(/^\\/, '');
            const workspaceAliasFormatted = formatAlias(workspaceAlias, depth);
            homeSpans.push(toOriginal({
              start,
              end: tailEnd,
              category: 'PATH_ALIAS',
              replacement: relative
                ? `${workspaceAliasFormatted}${'\\'.repeat(depth)}${applyDepthToTail(relative, depth)}`
                : workspaceAliasFormatted,
              placeholder: workspaceAliasFormatted,
              priority: priorityBase + 3,
            }));
          } else if (tail) {
            homeSpans.push(toOriginal({
              start,
              end: tailEnd,
              category: 'LOCAL_PATH',
              value: tail.replace(/^\\+/, ''),
              prefix: `${alias}${'\\'.repeat(depth)}`,
              priority: priorityBase + 2,
            }));
          } else {
            homeSpans.push(toOriginal({
              start,
              end: homeEnd,
              category: 'PATH_ALIAS',
              replacement: alias,
              placeholder: alias,
              priority: priorityBase + 2,
            }));
          }
          if (tailEnd > homeRegex.lastIndex) homeRegex.lastIndex = tailEnd;
        }

        return { workspaceSpans, homeSpans };
      };

      const original = collect(text, null, 100);
      const accepted = [];

      const accept = (spans) => {
        spans.sort((a, b) => a.start - b.start || b.priority - a.priority || (b.end - b.start) - (a.end - a.start));
        for (const span of spans) {
          if (overlap(span, accepted)) continue;
          accepted.push(span);
        }
      };

      // Workspace spans always win over home spans. Original text wins over a
      // percent-decoded duplicate.
      accept(original.workspaceSpans);
      accept(original.homeSpans);

      const decoded = decodePercentWithMap(text);
      if (decoded.text !== text) {
        const decodedSpans = collect(decoded.text, decoded.map, 0);
        accept(decodedSpans.workspaceSpans);
        accept(decodedSpans.homeSpans);
      }

      accepted.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
      return accepted.map(({ priority, ...span }) => span);
    },
  };
}
