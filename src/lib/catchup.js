/**
 * Catch-up on reconnect — recover messages the bot missed while offline.
 *
 * Hub keeps a per-bot event log (channel_message_summary / thread_message_summary
 * / thread_invited / ...) that the SDK exposes through `client.catchup()`.
 * The component never called it, so anything sent during a restart or a network
 * drop was simply lost.
 *
 * Design (see PR description):
 *   - Watermark per org: timestamp of the last message that went through the
 *     delivery pipeline. Persisted atomically in the component data dir.
 *   - On first connect without a watermark: record `now`, deliver nothing
 *     (we do not replay history that predates this feature).
 *   - On every (re)connect: pull catchup events, expand message summaries into
 *     real messages, sort by time, hand each one to the SAME delivery pipeline
 *     used for realtime traffic, de-duplicated by message id.
 *   - No message is ever dropped for volume reasons: when a run exceeds the
 *     notify threshold (50 messages) or the offline window exceeds 24h we send
 *     one summary line, then deliver everything in throttled batches
 *     (default 25 messages, 10s apart). A run that hits the per-run cap stops
 *     and leaves the watermark at the last delivered message, so the next
 *     reconnect continues where this one left off.
 *   - Failures never break realtime traffic: they are logged and retried on the
 *     next reconnect.
 */

import { CatchupStateStore } from './catchup-state.js';

export const DEFAULT_LIMITS = Object.freeze({
  /** catchup() events per page */
  eventPageSize: 100,
  /** max catchup() pages per run */
  eventMaxPages: 20,
  /** messages per REST page when expanding a summary */
  messagePageSize: 100,
  /** max REST pages per channel/thread */
  messageMaxPages: 50,
  /** above this many messages, send one summary line first */
  notifyThreshold: 50,
  /** offline longer than this also triggers the summary line */
  offlineThresholdMs: 24 * 60 * 60 * 1000,
  /** messages per throttled batch */
  batchSize: 25,
  /** pause between throttled batches */
  batchDelayMs: 10_000,
  /** stop a single run after this many messages, continue on next reconnect */
  maxMessagesPerRun: 1000,
  /**
   * Re-read this much before the watermark. Boundaries are inclusive/exclusive
   * depending on endpoint and clocks drift; the overlap is de-duplicated by
   * message id, so a few seconds of re-reading is free insurance.
   */
  queryOverlapMs: 5000,
});

/** Event types that carry actual messages and must be expanded. */
const MESSAGE_EVENT_TYPES = new Set(['channel_message_summary', 'thread_message_summary']);

/**
 * Delivery gate shared by the realtime handlers and catch-up: one place that
 * answers "already handled?" and remembers ids / advances the watermark.
 */
export class DeliveryGate {
  constructor({ state, label }) {
    this.state = state;
    this.label = label;
    this.inFlight = new Set();
  }

  isSeen(id) {
    if (!id) return false;
    return this.inFlight.has(id) || this.state.hasSeen(this.label, id);
  }

  begin(id) {
    if (id) this.inFlight.add(id);
  }

  /**
   * Mark a message as handled. The watermark only advances while the org is
   * gap-free (`dirty === false`) — otherwise realtime traffic would move the
   * catch-up boundary past messages that are still missing.
   */
  mark(id, at) {
    if (!id) return; // lifecycle/thread_created deliveries carry no message id
    this.inFlight.delete(id);
    this.state.remember(this.label, id);
    if (at) {
      this.state.setLastDeliveredAt(this.label, at);
      if (!this.state.isDirty(this.label) && this.inFlight.size === 0) this.state.setWatermark(this.label, at);
    }
  }

  clear(id) {
    if (id) this.inFlight.delete(id);
  }
}

