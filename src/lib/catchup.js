/**
 * Catch-up on reconnect — recover messages the bot missed while offline.
 *
 * The hub keeps a per-bot event log (`catchup_events`) exposed through
 * `client.catchup({since, cursor, limit})`. Each event is either a
 * `channel_message_summary` / `thread_message_summary` (N messages arrived in
 * that channel / thread) or a lifecycle event (invite, status change, ...).
 * Message bodies come from `getMessages()` / `getThreadMessages()`.
 *
 * The parts that are easy to get wrong, and how this module handles them:
 *
 * 1. Hub timestamp paging is STRICT and newest-first:
 *      `created_at > since AND created_at < before ORDER BY created_at DESC LIMIT n`
 *    (hub `getMessages` / `getThreadMessages`). A window `[lo, hi]` is therefore
 *    queried as `since = lo - 1`, `before = hi + 1`. When a page comes back full
 *    the window is split in two OVERLAPPING halves that both keep the split
 *    instant (`[lo, split]` and `[split, hi]`), so the row at the cut point can
 *    never fall through the gap. Duplicates from the overlap are dropped by id.
 *
 * 2. Progress is per channel / thread and persisted: `doneUpTo` plus the list of
 *    still-to-fetch windows plus the ids already delivered inside those
 *    windows. A run that exhausts its page budget keeps the remaining windows,
 *    so the next run continues where it stopped instead of rescanning. Ids in an
 *    open window are never dropped, so an unfinished window cannot re-deliver.
 *
 * 3. The event feed is paginated with the hub's own cursor, also persisted. A
 *    run that hits the event page budget saves the cursor and resumes from it.
 *    The event boundary (`eventsSince`) only advances when the feed is fully
 *    drained, every scan finished, and nothing failed.
 *
 * 4. A gap only closes if no new gap appeared while the run was in flight
 *    (gap epoch), so a disconnect during a slow run is not swallowed.
 *
 * 5. Nothing is dropped for volume reasons: above the notify threshold one
 *    summary line is sent and everything is still delivered, throttled.
 *
 * 6. Failures are logged and retried on the next run; realtime traffic never
 *    depends on this module.
 */

import { CatchupStateStore } from './catchup-state.js';

export const DEFAULT_LIMITS = Object.freeze({
  /** catchup() events per page (hub caps at 200) */
  eventPageSize: 100,
  /** max catchup() pages per run; the leftover resumes from the saved cursor */
  eventMaxPages: 20,
  /** messages per REST page (hub caps at 200) */
  messagePageSize: 100,
  /** max REST requests per channel/thread per run; leftover windows persist */
  messageMaxPages: 50,
  /** above this many messages, send one summary line first */
  notifyThreshold: 50,
  /** offline longer than this also triggers the summary line */
  offlineThresholdMs: 24 * 60 * 60 * 1000,
  /** messages per throttled batch */
  batchSize: 25,
  /** pause between throttled batches */
  batchDelayMs: 10_000,
  /** stop a single run after this many messages, continue automatically */
  maxMessagesPerRun: 1000,
  /** re-read this much before the event boundary (boundary/clock insurance) */
  queryOverlapMs: 5000,
});

/** Event types that must be expanded into real messages. */
const MESSAGE_EVENT_TYPES = new Set(['channel_message_summary', 'thread_message_summary']);

/**
 * Delivery bookkeeping shared by the realtime handlers and catch-up.
 *
 * `inFlight` means "being delivered right now", NOT "delivered". Being in
 * `inFlight` makes the other side skip the id to avoid a double send, but it is
 * never treated as success — only `mark()` writes the success record, and
 * callers must call it after C4 accepted the message.
 */
export class DeliveryGate {
  constructor({ state, label }) {
    this.state = state;
    this.label = label;
    this.inFlight = new Set();
  }

  /** Successfully delivered before (live or replayed)? */
  isDelivered(id) {
    if (!id) return false;
    return this.state.hasSeen(this.label, id);
  }

