import { isObject } from './util.js';
import { restoreResponseObject } from './restore.js';
import {
  evaluateFunctionCall,
  blockedCallAudit,
  contributorErrorEvent,
} from './contributor.js';

/** Incremental SSE parser. Handles \r\n and chunk splits. */
export class SseParser {
  constructor() {
    this.buffer = '';
  }

  push(chunk) {
    this.buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    this.buffer = this.buffer.replace(/\r\n/g, '\n');
    const events = [];
    let index;
    while ((index = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      const event = parseSseBlock(block);
      if (event) events.push(event);
    }
    return events;
  }

  flush() {
    const block = this.buffer;
    this.buffer = '';
    if (!block.trim()) return [];
    const event = parseSseBlock(block);
    return event ? [event] : [];
  }
}

function cleanLine(value) {
  return value.startsWith(' ') ? value.slice(1) : value;
}

function parseSseBlock(block) {
  const event = { event: undefined, data: undefined, id: undefined, retry: undefined };
  const dataLines = [];
  let sawField = false;
  for (const rawLine of block.split('\n')) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    const value = colon === -1 ? '' : cleanLine(rawLine.slice(colon + 1));
    if (field === 'data') {
      dataLines.push(value);
      sawField = true;
    } else if (field === 'event') {
      event.event = value;
      sawField = true;
    } else if (field === 'id') {
      event.id = value;
      sawField = true;
    } else if (field === 'retry') {
      event.retry = value;
      sawField = true;
    }
  }
  if (!sawField) return null;
  event.data = dataLines.length > 0 ? dataLines.join('\n') : undefined;
  return event;
}

export function serializeSseEvent(event) {
  let output = '';
  if (event.event !== undefined && event.event !== null && event.event !== '') {
    output += `event: ${event.event}\n`;
  }
  if (event.id !== undefined && event.id !== null && event.id !== '') {
    output += `id: ${event.id}\n`;
  }
  if (event.retry !== undefined && event.retry !== null && event.retry !== '') {
    output += `retry: ${event.retry}\n`;
  }
  const data = event.data === undefined || event.data === null ? '' : String(event.data);
  for (const line of data.split('\n')) output += `data: ${line}\n`;
  return `${output}\n`;
}

function envelope(originalEvent, obj) {
  return {
    event: originalEvent.event,
    id: originalEvent.id,
    retry: originalEvent.retry,
    data: JSON.stringify(obj),
  };
}

function outputTextKey(obj) {
  return `ot:${obj.item_id ?? obj.item?.id ?? obj.output_index ?? '?'}:${obj.output_index ?? 0}:${obj.content_index ?? 0}`;
}

function functionArgsKey(obj) {
  return `fa:${obj.item_id ?? obj.item?.id ?? obj.output_index ?? '?'}:${obj.output_index ?? 0}`;
}

/**
 * Transforms an upstream SSE stream:
 *  - restores placeholders/tokens, including tokens split across deltas
 *  - in contributor mode, holds function-call events until arguments are
 *    complete, then either releases them or terminates with an error event
 */
const STAND_IN_TOOL = 'read_file';

function standInArguments(verdict) {
  const reason = /^[a-z-]+$/.test(String(verdict?.reason)) ? verdict.reason : 'tool';
  return JSON.stringify({ path: `.metaveil-blocked/${reason}` });
}

function standInEvent(obj, args) {
  if (obj.type === 'response.function_call_arguments.delta') return { ...obj, delta: args };
  if (obj.type === 'response.function_call_arguments.done') {
    return { ...obj, arguments: args, ...(obj.name ? { name: STAND_IN_TOOL } : {}) };
  }
  return {
    ...obj,
    item: {
      ...obj.item,
      name: STAND_IN_TOOL,
      arguments: obj.type === 'response.output_item.added' ? '' : args,
    },
  };
}

export class SseTransformer {
  constructor({ restorer, contributor = null } = {}) {
    this.restorer = restorer;
    this.contributor = contributor && contributor.enabled ? contributor : null;
    this.parser = new SseParser();
    this.restoreStreams = new Map();
    this.calls = new Map();
    this.releasedCalls = new Set();
    this.neutralizedCalls = new Map();
    this.terminated = false;
    this.errorText = null;
  }

