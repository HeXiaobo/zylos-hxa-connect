// Caller contract: alertFn is called unconditionally when thresholds are met.
// For shadow mode, the caller must supply an alertFn that self-silences (e.g.
// logs to stdout instead of sending real alerts). The tracker does not check
// suppressionEnabled — that gate lives in the caller (see bot.js alertFn closure).
import fs from 'fs';
import path from 'path';

const DEFAULT_ALERT_THRESHOLD = 5;
const DEFAULT_SUPPRESS_AFTER = 1;
const DEFAULT_WINDOW_MS = 3_600_000;
const DEFAULT_REPEAT_WINDOW_MS = 1_800_000;
const DEFAULT_ALERT_COOLDOWN_MS = 1_800_000;
const DEFAULT_MAX_REPEAT_LENGTH = 50;
const DEFAULT_MAX_LIFETIME_MS = 4 * DEFAULT_WINDOW_MS;
const SWEEP_INTERVAL = 100;

export class SuppressionTracker {
  #logPath;
  #suppressedLogPath;
  #alertFn;
  #alertThreshold;
  #suppressAfter;
  #windowMs;
  #repeatWindowMs;
  #alertCooldownMs;
  #maxRepeatLength;
  #maxLifetimeMs;
  #counters = new Map();
  #lastAlertAt = new Map();
  #evaluateCount = 0;

