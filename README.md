# FlySight Viewer

Download logs from a FlySight 2 over Bluetooth, straight from the browser, and
get a quick summary of each file.

- Browse the device's SD card (date → session → `TRACK.CSV`, `SENSOR.CSV`,
  `EVENT.CSV`, `RAW.UBX`, plus config files).
- Download with progress; files are cached in the browser (IndexedDB) so they
  can be reopened later without the device, and can be saved to disk.
- Summaries: track duration, sample rate, altitude range, max speeds, GNSS
  quality; sensor record types and rates; event list; UBX message counts.

## Running

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # protocol + parser tests
npm run build      # static site in dist/
```

Web Bluetooth needs Chrome or Edge (desktop or Android) and a secure origin
(`https://` or `localhost`). On Linux, if the Connect button is disabled,
enable `chrome://flags/#enable-experimental-web-platform-features`.

### First connection: pairing

The FlySight only accepts connections from devices it has bonded with. The
first time, put it in pairing mode — from idle, press the button twice (the
green LED pulses) — then click **Connect FlySight**. The OS pairs
automatically ("Just Works", no PIN). Afterwards it connects without pairing
mode. Pairing mode ends as soon as anything connects, so a failed attempt
needs another double-press.

**Linux:** BlueZ refuses even Just Works pairing unless a pairing agent
approves it (`journalctl -u bluetooth` shows *No agent available for request
type 2*), and Chrome does not provide one. Desktop Bluetooth applets
(GNOME/KDE) do; without one, pair once with the debugging tool, then use the
page as normal:

```sh
nix develop -c python3 tools/flysight_ble.py pair auto   # device in pairing mode
```

### Debugging tool

`tools/flysight_ble.py` (bleak) speaks the same protocol from the command
line, with packet-level logging: `scan`, `pair`, `ping`, `ls`, `get`. `ADDR`
can be `auto` — the FlySight uses rotating private addresses. Measured on a
FlySight 2: ~98 KB/s, a 1.6 MB `TRACK.CSV` in 16 s.

### Without a device

**Simulate from folder…** serves a copy of the SD card (e.g. copied over USB)
through a simulator of the firmware's BLE protocol, including its flow
control. Useful for UI work. The tests also run end to end against a card
copy at `~/flysight/fly2` (or `$FLYSIGHT_DATA`) when present.

## BLE protocol (CRS)

From `flysight-2-firmware` (`FlySight/crs.c`, `STM32_WPAN/App/custom_*.c`).

| | UUID | |
|---|---|---|
| CRS service | `00000000-cc7a-482a-984a-7f2ed5b3e58f` | |
| CRS_TX | `00000001-8e22-4541-9d4c-21edae82ed19` | notify, device → host |
| CRS_RX | `00000002-8e22-4541-9d4c-21edae82ed19` | write without response |

Advertising carries manufacturer data with company ID `0x09DB` followed by one
byte: 1 in pairing mode, 0 otherwise. All characteristics require encryption.

Packets are `[cmd][payload]` (≤ 244 bytes, so the ATT MTU must be ≥ 247).
The device answers with `F1 cmd` (ACK) or `F0 cmd` (NAK).

| Cmd | | Payload |
|---|---|---|
| `05` READ_DIR | → | path |
| `11` FILE_INFO | ← | seq, size u32, FAT date u16, FAT time u16, attr u8, name[13]; empty name ends the listing |
| `02` READ | → | offset u32, stride u32 (both in 242-byte frames), path |
| `10` FILE_DATA | ← | seq, ≤ 242 bytes; no data = end of file |
| `12` FILE_ACK | → | seq |
| `fe` PING / `ff` CANCEL | → | |

Reads use go-back-N: up to 8 unacknowledged packets; after 200 ms without
progress the device resends from the first unacknowledged one. The client
acks each in-order packet (including the end-of-file packet) and drops
anything else. While reading or listing, the device ignores every command
except CANCEL. It disconnects after 30 s without a write, so the client pings
while idle. Names are FAT 8.3 (no long file names).

## Layout

```
src/ble/transport.ts   Web Bluetooth link
src/ble/crs.ts         CRS protocol client
src/ble/fakeDevice.ts  firmware simulator (tests, "Simulate from folder")
src/parse/             FlySight CSV + UBX parsing, summaries
src/storage.ts         IndexedDB cache
src/main.ts            UI
```
