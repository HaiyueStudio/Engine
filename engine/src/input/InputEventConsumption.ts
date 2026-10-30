// Event ownership is independent of preventDefault and of raw device state sampling.
const consumed = new WeakSet<Event>();
export function consumeInputEvent(event: Event): void { consumed.add(event); }
export function isInputEventConsumed(event: Event): boolean { return consumed.has(event); }
