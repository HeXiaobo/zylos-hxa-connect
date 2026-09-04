export function createAlertFn({ suppressionEnabled, sendToC4, c4Endpoint, label, C4_CHANNEL, lp }) {
  return ({ senderKey, senderName, count, windowSec, reason }) => {
    const reasonTag = reason === 'recovered' ? 'RECOVERED' : 'ALERT';
    const modeTag = suppressionEnabled ? '' : ' [SHADOW]';
    const msg = reason === 'recovered'
      ? `[suppression-recovered${modeTag}] ${senderName} (${senderKey}) resumed substantive messages after ${count} suppressed in ${windowSec}s`
      : `[suppression-alert${modeTag}] ${count} consecutive non-substantive messages from ${senderName} (${senderKey}) in ${windowSec}s reason=${reason} — review suppression-log.jsonl`;
    if (!suppressionEnabled) {
      console.log(`${lp} would-alert (shadow): ${msg}`);
    }
    sendToC4(C4_CHANNEL, c4Endpoint(label, 'admin'), msg, {
      deliveryId: `hxa:${label}:suppression-${suppressionEnabled ? '' : 'shadow-'}${reasonTag.toLowerCase()}:${Date.now()}`,
    }).catch(err => console.error(`${lp} suppression ${reasonTag.toLowerCase()} send failed: ${err.message}`));
  };
}
