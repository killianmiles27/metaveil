import { sha256Hex } from './util.js';
import { createJevDetector as createHttpJevDetector } from './detectors/jev.js';

export const WITHHELD_TEXT = '[content withheld by metaveil: scanner unavailable]';

export class PipelineError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'PipelineError';
    this.code = 'PIPELINE_ERROR';
    this.detector = options.detector || null;
  }
}

function validSpan(span, textLength) {
  return span
    && Number.isInteger(span.start)
    && Number.isInteger(span.end)
    && span.start >= 0
    && span.end <= textLength
    && span.start < span.end
    && typeof span.category === 'string'
    && span.category.length > 0;
}

function normalizeDetector(detector) {
  if (typeof detector === 'function') {
    return { name: detector.name || 'detector', scan: detector };
  }
  if (!detector || typeof detector.scan !== 'function') {
    throw new Error('detector must expose async scan(text, ctx)');
  }
  return detector;
}

function mergeLayers(layers) {
  const kept = [];
  for (const layer of layers) {
    for (const span of layer) {
      const overlaps = kept.some((keptSpan) => span.start < keptSpan.end && span.end > keptSpan.start);
      if (!overlaps) kept.push(span);
    }
  }
  kept.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  return kept;
}

function placeholderFor(span) {
  const category = String(span.category || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
  return `<redacted-${category}>`;
}

/** Build the Layer-1-redacted text that a post detector may see. */
function buildPreview(text, spans) {
  const pieces = [];
  const segments = [];
  let previewLength = 0;
  let cursor = 0;
  const addText = (value, originalStart) => {
    if (!value) return;
    segments.push({
      pStart: previewLength,
      pEnd: previewLength + value.length,
      oStart: originalStart,
      oEnd: originalStart + value.length,
      kind: 'text',
    });
    pieces.push(value);
    previewLength += value.length;
  };
  for (const span of spans) {
    if (span.start < cursor || span.end <= span.start) continue;
    addText(text.slice(cursor, span.start), cursor);
    const replacement = span.category === 'WITHHELD'
      ? (span.replacement || WITHHELD_TEXT)
      : placeholderFor(span);
    segments.push({
      pStart: previewLength,
      pEnd: previewLength + replacement.length,
      oStart: span.start,
      oEnd: span.end,
      kind: 'redacted',
    });
    pieces.push(replacement);
    previewLength += replacement.length;
    cursor = span.end;
  }
  addText(text.slice(cursor), cursor);
  return { text: pieces.join(''), segments };
}

function mapPreviewPoint(point, segments, originalLength, isEnd) {
  if (point <= 0) return 0;
  const previewLength = segments.length > 0 ? segments[segments.length - 1].pEnd : 0;
  if (point >= previewLength) return originalLength;
  for (const seg of segments) {
    if (point < seg.pStart || point > seg.pEnd) continue;
    if (point === seg.pStart) return seg.oStart;
    if (point === seg.pEnd) return seg.oEnd;
    if (seg.kind === 'text') return seg.oStart + (point - seg.pStart);
    return isEnd ? seg.oEnd : seg.oStart;
  }
  return originalLength;
}

function mapPostSpans(spans, preview, originalText) {
  const normal = [];
  const withheld = [];
  for (const span of spans) {
    if (span.category === 'WITHHELD' || (span.replacement !== undefined && span.replacement !== null)) {
      const start = mapPreviewPoint(span.start, preview.segments, originalText.length, false);
      const end = mapPreviewPoint(span.end, preview.segments, originalText.length, true);
      if (end > start) {
        withheld.push({
          start,
          end,
          replacement: span.replacement || WITHHELD_TEXT,
        });
      }
      continue;
    }
    for (const seg of preview.segments) {
      if (seg.kind !== 'text') continue;
      const start = Math.max(span.start, seg.pStart);
      const end = Math.min(span.end, seg.pEnd);
      if (start >= end) continue;
      const oStart = seg.oStart + (start - seg.pStart);
      const oEnd = seg.oStart + (end - seg.pStart);
      normal.push({
        ...span,
        start: oStart,
        end: oEnd,
        value: originalText.slice(oStart, oEnd),
      });
    }
  }
  return { normal, withheld };
}

function applyPostSpans(existing, normal, withheldRanges) {
  let spans = existing.slice();
  const ranges = withheldRanges
    .filter((range) => range.end > range.start)
    .map((range) => ({ ...range }))
    .sort((a, b) => a.start - b.start);

  const mergedRanges = [];
  for (const range of ranges) {
    const last = mergedRanges[mergedRanges.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      mergedRanges.push(range);
    }
  }

  for (const range of mergedRanges) {
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const span of spans) {
        if (span.start < range.end && span.end > range.start) {
          if (span.start < range.start) {
            range.start = span.start;
            expanded = true;
          }
          if (span.end > range.end) {
            range.end = span.end;
            expanded = true;
          }
        }
      }
    }
  }
  mergedRanges.sort((a, b) => a.start - b.start);
  const unioned = [];
  for (const range of mergedRanges) {
    const last = unioned[unioned.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      if (range.replacement) last.replacement = range.replacement;
    } else {
      unioned.push(range);
    }
  }

  spans = spans.filter((span) => !unioned.some((range) => span.start >= range.start && span.end <= range.end));
  for (const range of unioned) {
    spans.push({
      start: range.start,
      end: range.end,
      category: 'WITHHELD',
      replacement: range.replacement || WITHHELD_TEXT,
      // The audit must name what the model actually saw: a Jev line withhold was being
      // logged as "scanner unavailable", which hid what was really going on.
      placeholder: range.replacement || WITHHELD_TEXT,
    });
  }
  for (const span of normal) {
    if (spans.some((other) => span.start < other.end && span.end > other.start)) continue;
    spans.push(span);
  }
  spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  return spans;
}