export function formatCatchupSummary({ label, count, offlineMs, since, until, limits = DEFAULT_LIMITS, multiOrg }) {
  const tag = multiOrg === false ? 'HXA-Connect' : `HXA:${label}`;
  const hours = offlineMs > 0 ? (offlineMs / 3600000) : 0;
  const window = `${new Date(since).toISOString()} → ${new Date(until).toISOString()}`;
  return `[${tag}] 补收：离线约 ${hours.toFixed(1)} 小时，共 ${count} 条消息（${window}）。` +
    `按每批 ${limits.batchSize} 条、间隔 ${Math.round(limits.batchDelayMs / 1000)} 秒全部补投，不丢弃任何消息。`;
}

export function formatCatchupEventLine({ label, event, multiOrg }) {
  const tag = multiOrg === false ? 'HXA-Connect' : `HXA:${label}`;
  switch (event.type) {
    case 'thread_invited':
      return `[${tag}] [补收] Thread invited: "${event.topic || event.thread_id}" by ${event.inviter || 'unknown'}`;
    case 'thread_status_changed':
      return `[${tag}] [补收] Thread status changed: "${event.topic || event.thread_id}" ${event.from} -> ${event.to}${event.by ? ` by ${event.by}` : ''}`;
    default:
      return `[${tag}] [补收] ${event.type}`;
  }
}

function toArrayResult(res) {
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.messages)) return res.messages;
  return [];
}

/**
 * Collect every message in the window `[since, until)`.
 *
 * The hub REST endpoints accept `since`, `before` and `limit` but the ordering
 * of a capped page is not part of the SDK contract, so cursor-style paging
 * ("continue from the oldest id you saw") cannot be trusted to be complete.
 * Instead we page by time: fetch the window; if the answer came back capped
 * (`length === limit`) the window may be truncated, so split it in half and
 * fetch both halves. This is ordering-agnostic and loses nothing.
 *
 * Returns `{ messages, complete }`. `complete === false` means the page budget
 * ran out or a window could not be split further (many messages sharing one
 * millisecond); the caller keeps its floor and resumes on the next reconnect.
 */
async function collectMessages({ fetchPage, scan, limits, log, what }) {
  let budget = limits.messageMaxPages;
  while (scan.windows.length && budget-- > 0) {
    const [lo, hi] = scan.windows[0];
    const opts = { limit: limits.messagePageSize, since: Math.max(0, lo - 1), before: hi };
    const batch = toArrayResult(await fetchPage(opts));
    scan.windows.shift();
    for (const m of batch) if (m?.id) scan.messages[m.id] = m;
    if (batch.length < limits.messagePageSize) continue;
    const mid = Math.floor((lo + hi) / 2);
    if (mid <= lo || mid >= hi) {
      // Keep the window pending: the API provides no way to enumerate a
      // saturated millisecond without a cursor. Never declare it complete.
      scan.windows.unshift([lo, hi]);
      log(`catchup ${what}: cannot narrow saturated window at ${lo}`);
      return 'stalled';
    }
    scan.windows.unshift([lo, mid], [mid, hi]);
  }
  return scan.windows.length === 0;
}

export class CatchupRunner {
  /**
   * @param {object} opts
   * @param {object} opts.client         HxaConnectClient (needs catchup/getMessages/getThreadMessages)
   * @param {string} opts.label          org label
   * @param {CatchupStateStore} opts.state
   * @param {(item: object) => Promise<void>} opts.deliverMessage   shared delivery pipeline
   * @param {(text: string) => Promise<void>} [opts.deliverSummary] one-off notice channel
   * @param {(event: object) => Promise<void>} [opts.deliverEvent]  lifecycle/invite notice
   * @param {(msg: string) => void} [opts.log]
   * @param {() => number} [opts.now]
   * @param {(ms: number) => Promise<void>} [opts.sleep]
   * @param {Partial<typeof DEFAULT_LIMITS>} [opts.limits]
   * @param {boolean} [opts.multiOrg]
   * @param {DeliveryGate} [opts.gate]  shared with the realtime handlers so an
   *        in-flight replay is visible to realtime de-duplication (and back)
   */
  constructor({
    client,
    label,
    state,
    deliverMessage,
    deliverSummary,
    deliverEvent,
    log = () => {},
    now = () => Date.now(),
    sleep = ms => new Promise(r => setTimeout(r, ms)),
    limits = {},
    multiOrg = true,
    gate,
  }) {
    if (!client) throw new Error('CatchupRunner requires a client');
    if (!label) throw new Error('CatchupRunner requires an org label');
    if (!state) throw new Error('CatchupRunner requires a state store');
    if (typeof deliverMessage !== 'function') throw new Error('CatchupRunner requires deliverMessage');

    this.client = client;
    this.label = label;
    this.state = state;
    this.deliverMessage = deliverMessage;
    this.deliverSummary = deliverSummary || (async () => {});
    this.deliverEvent = deliverEvent || null;
    this.log = log;
    this.now = now;
    this.sleep = sleep;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.multiOrg = multiOrg;
    this.gate = gate || new DeliveryGate({ state, label });

    this.running = false;
    this.queued = false;
    this.current = null;
    this.lastRun = null;
    /** Scheduled continuation for a run that stopped at its cap. */
    this.continuation = null;
    this.disposed = false;
  }