  constructor({
    logPath,
    suppressedLogPath,
    alertFn,
    alertThreshold = DEFAULT_ALERT_THRESHOLD,
    suppressAfter = DEFAULT_SUPPRESS_AFTER,
    windowMs = DEFAULT_WINDOW_MS,
    repeatWindowMs = DEFAULT_REPEAT_WINDOW_MS,
    alertCooldownMs = DEFAULT_ALERT_COOLDOWN_MS,
    maxRepeatLength = DEFAULT_MAX_REPEAT_LENGTH,
    maxLifetimeMs = DEFAULT_MAX_LIFETIME_MS,
  }) {
    this.#logPath = logPath;
    this.#suppressedLogPath = suppressedLogPath || path.join(path.dirname(logPath), 'suppressed-messages.jsonl');
    this.#alertFn = alertFn;
    this.#alertThreshold = alertThreshold;
    this.#suppressAfter = suppressAfter;
    this.#windowMs = this.#validatePositive(windowMs, 'windowMs', DEFAULT_WINDOW_MS);
    this.#repeatWindowMs = this.#validatePositive(repeatWindowMs, 'repeatWindowMs', DEFAULT_REPEAT_WINDOW_MS);
    this.#alertCooldownMs = alertCooldownMs;
    this.#maxRepeatLength = this.#validatePositive(maxRepeatLength, 'maxRepeatLength', DEFAULT_MAX_REPEAT_LENGTH);
    this.#maxLifetimeMs = this.#validatePositive(maxLifetimeMs, 'maxLifetimeMs', DEFAULT_MAX_LIFETIME_MS);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  }

  get suppressAfter() { return this.#suppressAfter; }
  get alertThreshold() { return this.#alertThreshold; }
  get maxRepeatLength() { return this.#maxRepeatLength; }
  get windowMs() { return this.#windowMs; }
  get maxLifetimeMs() { return this.#maxLifetimeMs; }

  #validatePositive(value, name, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      process.stderr.write(
        `[suppression-tracker] WARN ${name}=${JSON.stringify(value)} invalid (must be positive number), falling back to ${fallback}\n`
      );
      return fallback;
    }
    return value;
  }

  #classify(trimmedContent, counter, nonSubstantive, now) {
    const timeSinceLast = now - counter.lastAt;
    const isFresh = counter.lastContent !== null && timeSinceLast <= this.#repeatWindowMs;
    const isRepeat = isFresh && trimmedContent !== '' && trimmedContent === counter.lastContent;
    const isShortRepeat = isRepeat && trimmedContent.length <= this.#maxRepeatLength;
    const isNonSubstantive = nonSubstantive || isShortRepeat;
    let reason = null;
    if (isNonSubstantive) {
      reason = (isShortRepeat && !nonSubstantive) ? 'short_repeat' : 'whitelist_or_punctuation';
    }
    return { isNonSubstantive, isRepeat, isShortRepeat, reason };
  }

  evaluate({ messageId, senderId, senderName, orgLabel, content, context, nonSubstantive = false }) {
    const now = Date.now();
    if (!senderId) {
      process.stderr.write(`[suppression-tracker] WARN senderId missing for ${senderName}, falling back to display name for bucketing\n`);
    }
    const senderKey = `${orgLabel}:${senderId || senderName}`;
    const trimmedContent = (content || '').trim();

    let counter = this.#counters.get(senderKey);
    const silenceExpired = counter && (now - counter.lastAt) > this.#windowMs;
    const lifetimeExpired = counter && (now - counter.firstAt) > this.#maxLifetimeMs;
    if (!counter || silenceExpired || lifetimeExpired) {
      if (lifetimeExpired && counter?.suppressedCount > 0) {
        this.#fireRecoveryAlert(senderKey, senderName, counter, now);
      }
      counter = { count: 0, suppressedCount: 0, firstAt: now, lastAt: now, lastContent: null };
    }

    if (!trimmedContent) {
      this.#evaluateCount += 1;
      if (this.#evaluateCount % SWEEP_INTERVAL === 0) this.#sweepStale(now);
      return { suppress: false, consecutiveCount: counter.count, suppressedCount: counter.suppressedCount, reason: null };
    }

    const { isNonSubstantive, isRepeat, isShortRepeat, reason } = this.#classify(trimmedContent, counter, nonSubstantive, now);

    if (isNonSubstantive) {
      counter.count += 1;
      counter.lastAt = now;
    } else {
      if (counter.suppressedCount > 0) {
        this.#fireRecoveryAlert(senderKey, senderName, counter, now);
      }
      counter = { count: 0, suppressedCount: 0, firstAt: now, lastAt: now, lastContent: null };
    }

    counter.lastContent = trimmedContent;
    this.#counters.set(senderKey, counter);

    const suppressThreshold = (isShortRepeat && !nonSubstantive) ? 0 : this.#suppressAfter;
    const suppress = isNonSubstantive && counter.count > suppressThreshold;
    if (suppress) counter.suppressedCount += 1;

    const entry = {
      ts: new Date(now).toISOString(),
      message_id: messageId,
      sender_id: senderId,
      sender_name: senderName,
      org_label: orgLabel,
      content: content || '',
      context: context || null,
      consecutive_count: counter.count,
      reason,
      action: suppress ? 'suppressed' : (isNonSubstantive ? 'passed' : 'substantive'),
    };

    this.#appendLog(entry);

    if (suppress) {
      process.stderr.write(
        `[suppression-tracker] suppressed msg=${messageId} sender=${senderName} reason=${reason} count=${counter.count} content=${(content || '').substring(0, 60)}\n`
      );
    }

    if (isNonSubstantive && counter.count >= this.#alertThreshold) {
      const lastAlert = this.#lastAlertAt.get(senderKey) || 0;
      const isFirstAlert = counter.count === this.#alertThreshold;
      const cooldownElapsed = (now - lastAlert) >= this.#alertCooldownMs;
      if (isFirstAlert || cooldownElapsed) {
        this.#lastAlertAt.set(senderKey, now);
        if (this.#alertFn) {
          try {
            this.#alertFn({
              senderKey,
              senderName,
              count: counter.count,
              windowSec: Math.round((now - counter.firstAt) / 1000),
              reason,
            });
          } catch (err) {
            console.error(`[suppression-tracker] alert callback failed: ${err.message}`);
          }
        }
        process.stderr.write(
          `[suppression-tracker] ALERT sender=${senderName} count=${counter.count} reason=${reason} window=${Math.round((now - counter.firstAt) / 1000)}s\n`
        );
      }
    }

    this.#evaluateCount += 1;
    if (this.#evaluateCount % SWEEP_INTERVAL === 0) {
      this.#sweepStale(now);
    }

    return { suppress, consecutiveCount: counter.count, suppressedCount: counter.suppressedCount, reason };
  }

  persistSuppressed(message, { context, orgLabel, source, effectiveText, reason }) {
    const entry = {
      ts: new Date().toISOString(),
      message,
      effective_text: effectiveText || null,
      context: context || null,
      org_label: orgLabel,
      source: source || null,
      marker: reason || 'unknown',
    };
    try {
      fs.appendFileSync(this.#suppressedLogPath, JSON.stringify(entry) + '\n');
    } catch (err) {
      console.error(`[suppression-tracker] suppressed message persist failed: ${err.message}`);
    }
  }

  #sweepStale(now) {
    for (const [key, counter] of this.#counters) {
      if ((now - counter.lastAt) > this.#windowMs || (now - counter.firstAt) > this.#maxLifetimeMs) {
        this.#counters.delete(key);
        this.#lastAlertAt.delete(key);
      }
    }
    for (const key of this.#lastAlertAt.keys()) {
      if (!this.#counters.has(key)) this.#lastAlertAt.delete(key);
    }
  }

  #fireRecoveryAlert(senderKey, senderName, counter, now) {
    if (this.#alertFn) {
      try {
        this.#alertFn({
          senderKey,
          senderName,
          count: counter.suppressedCount,
          windowSec: Math.round((now - counter.firstAt) / 1000),
          reason: 'recovered',
        });
      } catch (err) {
        console.error(`[suppression-tracker] recovery alert failed: ${err.message}`);
      }
    }
    process.stderr.write(
      `[suppression-tracker] RECOVERED sender=${senderName} after ${counter.suppressedCount} suppressed messages\n`
    );
    this.#lastAlertAt.delete(senderKey);
  }

  #appendLog(entry) {
    try {
      fs.appendFileSync(this.#logPath, JSON.stringify(entry) + '\n');
    } catch (err) {
      console.error(`[suppression-tracker] log write failed: ${err.message}`);
    }
  }
}
