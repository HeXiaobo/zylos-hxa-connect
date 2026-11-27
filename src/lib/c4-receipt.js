/**
 * C4 reply receipt for the HXA-Connect channel.
 *
 * c4-send spawns this channel with a per-call token in
 * `ZYLOS_REPLY_RECEIPT_TOKEN`; the `C4_RECEIPT` line is what turns an
 * outbound row from `delivery_unconfirmed` into a proven reply. The hub
 * returns the created message id for both the DM (`send`) and thread
 * (`sendThreadMessage`) paths, so both can prove delivery.
 *
 * One c4-send call sends one message on this channel, so a single id is
 * enough. Later ids are ignored, keeping one receipt per call.
 */
export const RECEIPT_PREFIX = 'C4_RECEIPT ';

export function createReplyReceipt({ token = '', print = (line) => console.log(line) } = {}) {
  let messageId = null;

  function note(result) {
    if (messageId) return messageId;
    const id = result?.message?.id ?? result?.id;
    if (typeof id === 'string' && id.trim() && !/[\r\n]/.test(id) && id.length <= 512) {
      messageId = id;
    }
    return messageId;
  }

  function emit() {
    if (!token || !messageId) return null;
    const line = RECEIPT_PREFIX + JSON.stringify({ receiptToken: token, platformMessageId: messageId });
    print(line);
    return line;
  }

  return {
    note,
    emit,
    get messageId() { return messageId; },
  };
}