  /** Cancel a pending continuation (shutdown). */
  dispose() {
    this.disposed = true;
    if (this.continuation) {
      clearTimeout(this.continuation);
      this.continuation = null;
    }
  }

  /**
   * Run once, serialised per connection. A call that arrives while a run is in
   * flight schedules a single follow-up run (never two in parallel).
   */
  run(reason = 'manual') {
    if (this.running) {
      this.queued = true;
      return this.current;
    }
    this.running = true;
    this.current = (async () => {
      try {
        do {
          this.queued = false;
          await this._runOnce(reason);
        } while (this.queued);
      } finally {
        this.running = false;
        this.current = null;
      }
    })();
    return this.current;
  }

  async _runOnce(reason) {
    const startedAt = this.now();

    const since = this.state.getWatermark(this.label);

    if (!since) {
      // First run ever: start counting from now, never replay pre-feature
      // history. The connection is gap-free from this point on.
      this.state.setWatermark(this.label, startedAt);
      this.state.setDirty(this.label, false);
      this.state.save();
      this.log(`catchup baseline set to ${new Date(startedAt).toISOString()} — nothing to replay`);
      this.lastRun = { reason, skipped: 'baseline', at: startedAt };
      return;
    }

    const resuming = this.state.isDirty(this.label);
    // Query slightly before the watermark so a boundary/clock mismatch cannot
    // hide the newest missed message. Duplicates are dropped by id.
    const querySince = Math.max(0, since - this.limits.queryOverlapMs);
    this.log(`catchup start (${reason}) since ${new Date(since).toISOString()}${resuming ? ' (gap suspected)' : ''}`);

    // Freeze the query and persist its progress across runs and process restarts.
    // Do not deliver partial scans: doing so would allow a later-discovered
    // channel or older page to be skipped by a moving watermark.
    const org = this.state.getOrg(this.label);
    if (!org.scan) this.state.setDirty(this.label, true);
    const scan = org.scan ||= { revision: org.dirtyRevision, since: querySince, until: startedAt, events: [], cursor: null, eventsDone: false, sources: {}, sourceIndex: 0 };
    try {
      if (!scan.eventsDone) {
        const progress = await this._collectEvents(scan);
        this.state.save();
        if (!progress.complete) {
          this.lastRun = { reason, truncated: true, at: startedAt };
          if (progress.progressed) this._scheduleContinuation();
          return;
        }
      }
      const sources = scan.events.filter(ev =>
        (ev.type === 'channel_message_summary' && ev.channel_id) ||
        (ev.type === 'thread_message_summary' && ev.thread_id));
      while (scan.sourceIndex < sources.length) {
        const ev = sources[scan.sourceIndex];
        const key = `${ev.type}:${ev.channel_id || ev.thread_id}`;
        const source = scan.sources[key] ||= { windows: [[scan.since, scan.until]], messages: {} };
        const complete = await collectMessages({
          scan: source, limits: this.limits, log: this.log, what: key,
          fetchPage: opts => ev.channel_id ? this.client.getMessages(ev.channel_id, opts) : this.client.getThreadMessages(ev.thread_id, opts),
        });
        this.state.save();
        if (complete !== true) {
          this.lastRun = { reason, truncated: true, at: startedAt };
          if (complete !== 'stalled') this._scheduleContinuation();
          return;
        }
        scan.sourceIndex++;
      }
    } catch (err) {
      this.state.save();
      this.log(`catchup failed while fetching events or expanding events (${err?.message || err})`);
      this.lastRun = { reason, error: String(err?.message || err), at: startedAt };
      return;
    }
    const names = await this._resolveSenderNames();
    const messages = [];
    for (const [key, source] of Object.entries(scan.sources)) {
      const isThread = key.startsWith('thread_message_summary:');
      const id = key.slice(key.indexOf(':') + 1);
      for (const m of Object.values(source.messages)) messages.push({
        kind: isThread ? 'thread' : 'channel',
        ...(isThread ? { threadId: id } : { channelId: id }),
        message: this._withSenderName(m, names),
      });
    }
    const otherEvents = scan.events.filter(ev => !MESSAGE_EVENT_TYPES.has(ev.type));
    const complete = true;
    // Stable chronological order; ids break ties.
    messages.sort((a, b) => {
      const ta = Number(a.message?.created_at) || 0;
      const tb = Number(b.message?.created_at) || 0;
      if (ta !== tb) return ta - tb;
      return String(a.message?.id || '').localeCompare(String(b.message?.id || ''));
    });

    const total = messages.length;
    const pending = messages.filter(m => !this.gate.isSeen(m.message?.id));
    const offlineMs = Math.max(0, startedAt - since);
    // The notice describes what is actually going to be delivered.
    const overThreshold = pending.length > this.limits.notifyThreshold
      || offlineMs > this.limits.offlineThresholdMs;

    if (total === 0 && otherEvents.length === 0) {
      this.log('catchup: nothing missed');
      this._finishScan(scan);
      delete org.scan;
      this.state.save();
      this.lastRun = { reason, delivered: 0, skipped: 0, at: startedAt };
      return;
    }

    let delivered = 0;
    let skipped = 0;
    let failed = 0;
    let truncated = !complete;

    try {
      if (overThreshold) {
        try {
          await this.deliverSummary(formatCatchupSummary({
            label: this.label,
            count: pending.length,
            offlineMs,
            since,
            until: startedAt,
            limits: this.limits,
            multiOrg: this.multiOrg,
          }));
        } catch (err) {
          this.log(`catchup summary delivery failed (${err?.message || err})`);
        }
      }

      for (let i = 0; i < total; i++) {
        if (delivered >= this.limits.maxMessagesPerRun) {
          truncated = true;
          this.log(`catchup: per-run cap reached (${this.limits.maxMessagesPerRun}); remaining ${total - i} message(s) resume on the next reconnect`);
          break;
        }

        const item = messages[i];
        const id = item.message?.id;
        const at = Number(item.message?.created_at) || 0;

        if (this.gate.inFlight.has(id)) {
          truncated = true;
          break;
        }
        if (this.gate.isSeen(id)) {
          skipped++;
          continue;
        }

        this.gate.begin(id);
        try {
          await this.deliverMessage({ ...item, catchup: true, label: this.label });
          delivered++;
          this.gate.mark(id, at);
        } catch (err) {
          failed++;
          truncated = true;
          this.gate.clear(id);
          this.log(`catchup delivery failed for ${id} (${err?.message || err}) — will retry on next reconnect`);
          // Do not advance past a message we could not hand off: stop this run.
          break;
        }

        const sent = delivered + skipped;
        if (sent > 0 && sent % this.limits.batchSize === 0 && i + 1 < total) {
          this.state.save();
          try {
            await this.sleep(this.limits.batchDelayMs);
          } catch {}
        }
      }

      for (let eventIndex = scan.deliveredEvents || 0; eventIndex < otherEvents.length; eventIndex++) {
        const ev = otherEvents[eventIndex];
        try {
          if (this.deliverEvent) await this.deliverEvent({ ...ev, catchup: true, label: this.label });
          else this.log(`catchup event ${ev.type}: ${JSON.stringify(ev).substring(0, 200)}`);
          scan.deliveredEvents = eventIndex + 1;
          this.state.save();
        } catch (err) {
          truncated = true;
          this.log(`catchup event ${ev.type} delivery failed (${err?.message || err})`);
          break;
        }
      }
    } finally {
      if (!truncated) { this._finishScan(scan); delete org.scan; }
      this.state.save();
    }

    this.log(`catchup done: ${delivered} delivered, ${skipped} already handled, ${failed} failed (${otherEvents.length} lifecycle event(s))`);
    this.lastRun = { reason, delivered, skipped, failed, events: otherEvents.length, truncated, at: startedAt };

    // Continue in-process only when the last run made progress; a stuck run
    // (e.g. one millisecond with more messages than a page) waits for the next
    // reconnect instead of spinning.
    if (truncated && delivered > 0) this._scheduleContinuation();
  }

