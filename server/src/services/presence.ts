/**
 * Who is connected, and on which socket.
 *
 * Enforces one live socket per user. The old code kept a plain
 * socketId -> userId map, so opening a second tab produced two sockets for the
 * same user; since pairing state is keyed by userId, the second tab would
 * silently hijack the first one's chat and disconnecting either would tear
 * down state belonging to the other. Here a new connection explicitly evicts
 * the old one and the caller is told which socket to close.
 */
export interface PresenceRecord {
  userId: string;
  socketId: string;
  connectedAt: number;
  lastActivityAt: number;
}

export class PresenceRegistry {
  private byUser = new Map<string, PresenceRecord>();
  private bySocket = new Map<string, PresenceRecord>();

  /**
   * Register a connection.
   * @returns the socket id that was displaced, if this user was already online.
   */
  register(userId: string, socketId: string, now: number = Date.now()): string | null {
    const previous = this.byUser.get(userId);
    let evicted: string | null = null;

    if (previous && previous.socketId !== socketId) {
      evicted = previous.socketId;
      this.bySocket.delete(previous.socketId);
    }

    const record: PresenceRecord = {
      userId,
      socketId,
      connectedAt: now,
      lastActivityAt: now,
    };
    this.byUser.set(userId, record);
    this.bySocket.set(socketId, record);
    return evicted;
  }

  /**
   * Remove a socket. A late teardown from an already-evicted socket must not
   * clear the record belonging to the user's newer connection, so the user
   * index is only cleared when it still points at this exact socket.
   */
  unregister(socketId: string): PresenceRecord | null {
    const record = this.bySocket.get(socketId);
    if (!record) return null;

    this.bySocket.delete(socketId);
    const current = this.byUser.get(record.userId);
    if (current && current.socketId === socketId) {
      this.byUser.delete(record.userId);
    }
    return record;
  }

  socketOf(userId: string): string | null {
    return this.byUser.get(userId)?.socketId ?? null;
  }

  userOf(socketId: string): string | null {
    return this.bySocket.get(socketId)?.userId ?? null;
  }

  isOnline(userId: string): boolean {
    return this.byUser.has(userId);
  }

  /** True only if this exact socket is the user's current one. */
  isCurrentSocket(userId: string, socketId: string): boolean {
    return this.byUser.get(userId)?.socketId === socketId;
  }

  touch(socketId: string, now: number = Date.now()): void {
    const record = this.bySocket.get(socketId);
    if (record) record.lastActivityAt = now;
  }

  /** Distinct users online — not socket count. */
  get onlineCount(): number {
    return this.byUser.size;
  }

  get socketCount(): number {
    return this.bySocket.size;
  }

  onlineUserIds(): string[] {
    return [...this.byUser.keys()];
  }

  clear(): void {
    this.byUser.clear();
    this.bySocket.clear();
  }
}

export const presence = new PresenceRegistry();
