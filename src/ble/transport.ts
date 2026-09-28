import type { Link } from './link';

// UUIDs from flysight-2-firmware STM32_WPAN/App/custom_stm.c
export const CRS_SERVICE = '00000000-cc7a-482a-984a-7f2ed5b3e58f';
export const CRS_TX = '00000001-8e22-4541-9d4c-21edae82ed19';
export const CRS_RX = '00000002-8e22-4541-9d4c-21edae82ed19';

/** Bluetooth SIG company identifier in the FlySight's manufacturer data. */
export const FLYSIGHT_COMPANY_ID = 0x09db;

export function isWebBluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

export class BleLink implements Link {
  onPacket: ((data: Uint8Array) => void) | null = null;
  onDisconnect: (() => void) | null = null;
  battery: number | null | undefined = undefined;
  onBattery: (() => void) | null = null;

  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly device: BluetoothDevice,
    private readonly rx: BluetoothRemoteGATTCharacteristic,
    private readonly tx: BluetoothRemoteGATTCharacteristic,
  ) {}

  get id(): string {
    return this.device.id;
  }

  get name(): string {
    return this.device.name || 'FlySight';
  }

  /** Show the browser's device chooser and connect to the selected FlySight. */
  static async request(): Promise<BleLink> {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ manufacturerData: [{ companyIdentifier: FLYSIGHT_COMPANY_ID }] }],
      optionalServices: [CRS_SERVICE, 'battery_service'],
    });
    return BleLink.connect(device);
  }

  /**
   * Reconnect to a FlySight this site was allowed to use before, without the
   * device chooser. Returns null when the browser can't (no `getDevices`, or
   * the permission is gone). Waits until the FlySight is heard advertising —
   * it may not be yet, or be out of range — and rejects when `signal` aborts.
   */
  static async reconnect(deviceId: string, signal: AbortSignal): Promise<BleLink | null> {
    if (!navigator.bluetooth.getDevices) return null;
    const device = (await navigator.bluetooth.getDevices()).find((d) => d.id === deviceId);
    signal.throwIfAborted();
    if (!device) return null;
    await waitForAdvertisement(device, signal);
    signal.throwIfAborted();
    return BleLink.connect(device);
  }

  static async connect(device: BluetoothDevice): Promise<BleLink> {
    if (!device.gatt) throw new Error('Device has no GATT server');
    const server = await device.gatt.connect();
    try {
      const service = await server.getPrimaryService(CRS_SERVICE);
      const tx = await service.getCharacteristic(CRS_TX);
      const rx = await service.getCharacteristic(CRS_RX);
      const link = new BleLink(device, rx, tx);
      tx.addEventListener('characteristicvaluechanged', link.handleValue);
      device.addEventListener('gattserverdisconnected', link.handleDisconnect);
      // The characteristics require an encrypted link, so this is where the
      // OS pairs with the FlySight if it has not already.
      await tx.startNotifications();
      await link.watchBattery(server);
      return link;
    } catch (e) {
      server.disconnect();
      throw e;
    }
  }

  write(data: Uint8Array): Promise<void> {
    // Chrome rejects overlapping GATT operations, and the protocol relies on
    // acknowledgements arriving in order, so writes are chained.
    const p = this.writeChain.then(() =>
      this.rx.writeValueWithoutResponse(data as Uint8Array<ArrayBuffer>),
    );
    this.writeChain = p.catch(() => {});
    return p;
  }

  disconnect(): void {
    this.device.gatt?.disconnect();
  }

  /**
   * Standard Battery Service (develop firmware): read the level and follow
   * its notifications. Absent on release firmware, and not allowed for a
   * FlySight that was chosen before the app asked for it — both just leave
   * `battery` undefined.
   */
  private async watchBattery(server: BluetoothRemoteGATTServer): Promise<void> {
    try {
      const service = await server.getPrimaryService('battery_service');
      const level = await service.getCharacteristic('battery_level');
      level.addEventListener('characteristicvaluechanged', () => {
        if (level.value) this.setBattery(level.value.getUint8(0));
      });
      this.setBattery((await level.readValue()).getUint8(0));
      await level.startNotifications();
    } catch {
      // No battery readout; everything else works.
    }
  }

  /** The firmware reports 0 until it has measured the battery (in active mode). */
  private setBattery(percent: number): void {
    this.battery = percent === 0 ? null : percent;
    this.onBattery?.();
  }

  private handleValue = (event: Event): void => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value) return;
    const packet = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    this.onPacket?.(packet);
  };

  private handleDisconnect = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.tx.removeEventListener('characteristicvaluechanged', this.handleValue);
    this.device.removeEventListener('gattserverdisconnected', this.handleDisconnect);
    this.onDisconnect?.();
  };
}

/**
 * Resolve once the device is heard advertising.
 * Where the browser can't watch advertisements, resolve straight away and let
 * the connection attempt find out.
 */
async function waitForAdvertisement(device: BluetoothDevice, signal: AbortSignal): Promise<void> {
  // An abort that already happened won't fire its event again.
  signal.throwIfAborted();
  if (!device.watchAdvertisements) return;
  const watch = new AbortController();
  const stop = () => watch.abort();
  signal.addEventListener('abort', stop);
  try {
    await new Promise<void>((resolve, reject) => {
      device.addEventListener('advertisementreceived', () => resolve(), { once: true, signal: watch.signal });
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      device.watchAdvertisements({ signal: watch.signal }).catch(() => resolve());
    });
  } finally {
    signal.removeEventListener('abort', stop);
    watch.abort();
  }
}
