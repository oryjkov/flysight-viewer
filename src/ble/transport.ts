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
      optionalServices: [CRS_SERVICE],
    });
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
