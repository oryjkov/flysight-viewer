/**
 * A packet link to a FlySight's CRS (file transfer) service.
 *
 * Implemented by the real BLE transport and by the in-memory simulator, so
 * the protocol client does not care which one it talks to.
 */
export interface Link {
  /** Stable identifier used to key cached downloads. */
  readonly id: string;
  /** Human-readable device name. */
  readonly name: string;
  /** Send one packet to the device (CRS_RX). Writes are delivered in order. */
  write(data: Uint8Array): Promise<void>;
  /** Called for every packet from the device (CRS_TX notifications). */
  onPacket: ((data: Uint8Array) => void) | null;
  /** Called once when the connection drops. */
  onDisconnect: (() => void) | null;
  disconnect(): void;
}