  /** Delivered or currently in flight. */
  isSeen(id) {
    if (!id) return false;
    return this.inFlight.has(id) || this.isDelivered(id);
  }

  begin(id) {
    if (id) this.inFlight.add(id);
  }

  clear(id) {
    if (id) this.inFlight.delete(id);
  }

  /**
   * Record a message as handled. Call only after C4 accepted it, or after the
   * delivery pipeline decided the message is terminally out of policy (which is
   * also a final answer for this message). Never advances the catch-up
   * boundary: that belongs to the per-target scan records.
   */
  mark(id, at, { kind, targetId } = {}) {
    if (!id) return;
    this.inFlight.delete(id);
    this.state.remember(this.label, id, at);
    if (kind && targetId) this.state.addTargetId(this.label, kind, targetId, id, at);
    if (at) this.state.setLastDeliveredAt(this.label, at);
  }
}

/**
 * One notice line before a large replay.
 * `exact === false` means `count` is a lower bound (we found out the batch was
 * big only by delivering it, the hub did not give us totals).
 */
export function formatCatchupSummary({ label, count, exact = true, offlineMs, since, until, limits = DEFAULT_LIMITS, multiOrg }) {
  const tag = multiOrg === false ? 'HXA-Connect' : `HXA:${label}`;
  const hours = offlineMs > 0 ? (offlineMs / 3600000) : 0;
  const window = `${new Date(since).toISOString()} → ${new Date(until).toISOString()}`;
  const size = exact ? `共 ${count} 条` : `至少 ${count} 条`;
  return `[${tag}] 补收：离线约 ${hours.toFixed(1)} 小时，${size}消息（${window}）。` +
    `按每批 ${limits.batchSize} 条、间隔 ${Math.round(limits.batchDelayMs / 1000)} 秒全部补投，不丢弃任何消息；` +
    `已投递过的按消息 ID 跳过。`;
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
  if (res && Array.isArray(res.items)) return res.items;
  return [];
}

/**
 * Fetch one INCLUSIVE time window `[lo, hi]`.
 *
 * Hub semantics (verified against `HeXiaobo/hxa-connect` src/db.ts):
 *   `channel_id = ? AND created_at > since AND created_at < before
 *    ORDER BY created_at DESC LIMIT n`
 *   — no `id` tiebreak in the timestamp path. Hence `since = lo - 1` and
 *   `before = hi + 1`, and the window walk below never depends on row order.
 *
 * Rows that share one millisecond cannot be separated by the timestamp query.
 * A window whose width is 1 ms is therefore retried with the hub's id-cursor
 * path (non-numeric `before`), which pages with
 * `created_at < t OR (created_at = t AND id < anchor)` and CAN walk into the
 * middle of an instant flood. Should a hub answer the very same page again
 * (no progress), the runner stops rescanning and reports the instant as
 * blocked instead of silently declaring the window done.
 */
