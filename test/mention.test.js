/**
 * Tests for thread @mention detection (src/lib/mention.js) and its effect on
 * the thread delivery policy (src/lib/delivery.js).
 *
 * Regression under test: thread messages that the hub marked as a mention of us
 * (`mentions: [{ bot_id, name }]`) were dropped when the configured
 * `agent_name` did not appear as `@<agent_name>` in the text. The delivery
 * pipeline now treats a `mentions[]` entry carrying our own agent_id as a real
 * mention, so mention-mode threads deliver instead of silently buffering.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isThreadMentioned, mentionsSelf, extractMentionText } from '../src/lib/mention.js';
import { decideThreadDelivery, DELIVER, SKIP } from '../src/lib/delivery.js';

const SELF_ID = 'bot-self-0001';
const OTHER_ID = 'bot-other-0002';
const AGENT_NAME = 'amy-sales';          // what config.json says
const HUB_NAME = 'Amy · Sales Ops';      // what the hub renders in the text

/** Wire message as the hub sends it (SDK WireThreadMessage shape). */
function wireMessage(overrides = {}) {
  return {
    id: 'msg-1',
    thread_id: 'thread-1',
    sender_id: OTHER_ID,
    sender_name: 'Bob Bot',
    content: '',
    content_type: 'text',
    parts: [],
    mentions: [],
    mention_all: false,
    metadata: null,
    created_at: Date.now(),
    ...overrides,
  };
}

describe('mention detection — mentions[] carries our own bot_id', () => {
  it('counts a mention when mentions[].bot_id is us, even though the text uses a different name', () => {
    const message = wireMessage({
      content: `@${HUB_NAME} 帮忙看下这个报表`,
      mentions: [{ bot_id: SELF_ID, name: HUB_NAME }],
    });
    // The text-only heuristic (previous behaviour) does NOT match here:
    assert.ok(!message.content.toLowerCase().includes(`@${AGENT_NAME}`));

    assert.equal(isThreadMentioned({ message, agentId: SELF_ID, agentName: AGENT_NAME }), true);
  });

  it('counts a mention when our bot_id is among several mentioned bots', () => {
    const message = wireMessage({
      content: '@Amy @Bob please sync',
      mentions: [
        { bot_id: OTHER_ID, name: 'Bob' },
        { bot_id: SELF_ID, name: HUB_NAME },
      ],
    });
    assert.equal(isThreadMentioned({ message, agentId: SELF_ID, agentName: AGENT_NAME }), true);
  });

  it('does not count a mention when mentions[] names someone else and the text does not match', () => {
    const message = wireMessage({
      content: `@${HUB_NAME} 帮忙看下`,
      mentions: [{ bot_id: OTHER_ID, name: HUB_NAME }],
    });
    assert.equal(isThreadMentioned({ message, agentId: SELF_ID, agentName: AGENT_NAME }), false);
  });

  it('still counts a mention when only the text matches (unchanged behaviour)', () => {
    const message = wireMessage({ content: `@${AGENT_NAME} ping` });
    assert.equal(isThreadMentioned({ message, agentId: SELF_ID, agentName: AGENT_NAME }), true);
  });

  it('ignores an empty or missing own agent id instead of matching loosely', () => {
    const message = wireMessage({ mentions: [{ bot_id: SELF_ID, name: HUB_NAME }] });
    assert.equal(isThreadMentioned({ message, agentId: null, agentName: AGENT_NAME }), false);
    assert.equal(isThreadMentioned({ message, agentId: undefined, agentName: AGENT_NAME }), false);
    assert.equal(isThreadMentioned({ message, agentId: '', agentName: AGENT_NAME }), false);
  });

  it('tolerates malformed mentions entries', () => {
    const message = wireMessage({
      content: 'hello',
      mentions: [null, {}, { name: HUB_NAME }, { bot_id: null }],
    });
    assert.equal(isThreadMentioned({ message, agentId: SELF_ID, agentName: AGENT_NAME }), false);
  });

  it('mentions self check does not use the name field', () => {
    // Name matches ours but the id does not: the name is not the identity.
    assert.equal(mentionsSelf([{ bot_id: OTHER_ID, name: AGENT_NAME }], SELF_ID), false);
    assert.equal(mentionsSelf([{ bot_id: SELF_ID, name: OTHER_ID }], SELF_ID), true);
  });
});

