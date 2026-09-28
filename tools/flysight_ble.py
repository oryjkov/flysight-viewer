#!/usr/bin/env python3
"""
FlySight 2 BLE / CRS debugging tool (bleak, BlueZ).

Mirrors what the web page does, one step at a time, with verbose logging so
connection and pairing problems are visible.

    flysight_ble.py scan
    flysight_ble.py status ADDR          # BlueZ paired/bonded/trusted state
    flysight_ble.py pair ADDR            # connect + explicit pairing (device in pairing mode)
    flysight_ble.py ping ADDR [--pair]
    flysight_ble.py ls ADDR [PATH]
    flysight_ble.py get ADDR PATH [OUT]

Run from the repo root:  nix develop -c python3 tools/flysight_ble.py scan
"""

import argparse
import asyncio
import struct
import subprocess
import sys
import time

from bleak import BleakClient, BleakScanner
from bleak.exc import BleakError
from dbus_fast import BusType
from dbus_fast.aio import MessageBus
from dbus_fast.service import ServiceInterface, method

CRS_SERVICE = "00000000-cc7a-482a-984a-7f2ed5b3e58f"
CRS_TX = "00000001-8e22-4541-9d4c-21edae82ed19"  # notify, device -> host
CRS_RX = "00000002-8e22-4541-9d4c-21edae82ed19"  # write without response
COMPANY_ID = 0x09DB

READ, READ_DIR, FILE_DATA, FILE_INFO, FILE_ACK = 0x02, 0x05, 0x10, 0x11, 0x12
NAK, ACK, PING, CANCEL = 0xF0, 0xF1, 0xFE, 0xFF

T0 = time.monotonic()


def log(*args):
    print(f"[{time.monotonic() - T0:7.3f}]", *args, flush=True)


# --------------------------------------------------------------------- scan

async def cmd_scan(args):
    log(f"scanning {args.timeout}s for manufacturer id 0x{COMPANY_ID:04x}")
    found = {}

    def on_adv(dev, adv):
        mfg = adv.manufacturer_data.get(COMPANY_ID)
        if mfg is None:
            return
        # app_ble.c: manufacturer data is one byte, the pairing-mode flag
        pairing = mfg[0] if mfg else None
        key = (dev.address, pairing)
        if key not in found:
            found[key] = True
            log(f"{dev.address}  rssi={adv.rssi}  name={adv.local_name!r}  "
                f"mfg={mfg.hex()}  pairing_mode={bool(pairing)}")

    async with BleakScanner(on_adv):
        await asyncio.sleep(args.timeout)
    if not found:
        log("no FlySight seen")


# -------------------------------------------------------------------- agent

AGENT_PATH = "/flysight/agent"


class AutoAcceptAgent(ServiceInterface):
    """
    BlueZ refuses even Just Works pairing unless a pairing agent approves it
    ("No agent available for request type 2"). Desktop Bluetooth applets
    provide one; Chrome's Web Bluetooth does not. This one approves everything.
    """

    def __init__(self):
        super().__init__("org.bluez.Agent1")

    @method()
    def Release(self):
        log("agent: Release")

    @method()
    def RequestAuthorization(self, device: "o"):  # noqa: F821
        log(f"agent: RequestAuthorization {device} -> accept")

    @method()
    def RequestConfirmation(self, device: "o", passkey: "u"):  # noqa: F821
        log(f"agent: RequestConfirmation {device} {passkey:06d} -> accept")

    @method()
    def AuthorizeService(self, device: "o", uuid: "s"):  # noqa: F821
        log(f"agent: AuthorizeService {device} {uuid} -> accept")

    @method()
    def Cancel(self):
        log("agent: Cancel")


async def register_agent() -> MessageBus:
    bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
    bus.export(AGENT_PATH, AutoAcceptAgent())
    intro = await bus.introspect("org.bluez", "/org/bluez")
    manager = bus.get_proxy_object("org.bluez", "/org/bluez", intro).get_interface("org.bluez.AgentManager1")
    await manager.call_register_agent(AGENT_PATH, "NoInputNoOutput")
    await manager.call_request_default_agent(AGENT_PATH)
    log("pairing agent registered (NoInputNoOutput, auto-accept)")
    return bus


# ------------------------------------------------------------------- status

def cmd_status(args):
    out = subprocess.run(["bluetoothctl", "info", args.addr], capture_output=True, text=True)
    print(out.stdout or out.stderr)


# ------------------------------------------------------------------- client