async function fetchWindow({ fetchPage, lo, hi, limit, anchorId, idScan = false }) {
  // `before` stays a string only for the id-cursor path; the hub treats a
  // non-numeric `before` as "page below this message id" and answers
  // `{messages, has_more}`.
  // The hub's cursor path is selected by a `before` that is a message id. For
  // the very first page there is no cursor yet, so `before` is omitted and the
  // SDK/hub answer the newest page ordered by (created_at, id).
  const res = idScan || anchorId
    ? await fetchPage(anchorId ? { before: anchorId, limit } : { limit })
    : await fetchPage({ since: Math.max(0, lo - 1), before: hi + 1, limit });
  const raw = toArrayResult(res);
  const byId = new Map();
  for (const m of raw) {
    if (!m || !m.id) continue;
    const at = Number(m.created_at) || 0;
    // Defensive: the hub already filters, but never let a time-window row
    // outside the window leak in (or a replay would deliver the same row
    // twice). The id scan deliberately walks outside `[lo, hi]`.
    if (!idScan && (at < lo || at > hi)) continue;
    if (!byId.has(m.id)) byId.set(m.id, m);
  }
  const messages = [...byId.values()].sort((a, b) =>
    (Number(a.created_at) || 0) - (Number(b.created_at) || 0)
    || String(a.id).localeCompare(String(b.id)));
  // The hub answers with an array (legacy timestamp paging) or with
  // `{messages, has_more}` (id-cursor paging). Trust `has_more` when present —
  // the array length is only a proxy for "the page was cut".
  const hasMoreFlag = res && typeof res === 'object' && !Array.isArray(res) && 'has_more' in res
    ? !!res.has_more
    : null;
  return {
    messages,
    full: hasMoreFlag ?? (raw.length >= limit),
    oldestAt: messages.length ? Number(messages[0].created_at) || 0 : hi,
    oldestRow: messages[0] || null,
  };
}