describe('mention detection — mention_all behaviour unchanged', () => {
  it('mention_all=true counts as a mention with no text match and no mentions[]', () => {
    const message = wireMessage({ content: 'everyone please review', mention_all: true });
    assert.equal(isThreadMentioned({ message, agentId: SELF_ID, agentName: AGENT_NAME }), true);
  });

  it('mention_all=true counts as a mention even when we are not in mentions[]', () => {
    const message = wireMessage({
      content: '@all review',
      mentions: [{ bot_id: OTHER_ID, name: 'Bob' }],
      mention_all: true,
    });
    assert.equal(isThreadMentioned({ message, agentId: SELF_ID, agentName: AGENT_NAME }), true);
  });

  it('mention_all=false with no other signal is not a mention', () => {
    const message = wireMessage({ content: 'just chatting', mention_all: false });
    assert.equal(isThreadMentioned({ message, agentId: SELF_ID, agentName: AGENT_NAME }), false);
  });
});

describe('mention detection — text sources', () => {
  it('searches part contents, image alt, file names and link titles', () => {
    const message = wireMessage({
      parts: [
        { type: 'markdown', content: `@${AGENT_NAME} summary` },
        { type: 'image', alt: `@${AGENT_NAME} chart` },
        { type: 'file', name: `report-@${AGENT_NAME}.pdf` },
        { type: 'link', title: `cc @${AGENT_NAME}` },
      ],
    });
    const text = extractMentionText(message);
    assert.ok(text.includes(`@${AGENT_NAME} summary`));
    assert.ok(text.includes('chart'));
    assert.ok(text.includes('report-'));
    assert.ok(text.includes('cc'));
  });

  it('escapes regex metacharacters in the configured agent name', () => {
    const message = wireMessage({ content: 'hi @a+b.sales there' });
    assert.equal(isThreadMentioned({ message, agentId: SELF_ID, agentName: 'a+b.sales' }), true);
    // Unescaped, 'a+b.sales' would match 'aab.sales' / 'axb.sales'.
    assert.equal(isThreadMentioned({ message, agentId: SELF_ID, agentName: 'aab.sales' }), false);
    assert.equal(isThreadMentioned({ message, agentId: SELF_ID, agentName: 'axb.sales' }), false);
  });
});

describe('thread delivery policy — mention mode uses the new signal', () => {
  const access = { groupPolicy: 'open' };

  function decide(message, mention) {
    return decideThreadDelivery({
      access,
      isSelf: () => false,
      message,
      threadId: 'thread-1',
      sender: 'Bob Bot',
      reason: 'message',
      mode: 'mention',
      isMention: mention,
      catchup: false,
      takeRateToken: () => true,
    });
  }

  it('delivers when mentions[] contains us but the text does not match @agent_name', () => {
    const message = wireMessage({
      content: `@${HUB_NAME} 看下这个`,
      mentions: [{ bot_id: SELF_ID, name: HUB_NAME }],
    });
    const mention = isThreadMentioned({ message, agentId: SELF_ID, agentName: AGENT_NAME });
    assert.equal(decide(message, mention).verdict, DELIVER);
  });

  it('skips when neither mentions[] nor the text mentions us', () => {
    const message = wireMessage({
      content: 'unrelated chatter',
      mentions: [{ bot_id: OTHER_ID, name: 'Bob' }],
    });
    const mention = isThreadMentioned({ message, agentId: SELF_ID, agentName: AGENT_NAME });
    assert.equal(decide(message, mention).verdict, SKIP);
    assert.equal(decide(message, mention).reason, 'not-mentioned');
  });

  it('delivers mention_all with an empty mentions[] as before', () => {
    const message = wireMessage({ content: 'all hands', mention_all: true });
    const mention = isThreadMentioned({ message, agentId: SELF_ID, agentName: AGENT_NAME });
    assert.equal(decide(message, mention).verdict, DELIVER);
  });
});