class Crs:
    def __init__(self, client: BleakClient):
        self.client = client
        self.queue: asyncio.Queue[bytes] = asyncio.Queue()
        self.verbose_packets = True

    async def start(self):
        def on_notify(_char, data: bytearray):
            if self.verbose_packets:
                log(f"  <- {bytes(data[:16]).hex()}{'…' if len(data) > 16 else ''} ({len(data)} B)")
            self.queue.put_nowait(bytes(data))

        log("start_notify(CRS_TX) — first encrypted access, pairing happens here if needed")
        await self.client.start_notify(CRS_TX, on_notify)
        log("notifications enabled")

    async def send(self, data: bytes):
        if self.verbose_packets:
            log(f"  -> {data[:16].hex()}{'…' if len(data) > 16 else ''} ({len(data)} B)")
        await self.client.write_gatt_char(CRS_RX, data, response=False)

    async def recv(self, timeout=5.0) -> bytes:
        return await asyncio.wait_for(self.queue.get(), timeout)

    async def expect_ack(self, cmd: int):
        while True:
            p = await self.recv()
            if len(p) >= 2 and p[1] == cmd and p[0] in (ACK, NAK):
                if p[0] == NAK:
                    raise RuntimeError(f"NAK for command 0x{cmd:02x}")
                return

    async def ping(self):
        await self.send(bytes([PING]))
        await self.expect_ack(PING)

    async def ls(self, path: str):
        await self.send(bytes([READ_DIR]) + path.encode() + b"\0")
        await self.expect_ack(READ_DIR)
        entries = []
        while True:
            p = await self.recv()
            if p[0] != FILE_INFO or len(p) < 24:
                continue
            size, fdate, ftime, attr = struct.unpack_from("<IHHB", p, 2)
            name = p[11:24].split(b"\0")[0].decode("latin1")
            if not name:
                return entries
            if name in (".", ".."):
                continue
            y, mo, d = 1980 + (fdate >> 9), (fdate >> 5) & 15, fdate & 31
            h, mi, s = ftime >> 11, (ftime >> 5) & 63, (ftime & 31) * 2
            entries.append((name, size, attr, f"{y}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}"))

    async def get(self, path: str) -> bytes:
        self.verbose_packets = False
        await self.send(bytes([READ]) + struct.pack("<II", 0, 0) + path.encode() + b"\0")
        await self.expect_ack(READ)
        out = bytearray()
        expected = 0
        t = time.monotonic()
        last_report = t
        while True:
            p = await self.recv()
            if p[0] != FILE_DATA or len(p) < 2 or p[1] != (expected & 0xFF):
                continue
            await self.send(bytes([FILE_ACK, p[1]]))
            expected += 1
            if len(p) == 2:
                break
            out += p[2:]
            now = time.monotonic()
            if now - last_report > 1:
                last_report = now
                log(f"  {len(out)} B, {len(out) / (now - t) / 1024:.1f} KB/s")
        dt = time.monotonic() - t
        log(f"received {len(out)} B in {dt:.1f}s ({len(out) / dt / 1024:.1f} KB/s)")
        self.verbose_packets = True
        return bytes(out)


async def find_flysight(addr: str, pairing_only: bool):
    """ADDR, or "auto" for the first FlySight advertising (addresses rotate)."""
    if addr != "auto":
        return await BleakScanner.find_device_by_address(addr, timeout=10)

    def match(_d, adv):
        mfg = adv.manufacturer_data.get(COMPANY_ID)
        return mfg is not None and (not pairing_only or mfg[:1] == b"\x01")

    return await BleakScanner.find_device_by_filter(match, timeout=10)


async def with_client(args, fn):
    agent_bus = await register_agent() if getattr(args, "pair", False) else None
    try:
        return await _with_client(args, fn)
    finally:
        if agent_bus:
            agent_bus.disconnect()


async def _with_client(args, fn):
    pairing = getattr(args, "pair", False)
    log(f"looking for {args.addr}{' in pairing mode' if pairing else ''}")
    dev = await find_flysight(args.addr, pairing)
    if dev is None:
        log("not found while scanning (out of range, or connected elsewhere?)")
        return 1

    def on_disconnect(_c):
        log("*** DISCONNECTED ***")

    client = BleakClient(dev, disconnected_callback=on_disconnect)
    log(f"connecting to {dev.address}")
    await client.connect()
    log(f"connected, mtu={client.mtu_size}")
    try:
        if getattr(args, "pair", False):
            log("pairing (explicit)")
            await client.pair()
            log("pair() returned")
        svc = client.services.get_service(CRS_SERVICE)
        log(f"CRS service: {'found' if svc else 'MISSING'}")
        for c in svc.characteristics if svc else []:
            log(f"  {c.uuid} {c.properties} max_write={c.max_write_without_response_size}")
        crs = Crs(client)
        await crs.start()
        return await fn(crs)
    finally:
        if client.is_connected:
            await client.disconnect()
        log("done")


async def cmd_ping(args):
    async def run(crs: Crs):
        await crs.ping()
        log("PING acknowledged — link works")
    return await with_client(args, run)


async def cmd_ls(args):
    async def run(crs: Crs):
        for name, size, attr, mod in await crs.ls(args.path):
            kind = "d" if attr & 0x10 else "-"
            print(f"{kind} {size:>10}  {mod}  {name}")
    return await with_client(args, run)


async def cmd_get(args):
    async def run(crs: Crs):
        data = await crs.get(args.path)
        out = args.out or args.path.strip("/").replace("/", "_")
        with open(out, "wb") as f:
            f.write(data)
        log(f"wrote {out}")
    return await with_client(args, run)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("scan"); p.add_argument("--timeout", type=float, default=8)
    p = sub.add_parser("status"); p.add_argument("addr")
    p = sub.add_parser("pair"); p.add_argument("addr")
    p = sub.add_parser("ping"); p.add_argument("addr"); p.add_argument("--pair", action="store_true")
    p = sub.add_parser("ls"); p.add_argument("addr"); p.add_argument("path", nargs="?", default="/")
    p.add_argument("--pair", action="store_true")
    p = sub.add_parser("get"); p.add_argument("addr"); p.add_argument("path"); p.add_argument("out", nargs="?")
    p.add_argument("--pair", action="store_true")
    args = ap.parse_args()

    if args.cmd == "status":
        return cmd_status(args)
    if args.cmd == "pair":
        args.pair = True
        args.cmd = "ping"
    fn = {"scan": cmd_scan, "ping": cmd_ping, "ls": cmd_ls, "get": cmd_get}[args.cmd]
    try:
        return asyncio.run(fn(args))
    except (BleakError, asyncio.TimeoutError, RuntimeError) as e:
        log(f"ERROR: {type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main() or 0)
