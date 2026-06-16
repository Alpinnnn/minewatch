export type EventType =
  | 'SERVER_DOWN'
  | 'SERVER_UP'
  | 'HIGH_PING'
  | 'PING_NORMALIZED'
  | 'LOW_TPS'
  | 'TPS_NORMALIZED'
  | 'PLAYER_JOIN'
  | 'PLAYER_LEAVE';

export interface MinewatchEvent {
  type: EventType;
  timestamp: Date;
  payload: Record<string, unknown>;
}

type Listener = (e: MinewatchEvent) => void | Promise<void>;

class EventBus {
  private listeners: Map<EventType, Set<Listener>> = new Map();

  on(type: EventType, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  async emit(event: MinewatchEvent): Promise<void> {
    const set = this.listeners.get(event.type);
    if (!set || set.size === 0) return;
    for (const fn of set) {
      try {
        await fn(event);
      } catch (err) {
        // Never let a single listener kill the bus.
        // eslint-disable-next-line no-console
        console.error(`[event-bus] listener for ${event.type} threw:`, err);
      }
    }
  }
}

export const bus = new EventBus();
