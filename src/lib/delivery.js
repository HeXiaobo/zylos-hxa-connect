// Shared realtime bookkeeping: failed handoffs must remain recoverable.
export async function deliverRealtime({ gate, state, label, id, at, deliver, retry }) {
  if (gate.isSeen(id)) return false;
  gate.begin(id);
  try {
    await deliver();
    gate.mark(id, at);
    state.scheduleSave();
    return true;
  } catch (err) {
    state.setDirty(label, true);
    state.scheduleSave();
    retry();
    throw err;
  } finally {
    gate.clear(id);
  }
}

export function shouldDeliverCatchupEvent(access, event) {
  return !(access?.groupPolicy === 'disabled' && event.type.startsWith('thread_'));
}