  push(chunk) {
    return this.renumber(this.processEvents(this.parser.push(chunk)));
  }

  finish() {
    if (this.terminated) return '';
    let output = this.processEvents(this.parser.flush());
    if (this.terminated) return this.renumber(output);
    if (this.contributor) {
      const result = this.finalizeAllPending({ atEnd: true });
      if (result.blocked) return this.renumber(output + result.text);
      output += result.text;
    }
    output += this.serializeEvents(this.flushAllRestoreStreams());
    return this.renumber(output);
  }

  /**
   * Holding back text can merge, drop or add frames, so sequence numbers are
   * rewritten to stay gapless and increasing. Streams that never use them are
   * left alone.
   */
  renumber(text) {
    if (!text) return text;
    const blocks = text.split('\n\n');
    for (let i = 0; i < blocks.length; i += 1) {
      const lines = blocks[i].split('\n');
      const dataLines = lines.filter((line) => line.startsWith('data: '));
      if (dataLines.length === 0) continue;
      let obj;
      try {
        obj = JSON.parse(dataLines.map((line) => line.slice(6)).join('\n'));
      } catch {
        continue;
      }
      if (!isObject(obj)) continue;
      if (typeof obj.sequence_number === 'number') this.usesSequence = true;
      if (!this.usesSequence) continue;
      obj.sequence_number = this.nextSequence ?? 0;
      this.nextSequence = obj.sequence_number + 1;
      const head = lines.filter((line) => !line.startsWith('data: '));
      blocks[i] = [...head, `data: ${JSON.stringify(obj)}`].join('\n');
    }
    return blocks.join('\n\n');
  }

  processEvents(events) {
    let output = '';
    for (const event of events) {
      if (this.terminated) break;
      output += this.processEvent(event);
    }
    return output;
  }

  processEvent(event) {
    const data = event.data === undefined ? '' : String(event.data);
    if (data.trim() === '[DONE]') {
      if (this.contributor) {
        const result = this.finalizeAllPending({ atEnd: true });
        if (result.blocked) {
          this.terminated = true;
          this.errorText = result.text;
          return result.text;
        }
        let output = result.text;
        output += this.serializeEvents(this.flushAllRestoreStreams());
        output += serializeSseEvent(event);
        return output;
      }
      return this.serializeEvents(this.flushAllRestoreStreams()) + serializeSseEvent(event);
    }

    let obj;
    try {
      obj = JSON.parse(data);
    } catch {
      return serializeSseEvent(event);
    }
    if (!isObject(obj)) return serializeSseEvent(event);
    // Some streams carry the event name only on the `event:` line. Without this,
    // those frames would skip restoration and contributor tool enforcement.
    if (typeof obj.type !== 'string' && typeof event.event === 'string' && event.event) {
      obj = { ...obj, type: event.event };
    }
    // A frame with no name at all can't be classified, and it could carry part of
    // a tool call. In contributor mode, never pass one along.
    if (this.contributor && typeof obj.type !== 'string') return '';
    if (this.contributor) return this.processContributorEvent(obj, event);
    return this.serializeEvents(this.restoreEvent(obj, event));
  }

  serializeEvents(events) {
    return events.map((event) => serializeSseEvent(event)).join('');
  }

