import { afterEach, describe, expect, it, vi } from 'vitest';
import { BleLink, CRS_SERVICE } from '../src/ble/transport';

/** Minimal stand-in for a Web Bluetooth device that can advertise and connect. */
function fakeDevice(id: string, opts: { watch?: boolean } = {}) {
  const target = new EventTarget();
  const characteristic = () =>
    Object.assign(new EventTarget(), {
      startNotifications: vi.fn(async () => {}),
      writeValueWithoutResponse: vi.fn(async () => {}),
    });
  const server = {
    getPrimaryService: vi.fn(async (uuid: string) => {
      expect(uuid).toBe(CRS_SERVICE);
      return { getCharacteristic: vi.fn(async () => characteristic()) };
    }),
    disconnect: vi.fn(),
  };
  const device = Object.assign(target, {
    id,
    name: 'FlySight 2',
    gatt: { connect: vi.fn(async () => server), disconnect: vi.fn() },
    watchAdvertisements: opts.watch === false ? undefined : vi.fn(async () => {}),
    advertise: () => target.dispatchEvent(new Event('advertisementreceived')),
  });
  return device;
}

function installBluetooth(devices: ReturnType<typeof fakeDevice>[] | null) {
  vi.stubGlobal('navigator', {
    bluetooth: devices ? { getDevices: vi.fn(async () => devices) } : {},
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('reconnecting to the remembered FlySight', () => {
  it('gives up (null) when the browser has no getDevices or forgot the device', async () => {
    installBluetooth(null);
    expect(await BleLink.reconnect('a', new AbortController().signal)).toBeNull();
    installBluetooth([fakeDevice('b')]);
    expect(await BleLink.reconnect('a', new AbortController().signal)).toBeNull();
  });

  it('waits for the FlySight to advertise, then connects', async () => {
    const device = fakeDevice('a');
    installBluetooth([device]);
    const pending = BleLink.reconnect('a', new AbortController().signal);
    await new Promise((r) => setTimeout(r, 10));
    expect(device.gatt.connect).not.toHaveBeenCalled();
    device.advertise();
    const link = await pending;
    expect(link?.id).toBe('a');
    expect(device.gatt.connect).toHaveBeenCalledOnce();
  });

  it('connects straight away where advertisements cannot be watched', async () => {
    const device = fakeDevice('a', { watch: false });
    installBluetooth([device]);
    expect((await BleLink.reconnect('a', new AbortController().signal))?.name).toBe('FlySight 2');
  });

  it('stops looking when aborted', async () => {
    const device = fakeDevice('a');
    installBluetooth([device]);
    const controller = new AbortController();
    const pending = BleLink.reconnect('a', controller.signal);
    controller.abort(new DOMException('Chose another', 'AbortError'));
    await expect(pending).rejects.toThrow('Chose another');
    expect(device.gatt.connect).not.toHaveBeenCalled();
  });
});