export class CatchupRunner {
  /**
   * @param {object} opts
   * @param {object} opts.client  HxaConnectClient (catchup/getMessages/getThreadMessages)
   * @param {string} opts.label   org label
   * @param {CatchupStateStore} opts.state
   * @param {(item: object) => Promise<void>} opts.deliverMessage  shared delivery
   *        pipeline; must resolve only after C4 accepted the message (or the
   *        message was terminally rejected by policy), reject otherwise.
   * @param {(text: string) => Promise<void>} [opts.deliverSummary]
   * @param {(event: object) => Promise<void>} [opts.deliverEvent]
   * @param {(msg: string) => void} [opts.log]
   * @param {() => number} [opts.now]
   * @param {(ms: number) => Promise<void>} [opts.sleep]
   * @param {Partial<typeof DEFAULT_LIMITS>} [opts.limits]
   * @param {boolean} [opts.multiOrg]
   * @param {DeliveryGate} [opts.gate]  shared with the realtime handlers
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
    this.continuation = null;
    this.disposed = false;
  }

  dispose() {
    this.disposed = true;
    if (this.continuation) {
      clearTimeout(this.continuation);
      this.continuation = null;
    }
  }

  /**
   * Run once, serialised per connection. A call that arrives during a run
   * schedules exactly one follow-up run.
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
        } while (this.queued && !this.disposed);
      } finally {
        this.running = false;
        this.current = null;
      }
    })();
    return this.current;
  }

  async _runOnce(reason) {
    const startedAt = this.now();
    // If a new gap appears while we work, we must not close it at the end.
    const epochAtStart = this.state.getGapEpoch(this.label);

    const eventsSince = this.state.getEventsSince(this.label);
    if (!eventsSince) {
      // First run ever: baseline from now, never replay pre-feature history.
      this.state.setEventsSince(this.label, startedAt);
      this.state.setEventCursor(this.label, null);
      this.state.settleGap(this.label, epochAtStart);
      this.state.save();
      this.log(`catchup baseline set to ${new Date(startedAt).toISOString()} — nothing to replay`);
      this.lastRun = { reason, skipped: 'baseline', at: startedAt };
      return;
    }

    const querySince = Math.max(0, eventsSince - this.limits.queryOverlapMs);
    const counters = { delivered: 0, skipped: 0, failed: 0, lifecycle: 0 };

    this.log(`catchup start (${reason}) since ${new Date(eventsSince).toISOString()}${this.state.isDirty(this.label) ? ' (gap suspected)' : ''}`);

    // ── Phase 1: drain the event feed (cursor resumes a previous run) ──
    const summaries = new Map();
    const otherEvents = [];
    let cursor = this.state.getEventCursor(this.label);
    let eventsExhausted = false;
    let lastEventAt = 0;

    try {
      for (let page = 0; page < this.limits.eventMaxPages; page++) {
        const res = await this.client.catchup({
          since: querySince,
          cursor: cursor || undefined,
          limit: this.limits.eventPageSize,
        });
        const list = Array.isArray(res) ? res : (Array.isArray(res?.events) ? res.events : []);
        for (const ev of list) {
          if (!ev || typeof ev !== 'object') continue;
          if (MESSAGE_EVENT_TYPES.has(ev.type)) {
            const kind = ev.type === 'thread_message_summary' ? 'thread' : 'channel';
            const id = kind === 'thread' ? ev.thread_id : ev.channel_id;
            if (id) {
              const key = CatchupStateStore.targetKey(kind, id);
              const prev = summaries.get(key);
              summaries.set(key, {
                kind,
                id,
                count: (prev?.count || 0) + (Number(ev.count) || 1),
              });
            }
          } else {
            otherEvents.push(ev);
          }
          const at = Number(ev.occurred_at) || 0;
          if (at > lastEventAt) lastEventAt = at;
        }
        const hasMore = Array.isArray(res) ? false : !!res?.has_more;
        if (!hasMore) {
          eventsExhausted = true;
          cursor = null;
          break;
        }
        if (!res?.cursor) {
          // `has_more` without a cursor: the feed is NOT drained, but there is
          // no way to continue this run. Keep the boundary where it is and
          // leave the cursor empty so the next run starts the page again.
          eventsExhausted = false;
          cursor = null;
          this.log('catchup: event feed reports more pages but returned no cursor — boundary kept, retrying next run');
          break;
        }
        cursor = res.cursor;
      }
    } catch (err) {
      this.log(`catchup failed while fetching events (${err?.message || err}) — realtime traffic unaffected, retrying next run`);
      this.state.save();
      this.lastRun = { reason, error: String(err?.message || err), at: startedAt };
      return;
    }

    if (!eventsExhausted) {
      this.log(`catchup: event page budget reached (${this.limits.eventMaxPages}); cursor saved, resuming next run`);
    } else {
      cursor = null;
    }

    // ── Phase 2: open the scans for this batch ──
    for (const { kind, id } of summaries.values()) {
      this.state.extendTarget(this.label, kind, id, startedAt);
    }

    const pending = this.state.openTargets(this.label);
    const offlineMs = Math.max(0, startedAt - eventsSince);
    // The hub tells us how many messages each summary covers; use that instead
    // of guessing from window counts.
    let expected = 0;
    for (const s of summaries.values()) expected += Math.max(1, Number(s.count) || 1);
    // Estimated size of this batch (hub-provided counts) + how long we were away.
    const overThreshold = expected > this.limits.notifyThreshold
      || offlineMs > this.limits.offlineThresholdMs;
    if (overThreshold) this.log(`catchup: large batch expected (${expected} message(s), offline ${(offlineMs / 3600000).toFixed(1)}h)`);

    let summarySent = false;
    const maybeSummary = async () => {
      if (summarySent) return;
      const knownBig = expected > this.limits.notifyThreshold
        || offlineMs > this.limits.offlineThresholdMs;
      const discoveredBig = counters.delivered >= this.limits.notifyThreshold;
      if (!knownBig && !discoveredBig) return;
      summarySent = true;
      try {
        await this.deliverSummary(formatCatchupSummary({
          label: this.label,
          count: knownBig ? Math.max(expected, 1) : counters.delivered,
          exact: knownBig,
          offlineMs,
          since: eventsSince,
          until: startedAt,
          limits: this.limits,
          multiOrg: this.multiOrg,
        }));
      } catch (err) {
        this.log(`catchup summary delivery failed (${err?.message || err})`);
      }
    };

    let allComplete = true;
    let batchesSinceSleep = 0;
    let runError = null;

    // ── Phase 3: walk every open scan, oldest window first ──
    // The page budget is per target AND per run, so re-entering a target from
    // this loop cannot hand it a fresh budget (that would let a single run
    // drain unboundedly and defeat the throttle).
    const pageBudgets = new Map();
    const budgetFor = key => {
      if (!pageBudgets.has(key)) pageBudgets.set(key, this.limits.messageMaxPages);
      return pageBudgets.get(key);
    };
    const spentPages = (key, n) => pageBudgets.set(key, budgetFor(key) - n);

    try {
      while (true) {
        // Always pick the oldest pending window across targets: progress is
        // strictly forward in time, so no target can be starved.
        const open = this.state.openTargets(this.label);
        if (open.length === 0) break;
        if (counters.delivered >= this.limits.maxMessagesPerRun) {
          allComplete = false;
          this.log(`catchup: per-run cap reached (${this.limits.maxMessagesPerRun}); remaining work resumes automatically`);
          break;
        }
        // A target with no budget left waits for the next run.
        const usable = open.filter(o => budgetFor(CatchupStateStore.targetKey(o.kind, o.id)) > 0);
        if (usable.length === 0) {
          allComplete = false;
          this.log(`catchup: page budget used for every open channel/thread; remaining work resumes next run`);
          break;
        }

        const { kind, id, target } = usable[0];
        const key = CatchupStateStore.targetKey(kind, id);
        const fetchPage = kind === 'thread'
          ? opts => this.client.getThreadMessages(id, opts)
          : opts => this.client.getMessages(id, opts);

        const before = counters.delivered;
        const result = await this._scanTarget({
          kind, id, target, fetchPage, counters, maybeSummary,
          budget: budgetFor(key),
        });
        spentPages(key, result.requests);
        if (!result.complete) allComplete = false;

        const newly = counters.delivered - before;
        if (newly > 0) {
          batchesSinceSleep += newly;
          if (batchesSinceSleep >= this.limits.batchSize) {
            batchesSinceSleep = 0;
            this.state.save();
            try { await this.sleep(this.limits.batchDelayMs); } catch {}
          }
        }

        if (!result.progressed && !result.complete) {
          // This target cannot make progress right now (budget spent or an
          // instant flood): do not spin, the next run picks it up.
          break;
        }
        if (counters.delivered >= this.limits.maxMessagesPerRun) {
          allComplete = false;
          break;
        }
      }
    } catch (err) {
      runError = err;
      counters.failed++;
      allComplete = false;
      this.log(`catchup delivery failed (${err?.message || err}) — will retry next run`);
    }

    // ── Phase 4: lifecycle events (caller applies policy) ──
    for (const ev of otherEvents) {
      try {
        if (this.deliverEvent) await this.deliverEvent({ ...ev, catchup: true, label: this.label });
        else this.log(`catchup event ${ev.type}: ${JSON.stringify(ev).substring(0, 200)}`);
        counters.lifecycle++;
      } catch (err) {
        this.log(`catchup event ${ev.type} delivery failed (${err?.message || err})`);
      }
    }

    // ── Phase 5: advance the boundary only when everything is done ──
    const targetsDone = this.state.targetsSettled(this.label);
    const canAdvance = eventsExhausted && allComplete && targetsDone && !runError;

    this.state.setEventCursor(this.label, canAdvance ? null : cursor);

    // A gap that appeared while this run was in flight belongs to the *next*
    // run: closing it now would move the boundary past messages this run never
    // looked at.
    const gapClosed = canAdvance && this.state.settleGap(this.label, epochAtStart);

    if (gapClosed) {
      // Advance to the newest event we consumed, capped at the run start: any
      // event that arrived while we were working stays in the window.
      const next = lastEventAt > eventsSince ? Math.min(lastEventAt, startedAt) : startedAt;
      this.state.setEventsSince(this.label, next);
      this.state.pruneTargets(this.label);
      this.state.pruneDelivered(this.label, Date.now());
      this.state.save();
      this.log(`catchup done: ${counters.delivered} delivered, ${counters.skipped} already handled, ${counters.failed} failed (${counters.lifecycle} lifecycle event(s))`);
    } else {
      this.state.save();
      const why = canAdvance ? 'a disconnect happened during the run' : (eventsExhausted ? 'work remains' : 'event cursor saved');
      this.log(`catchup incomplete: ${counters.delivered} delivered, ${counters.skipped} already handled, ${counters.failed} failed (${why}); resuming next run`);
    }

    this.lastRun = {
      reason,
      delivered: counters.delivered,
      skipped: counters.skipped,
      failed: counters.failed,
      events: counters.lifecycle,
      complete: gapClosed,
      at: startedAt,
    };

    if (!gapClosed && counters.delivered > 0) this._scheduleContinuation();
  }

  /**
   * Work through one target's pending windows, oldest first, within the page
   * budget. Returns `{ complete, progressed }`.
   */
  async _scanTarget({ kind, id, target, fetchPage, counters, maybeSummary = async () => {}, budget = this.limits.messageMaxPages }) {
    const limits = this.limits;
    let remaining = budget;
    let requests = 0;
    let complete = true;
    let progressed = false;

    while (target.windows.length > 0) {
      if (remaining <= 0) {
        complete = false;
        this.log(`catchup ${kind} ${id}: page budget used (${remaining} left); ${target.windows.length} window(s) resume next run`);
        break;
      }
      if (counters.delivered >= limits.maxMessagesPerRun) {
        complete = false;
        break;
      }

      // Id-cursor mode. Used when one timestamp holds more rows than a page:
      // the timestamp query has no id tiebreak, so it can only ever return an
      // arbitrary subset of the tied rows. The hub's cursor path orders by
      // (created_at, id) and returns `{messages, has_more}`, so walking it from
      // the newest row of the channel down to the window's bottom enumerates
      // everything, ties included.
      if (target.byId) {
        const lo = target.windows.length ? target.windows[0][0] : (target.doneUpTo + 1);
        remaining--;
        requests++;
        const { messages, full } = await fetchWindow({
          fetchPage, lo, hi: target.hi, limit: limits.messagePageSize,
          anchorId: target.anchorId, idScan: true,
        });

        let below = false;
        let hitCap = false;
        for (const m of messages) {
          const at = Number(m.created_at) || 0;
          if (at < lo) { below = true; break; }
          // Above the scan's high-water mark: still realtime territory.
          if (at > target.hi) continue;
          if (counters.delivered >= limits.maxMessagesPerRun) { hitCap = true; break; }
          if (this.gate.isSeen(m.id)) {
            this.state.addTargetId(this.label, kind, id, m.id, at);
            counters.skipped++;
            progressed = true;
            continue;
          }
          await maybeSummary();
          this.gate.begin(m.id);
          try {
            await this.deliverMessage({
              kind,
              targetId: id,
              // The delivery pipelines address a destination, not a "target":
              // hand them the field name they act on. `targetId` stays for
              // readers of the catch-up records.
              channelId: kind === 'channel' ? id : undefined,
              threadId: kind === 'thread' ? id : undefined,
              message: m,
              catchup: true,
              label: this.label,
            });
            counters.delivered++;
            progressed = true;
            this.gate.mark(m.id, at, { kind, targetId: id });
          } catch (err) {
            this.gate.clear(m.id);
            this.state.save();
            throw err;
          }
        }

        if (below || messages.length === 0 || !full) {
          // Walked through the whole channel below the anchor. Go back to the
          // timestamp query for this window once: it may still hold tied rows
          // that sit ABOVE the anchor (the cursor only walks downwards). If it
          // returns only handled ids the window really is done.
          const at = target.anchorAt || 0;
          if (at > lo) {
            this.state.shrinkWindowTop(this.label, kind, id, at);
            this.state.endIdScan(this.label, kind, id);
            continue;
          }
          this.state.commitWindow(this.label, kind, id);
          continue;
        }
        if (hitCap) {
          complete = false;
          break;
        }
        // Descending id walk: continue strictly below the smallest id of the
        // page we just consumed.
        const nextAnchor = messages[0].id;
        if (!nextAnchor || nextAnchor === target.anchorId) {
          complete = false;
          this.log(`catchup ${kind} ${id}: id scan made no progress at ${nextAnchor || 'start'} — window kept open`);
          break;
        }
        this.state.useIdScan(this.label, kind, id, nextAnchor, null);
        continue;
      }

      const [lo, hi] = target.windows[0];
      remaining--;
      requests++;

      const { messages, full, oldestAt } = await fetchWindow({
        fetchPage, lo, hi, limit: limits.messagePageSize,
      });

      let hitCap = false;
      for (const m of messages) {
        if (counters.delivered >= limits.maxMessagesPerRun) { hitCap = true; break; }
        if (this.gate.isSeen(m.id)) {
          // Already delivered live (or in an earlier overlapping window).
          this.state.addTargetId(this.label, kind, id, m.id, Number(m.created_at) || 0);
          counters.skipped++;
          progressed = true;
          continue;
        }
        // Before the first delivery of a large/long-offline batch, send one
        // notice line so the agent knows what the burst is. If the batch turns
        // out big only after we started, the notice goes out at the threshold.
        await maybeSummary();
        this.gate.begin(m.id);
        try {
          await this.deliverMessage({
              kind,
              targetId: id,
              // The delivery pipelines address a destination, not a "target":
              // hand them the field name they act on. `targetId` stays for
              // readers of the catch-up records.
              channelId: kind === 'channel' ? id : undefined,
              threadId: kind === 'thread' ? id : undefined,
              message: m,
              catchup: true,
              label: this.label,
            });
          counters.delivered++;
          progressed = true;
          this.gate.mark(m.id, Number(m.created_at) || 0, { kind, targetId: id });
        } catch (err) {
          this.gate.clear(m.id);
          this.state.save();
          throw err;
        }
      }

      if (hitCap) {
        complete = false;
        break;
      }

      if (!full) {
        // Window fully read: everything up to `hi` is handled.
        this.state.commitWindow(this.label, kind, id);
        continue;
      }

      // ── Full page ───────────────────────────────────────────────────────
      // Hub timestamp paging is `created_at > since AND created_at < before
      // ORDER BY created_at DESC LIMIT n` — newest first and with NO id
      // tiebreak. Two cases:
      //
      //   b) the page spans several instants → every row strictly newer than
      //      its oldest row has been read: narrow the window to that instant
      //      and re-read it (ids dedupe);
      //   c) the whole page sits on ONE instant that holds more rows than a
      //      page → switch this target to the hub's id cursor, which orders by
      //      (created_at, id) and can enumerate the instant completely.
      if (!messages.length) {
        this.state.commitWindow(this.label, kind, id);
        continue;
      }
      if (oldestAt < hi) this.state.shrinkWindowTop(this.label, kind, id, oldestAt);
      if (oldestAt > lo) this.state.shrinkWindowTop(this.label, kind, id, oldestAt);

      // The instant at `oldestAt` holds more rows than one page and the
      // timestamp query has no id tiebreak — this page is an arbitrary subset
      // of the tied rows. Enumerate with the id cursor starting at the highest
      // id this page returned; when the walk is done the timestamp query runs
      // again (see the id-scan branch) and the loop only ends once a full page
      // of that instant holds nothing unseen.
      this.state.useIdScan(this.label, kind, id,
        messages.reduce((max, m) => (String(m.id) > String(max) ? m.id : max), messages[0].id),
        oldestAt);
      continue;
    }

    if (target.windows.length > 0) complete = false;
    return { complete, progressed, requests };
  }

  /**
   * A run that stopped early resumes in-process a few seconds later, so a big
   * backlog drains without waiting for the next reconnect.
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
}

export { CatchupStateStore };