  restoreEvent(obj, originalEvent) {
    const type = obj.type;
    if (type === 'response.output_text.delta' && typeof obj.delta === 'string') {
      return this.handleTextDelta(obj, originalEvent);
    }
    if (type === 'response.output_text.done') {
      return this.handleTextDone(obj, originalEvent);
    }
    if (type === 'response.function_call_arguments.delta' && typeof obj.delta === 'string') {
      return this.handleArgsDelta(obj, originalEvent);
    }
    if (type === 'response.function_call_arguments.done') {
      return this.handleArgsDone(obj, originalEvent);
    }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      if (isObject(obj.item)) {
        return [{ ...envelope(originalEvent, { ...obj, item: restoreResponseObject(obj.item, this.restorer) }) }];
      }
      return [envelope(originalEvent, obj)];
    }
    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      const flushed = this.flushAllRestoreStreams();
      return [...flushed, envelope(originalEvent, restoreResponseObject(obj, this.restorer))];
    }
    if (type === 'error' || type === 'response.error') {
      return [envelope(originalEvent, restoreResponseObject(obj, this.restorer))];
    }
    return [originalEvent];
  }

  makeDelta(template, base, text) {
    return envelope(template, { ...base, delta: text });
  }

  handleTextDelta(obj, originalEvent) {
    const key = outputTextKey(obj);
    let state = this.restoreStreams.get(key);
    if (!state) {
      state = {
        stream: this.restorer.createStream({ argsContext: false }),
        template: originalEvent,
        base: {
          type: 'response.output_text.delta',
          item_id: obj.item_id,
          output_index: obj.output_index,
          content_index: obj.content_index,
        },
      };
      this.restoreStreams.set(key, state);
    }
    const delta = state.stream.push(obj.delta);
    if (delta.length === 0) return [];
    return [envelope(originalEvent, { ...obj, delta })];
  }

  handleTextDone(obj, originalEvent) {
    const key = outputTextKey(obj);
    const events = [];
    const state = this.restoreStreams.get(key);
    if (state) {
      const leftover = state.stream.end();
      if (leftover.length > 0) events.push(this.makeDelta(state.template, state.base, leftover));
      this.restoreStreams.delete(key);
    }
    const next = { ...obj };
    if (typeof next.text === 'string') next.text = this.restorer.restoreText(next.text, { argsContext: false });
    if (typeof next.delta === 'string') next.delta = this.restorer.restoreText(next.delta, { argsContext: false });
    events.push(envelope(originalEvent, next));
    return events;
  }

  handleArgsDelta(obj, originalEvent) {
    const key = functionArgsKey(obj);
    let state = this.restoreStreams.get(key);
    if (!state) {
      state = {
        stream: this.restorer.createStream({ argsContext: true }),
        template: originalEvent,
        base: {
          type: 'response.function_call_arguments.delta',
          item_id: obj.item_id,
          output_index: obj.output_index,
        },
      };
      this.restoreStreams.set(key, state);
    }
    const delta = state.stream.push(obj.delta);
    if (delta.length === 0) return [];
    const next = { ...obj, delta };
    if (typeof next.name === 'string') next.name = this.restorer.restoreText(next.name, { argsContext: false });
    return [envelope(originalEvent, next)];
  }

  handleArgsDone(obj, originalEvent) {
    const key = functionArgsKey(obj);
    const events = [];
    const state = this.restoreStreams.get(key);
    if (state) {
      const leftover = state.stream.end();
      if (leftover.length > 0) events.push(this.makeDelta(state.template, state.base, leftover));
      this.restoreStreams.delete(key);
    }
    const next = { ...obj };
    if (typeof next.arguments === 'string') {
      next.arguments = this.restorer.restoreText(next.arguments, { argsContext: true });
    }
    if (typeof next.name === 'string') next.name = this.restorer.restoreText(next.name, { argsContext: false });
    events.push(envelope(originalEvent, next));
    return events;
  }

  flushAllRestoreStreams() {
    const events = [];
    for (const key of [...this.restoreStreams.keys()]) {
      const state = this.restoreStreams.get(key);
      const leftover = state.stream.end();
      if (leftover.length > 0) events.push(this.makeDelta(state.template, state.base, leftover));
      this.restoreStreams.delete(key);
    }
    return events;
  }

  // ---- contributor mode -------------------------------------------------

  processContributorEvent(obj, originalEvent) {
    const type = obj.type;
    if (type === 'response.function_call_arguments.delta') {
      return this.handleCallArgsDelta(obj, originalEvent);
    }
    if (type === 'response.function_call_arguments.done') {
      return this.handleCallArgsDone(obj, originalEvent);
    }
    if ((type === 'response.output_item.added' || type === 'response.output_item.done')
      && isObject(obj.item) && obj.item.type === 'function_call') {
      return this.handleCallItem(obj, originalEvent, type);
    }
    if (type === 'response.completed') {
      return this.handleCompleted(obj, originalEvent);
    }
    if (type === 'response.incomplete' || type === 'response.failed') {
      const result = this.finalizeAllPending({ atEnd: true });
      if (result.blocked) {
        this.terminated = true;
        this.errorText = result.text;
        return result.text;
      }
      return result.text + this.serializeEvents(this.restoreEvent(obj, originalEvent));
    }
    return this.serializeEvents(this.restoreEvent(obj, originalEvent));
  }

  callKey(obj) {
    return String(obj.item_id ?? obj.item?.id ?? obj.output_index ?? 'call');
  }

  getCall(key, outputIndex) {
    let call = this.calls.get(key);
    if (!call) {
      call = {
        key,
        outputIndex,
        name: null,
        args: '',
        events: [],
        complete: false,
      };
      this.calls.set(key, call);
    }
    return call;
  }

  handleCallArgsDelta(obj, originalEvent) {
    const key = this.callKey(obj);
    // Its stand-in delta already went out.
    if (this.neutralizedCalls.has(key)) return '';
    if (this.releasedCalls.has(key)) {
      return this.serializeEvents(this.restoreEvent(obj, originalEvent));
    }
    const call = this.getCall(key, obj.output_index);
    if (typeof obj.name === 'string' && obj.name) call.name = call.name || obj.name;
    call.args += typeof obj.delta === 'string' ? obj.delta : '';
    call.events.push({ obj, originalEvent });
    return '';
  }

  handleCallArgsDone(obj, originalEvent) {
    const key = this.callKey(obj);
    if (this.neutralizedCalls.has(key)) {
      return serializeSseEvent(envelope(originalEvent, standInEvent(obj, this.neutralizedCalls.get(key))));
    }
    if (this.releasedCalls.has(key)) {
      return this.serializeEvents(this.restoreEvent(obj, originalEvent));
    }
    const call = this.getCall(key, obj.output_index);
    if (typeof obj.name === 'string' && obj.name) call.name = call.name || obj.name;
    if (typeof obj.arguments === 'string') call.args = obj.arguments;
    call.events.push({ obj, originalEvent });
    call.complete = true;
    return this.finalizeCall(call).text;
  }

  handleCallItem(obj, originalEvent, type) {
    const item = obj.item;
    const key = this.callKey(obj);
    if (this.neutralizedCalls.has(key)) {
      return serializeSseEvent(envelope(originalEvent, standInEvent(obj, this.neutralizedCalls.get(key))));
    }
    if (this.releasedCalls.has(key)) {
      return this.serializeEvents(this.restoreEvent(obj, originalEvent));
    }
    const call = this.getCall(key, obj.output_index);
    if (typeof item.name === 'string' && item.name) call.name = call.name || item.name;
    call.events.push({ obj, originalEvent });
    if (type === 'response.output_item.done' || item.status === 'completed') {
      if (typeof item.arguments === 'string') call.args = item.arguments;
      call.complete = true;
      return this.finalizeCall(call).text;
    }
    return '';
  }

  evaluateCall(call) {
    const restoredName = typeof call.name === 'string'
      ? this.restorer.restoreText(call.name, { argsContext: false })
      : '';
    const restoredArgs = call.args
      ? this.restorer.restoreText(call.args, { argsContext: true })
      : '';
    return evaluateFunctionCall({
      name: restoredName,
      argumentsText: call.args,
      restoredArgumentsText: restoredArgs,
    }, this.contributor.policy, this.contributor);
  }

  block(call, verdict) {
    blockedCallAudit(this.contributor.audit, {
      requestId: this.contributor.requestId,
      phase: 'response',
    }, verdict);
    this.calls.delete(call.key);
    this.terminated = true;
    this.errorText = serializeSseEvent(contributorErrorEvent());
    return { blocked: true, text: this.errorText };
  }

  /**
   * A stream error makes Muse retry the same request, and the model never learns
   * why, so an unattended run stalls. A denied call is swapped for a read of a
   * sentinel path, which the hook refuses with the reason. If the hook is absent
   * the file simply isn't found. The original name and arguments are never sent.
   */
  neutralize(call, verdict) {
    blockedCallAudit(this.contributor.audit, {
      requestId: this.contributor.requestId,
      phase: 'response',
    }, verdict);
    const args = standInArguments(verdict);
    this.calls.delete(call.key);
    this.neutralizedCalls.set(call.key, args);
    let text = '';
    let sentDelta = false;
    for (const { obj, originalEvent } of call.events) {
      if (obj.type === 'response.function_call_arguments.delta') {
        if (sentDelta) continue;
        sentDelta = true;
      }
      text += serializeSseEvent(envelope(originalEvent, standInEvent(obj, args)));
    }
    return { blocked: false, text };
  }

  finalizeCall(call) {
    const verdict = this.evaluateCall(call);
    if (!verdict.allowed) return this.neutralize(call, verdict);
    let text = '';
    for (const buffered of call.events) {
      text += this.serializeEvents(this.restoreEvent(buffered.obj, buffered.originalEvent));
    }
    this.calls.delete(call.key);
    this.releasedCalls.add(call.key);
    return { blocked: false, text };
  }

  finalizeAllPending({ atEnd = false } = {}) {
    let text = '';
    for (const call of [...this.calls.values()]) {
      if (atEnd && !call.complete) {
        const verdict = {
          allowed: false,
          reason: 'incomplete',
          toolName: call.name || 'unnamed',
        };
        const result = this.block(call, verdict);
        return { blocked: true, text: result.text };
      }
      const result = this.finalizeCall(call);
      if (result.blocked) return { blocked: true, text: result.text };
      text += result.text;
    }
    return { blocked: false, text };
  }

  completedItemFor(call, outputs) {
    const index = Number(call.key);
    return outputs.find((item) => {
      if (!isObject(item) || item.type !== 'function_call') return false;
      return String(item.id) === call.key
        || String(item.call_id) === call.key
        || (Number.isInteger(index) && outputs.indexOf(item) === index);
    }) || (outputs.length === 1 ? outputs[0] : null);
  }

  evaluateCompletedItem(item) {
    const name = typeof item.name === 'string'
      ? this.restorer.restoreText(item.name, { argsContext: false })
      : '';
    const args = typeof item.arguments === 'string' ? item.arguments : '';
    return evaluateFunctionCall({
      name,
      argumentsText: args,
      restoredArgumentsText: args ? this.restorer.restoreText(args, { argsContext: true }) : '',
    }, this.contributor.policy, this.contributor);
  }

  handleCompleted(obj, originalEvent) {
    const response = isObject(obj.response) ? obj.response : obj;
    const outputs = Array.isArray(response.output) ? response.output : [];
    let released = '';
    for (const call of [...this.calls.values()]) {
      const item = this.completedItemFor(call, outputs);
      if (item) {
        if (typeof item.name === 'string' && item.name) call.name = call.name || item.name;
        if (typeof item.arguments === 'string') call.args = item.arguments;
      }
      call.complete = true;
      const result = this.finalizeCall(call);
      if (result.blocked) return result.text;
      released += result.text;
    }
    const safeOutputs = outputs.map((item) => {
      if (!isObject(item) || item.type !== 'function_call') return item;
      const known = this.neutralizedCalls.get(String(item.id));
      if (known) return { ...item, name: STAND_IN_TOOL, arguments: known };
      const verdict = this.evaluateCompletedItem(item);
      if (verdict.allowed) return item;
      blockedCallAudit(this.contributor.audit, {
        requestId: this.contributor.requestId,
        phase: 'response',
      }, verdict);
      return { ...item, name: STAND_IN_TOOL, arguments: standInArguments(verdict) };
    });
    const safe = isObject(obj.response)
      ? { ...obj, response: { ...obj.response, output: safeOutputs } }
      : { ...obj, output: safeOutputs };
    const flushed = this.serializeEvents(this.flushAllRestoreStreams());
    return released + flushed + serializeSseEvent(envelope(originalEvent, restoreResponseObject(safe, this.restorer)));
  }
}