/**
 * Ordered detector pipeline. Each detector's spans are unioned into the
 * result; a later layer can only add spans, never remove or shrink an earlier
 * span. Overlaps resolve in favour of the earlier registered detector.
 */
export class DetectorPipeline {
  constructor({ detectors = [], failurePolicy = 'withhold' } = {}) {
    if (failurePolicy !== 'withhold' && failurePolicy !== 'block') {
      throw new Error('failurePolicy must be withhold or block');
    }
    this.detectors = detectors.map((detector) => normalizeDetector(detector));
    this.failurePolicy = failurePolicy;
    this.jevContributorOnlyName = null;
  }

  register(detector) {
    this.detectors.push(normalizeDetector(detector));
    return this;
  }

  failure(detector, text, ctx) {
    const remote = detector?.remote === true || detector?.name === 'jev';
    const action = this.failurePolicy === 'block' ? 'blocked' : (remote ? 'withheld' : 'blocked');
    ctx?.audit?.record({
      requestId: ctx?.requestId,
      phase: ctx?.phase || 'request',
      action,
      category: 'DETECTOR_FAILURE',
      detector: detector?.name || 'unknown',
      field: ctx?.field,
      byteOffset: 0,
      placeholder: remote ? WITHHELD_TEXT : undefined,
    });
    // A failing local detector is an internal pipeline error: fail closed.
    // Only the explicitly registered remote scanner may degrade to a
    // withheld chunk under the `withhold` policy.
    if (!remote || this.failurePolicy === 'block') {
      throw new PipelineError('metaveil: detector failure (block policy)', { detector: detector?.name });
    }
    return [{
      start: 0,
      end: text.length,
      category: 'WITHHELD',
      replacement: WITHHELD_TEXT,
      detector: detector?.name || 'unknown',
    }];
  }