  _finishScan(scan) {
    const changed = this.state.getOrg(this.label).dirtyRevision !== scan.revision;
    if (changed || this.gate.inFlight.size) {
      this._scheduleContinuation();
    } else {
      this._settle(scan.until);
    }
  }

  /**
   * Everything up to `mark` has been handed to the delivery pipeline: move the
   * watermark there and clear the gap flag so realtime can advance it again.
   */
  _settle(mark) {
    // The window [previous watermark, mark) is fully covered. Later messages are
    // handled by realtime traffic, and any overlap is de-duplicated by id.
    this.state.setWatermark(this.label, mark);
    this.state.setDirty(this.label, false);
  }

  /**
   * A run that stopped at its per-run cap leaves the watermark in place and the
   * org dirty. Continue a
   * few seconds later in the same process so a huge backlog drains without
   * waiting for the next reconnect — still one batch burst at a time.
   */
  _scheduleContinuation(delayMs = 5000) {
    if (this.disposed || this.continuation) return;
    this.continuation = setTimeout(() => {
      this.continuation = null;
      if (this.disposed) return;
      this.run('continuation').catch(err => {
        this.log(`catchup continuation error (${err?.message || err})`);
      });
    }, delayMs);
    this.continuation.unref?.();
  }

  async _collectEvents(scan) {
    let progressed = false;
    for (let page = 0; page < this.limits.eventMaxPages; page++) {
      const res = await this.client.catchup({ since: scan.since, cursor: scan.cursor || undefined, limit: this.limits.eventPageSize });
      const list = Array.isArray(res) ? res : (Array.isArray(res?.events) ? res.events : []);
      const hasMore = Array.isArray(res) ? false : !!res?.has_more;
      if (hasMore && (!res?.cursor || res.cursor === scan.cursor)) {
        this.log('catchup events: missing or unchanged continuation cursor');
        return { complete: false, progressed: false };
      }
      scan.events.push(...list.filter(ev => ev && typeof ev === 'object'));
      progressed = true;
      if (!hasMore) { scan.eventsDone = true; return { complete: true, progressed }; }
      scan.cursor = res.cursor;
    }
    return { complete: false, progressed };
  }

  /** REST messages may omit sender_name; resolve id → name once per run. */
  async _resolveSenderNames() {
    const names = new Map();
    if (typeof this.client.listPeers !== 'function') return names;
    try {
      const peers = await this.client.listPeers();
      for (const p of Array.isArray(peers) ? peers : []) {
        if (p?.id && p?.name) names.set(p.id, p.name);
      }
    } catch (err) {
      this.log(`catchup: could not resolve peer names (${err?.message || err})`);
    }
    return names;
  }

  _withSenderName(msg, names) {
    if (!msg || msg.sender_name || !msg.sender_id) return msg;
    const name = names.get(msg.sender_id);
    return name ? { ...msg, sender_name: name } : msg;
  }
}

export { CatchupStateStore };