  async scan(text, ctx = {}) {
    if (typeof text !== 'string' || text.length === 0) return [];
    const normalDetectors = this.detectors.filter((detector) => !detector.post);
    const postDetectors = this.detectors.filter((detector) => detector.post);
    const layers = [];
    for (const detector of normalDetectors) {
      let spans;
      try {
        spans = await detector.scan(text, ctx);
      } catch {
        return this.failure(detector, text, ctx);
      }
      if (!Array.isArray(spans)) return this.failure(detector, text, ctx);
      for (const span of spans) {
        if (!validSpan(span, text.length)) return this.failure(detector, text, ctx);
      }
      const layer = spans
        .map((span) => ({ ...span, layer: detector.name }))
        .sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
      layers.push(layer);
    }
    let merged = mergeLayers(layers);

    for (const detector of postDetectors) {
      if (this.jevContributorOnlyName && detector.name === this.jevContributorOnlyName
        && ctx.contributor !== true) continue;
      if (typeof detector.applies === 'function') {
        let applies = false;
        try {
          applies = detector.applies(ctx) === true;
        } catch {
          return this.failure(detector, text, ctx);
        }
        if (!applies) continue;
      }
      const preview = buildPreview(text, merged);
      let spans;
      try {
        spans = await detector.scan(preview.text, {
          ...ctx,
          failurePolicy: this.failurePolicy,
        });
      } catch {
        return this.failure(detector, text, ctx);
      }
      if (!Array.isArray(spans)) return this.failure(detector, text, ctx);
      for (const span of spans) {
        if (!validSpan(span, preview.text.length)) return this.failure(detector, text, ctx);
      }
      const mapped = mapPostSpans(spans, preview, text);
      for (const span of mapped.normal) {
        if (!validSpan(span, text.length)) return this.failure(detector, text, ctx);
      }
      for (const range of mapped.withheld) {
        if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end > text.length) {
          return this.failure(detector, text, ctx);
        }
      }
      merged = applyPostSpans(merged, mapped.normal, mapped.withheld);
    }
    return merged;
  }
}

/**
 * Registration point for a future Jev detector. The wrapper implements the
 * async detector interface plus a per-chunk SHA-256 result cache so unchanged
 * text is never rescanned.
 */
export function createJevDetector({
  name = 'jev',
  enabled,
  scan = null,
  version = '1',
  maxCacheEntries = 512,
} = {}) {
  const active = enabled === undefined ? typeof scan === 'function' : Boolean(enabled);
  const cache = new Map();
  const stats = { hits: 0, misses: 0, scans: 0, size: 0 };
  return {
    name,
    remote: true,
    post: true,
    get cacheStats() {
      return { ...stats, size: cache.size };
    },
    async scan(text, ctx) {
      if (!active || typeof scan !== 'function') return [];
      const hash = sha256Hex(`${name}\u0000${version}\u0000${text}`);
      if (cache.has(hash)) {
        stats.hits += 1;
        const cached = cache.get(hash);
        cache.delete(hash);
        cache.set(hash, cached);
        return cached.map((span) => ({ ...span }));
      }
      stats.misses += 1;
      stats.scans += 1;
      const spans = await scan(text, ctx);
      if (!Array.isArray(spans)) throw new Error('remote detector returned a non-array');
      const copy = spans.map((span) => ({ ...span }));
      cache.set(hash, copy);
      while (cache.size > maxCacheEntries) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
      }
      return copy;
    },
  };
}

export const registerJevDetector = createJevDetector;

export function createPipeline({ config, detectors = [], extraDetectors = [], remoteDetector = null } = {}) {
  const pipeline = new DetectorPipeline({
    detectors: [...detectors],
    failurePolicy: config?.detectorFailure || 'withhold',
  });
  const autoJev = !remoteDetector
    && (config?.jev?.enabled || config?.jev?.configured);
  const gateJev = config?.jev?.contributorOnly !== false
    && (config?.jev?.configured === true || autoJev);
  const postDetector = remoteDetector
    || (config?.jev?.enabled || config?.jev?.configured ? createHttpJevDetector({ config }) : null);
  if (postDetector) {
    if (gateJev && postDetector.name === 'jev') pipeline.jevContributorOnlyName = postDetector.name;
    pipeline.register(postDetector);
  }
  for (const detector of extraDetectors) pipeline.register(detector);
  return pipeline;
}
