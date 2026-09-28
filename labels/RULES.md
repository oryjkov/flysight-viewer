# Labelling rules

Labels mark where each jump in a FlySight track starts and ends, and what kind
of jump it was. They are the ground truth the jump classifier is measured
against, so two people following these rules on the same track should place
every marker on the same sample.

Markers describe what the **GPS velocity** shows, not what the jumper did: a
pilot chute throw is invisible in GPS, the deceleration it causes is not.

## What counts as a jump

A jump is a departure from a platform (aircraft, object, or anything else)
followed by a parachute descent. Freefall may be long, short, or absent
(hop-and-pop, low BASE with a pilot-chute assist or static line).

Not jumps: paragliding and speedflying flights, lift and cable car rides,
drives, riding the aircraft down, walking. A file with none of these gets
`jumps: []`.

A file can hold several jumps (the logger was left on between loads). Label
each one.

## Markers

Every jump has four markers, in this order:

| Marker | Phase that ends | Phase that begins |
|---|---|---|
| `exit` | on the platform | freefall |
| `deploy` | freefall | opening |
| `open` | opening | canopy flight |
| `landing` | canopy flight | ground |

### Placement convention

A marker sits on the **last sample of the phase that ends**: the last sample
that still follows the old trend (the "knee"). The next sample is the first one
of the new phase.

Markers always sit on a sample of the track; there is no interpolation between
samples. If the knee is smeared over more than about 1 s, put the marker in the
middle of the smear and mark it `unsure`.

Speeds used below: `vD` vertical speed (down is positive), `vH` horizontal
speed, `|v|` total speed.

### exit

The last sample moving with the platform.

- **Aircraft** (and other moving platforms, see below): vH is on the jump-run
  plateau (typically 35–45 m/s) and vD ≈ 0. The next sample is where vH starts
  to fall away from the aircraft's speed and/or vD starts to rise. Climbing
  out, hanging on the door and small vD wiggles while still attached count as
  aircraft.
- **Wingsuit from an aircraft**: vD rises slowly after exit, so the knee is in
  vH falling away from the aircraft plateau, not in vD. It can be several
  seconds before vD passes any freefall threshold.
- **Object**: the last sample before |v| starts rising from about 0 at roughly
  1 g. A run-up (vH 2–5 m/s, vD ≈ 0) is still on the platform; exit is where
  the vertical acceleration begins.

### deploy

The last sample of freefall flight before the drop into canopy speed: after it,
|v| falls steadily until it reaches canopy speed (≤ ~15 m/s).

Not a deploy:

- **Flares and pitch-ups** (wingsuit, tracking): vD drops — even below zero —
  but |v| stays high and vH rises. Speed is traded for height, not lost. When
  the deployment follows a flare (typical for BASE tracking jumps), `deploy` is
  after the flare, at the start of the final drop in |v|.
- **Gradual slowdowns** within freefall, e.g. going from head-down to belly or
  slowing for break-off. `deploy` is where the steep, continuous deceleration
  starts.

For a very short delay (low BASE), `deploy` is where vD stops rising.

### open

The last sample of the opening deceleration: |v| reaches its first minimum and
vD is in canopy range (below ~10 m/s).

Surges after that — line twists, brake release, the first turn, a snivel that
recovers — are canopy flight and do not move `open`.

### landing

Touchdown: the last sample before the jumper is on the ground, where vD reaches
about 0 and altitude stops falling.

- vH may keep running out for a few seconds after touchdown (sliding,
  running). That is ground; do not wait for vH to reach 0.
- After a swoop the vH surge comes before touchdown; `landing` is where vD
  reaches 0, not where vH does.
- Walking afterwards, including downhill (steady vH ≈ 1, vD ≈ 1 m/s), is
  ground.

### Missing markers

If the recording starts after the exit or stops before the landing, set that
marker to `null`. `null` means "not in the recording", never "hard to place" —
that is what `unsure` is for.

## Glitches

Single-sample spikes in speed or altitude (common at the opening shock, and in
bad-fix stretches) are GPS noise. Place markers by the trend, ignoring spikes.

## Sensor data

FlySight 2 sessions also have `SENSOR.CSV`. The labeller shows its
accelerometer and barometer readings next to the GPS. Use them as a
tie-breaker when the GPS knee is unclear; markers still go on GPS samples, on
the last GPS sample at or before the event seen in the sensor data.

What the events look like in specific force (total accelerometer magnitude):

- **exit**: drops away from ~1 g (sitting or standing on the platform). From an
  object it falls to about 0 g; from an aircraft less far, because the jumper
  still has 35–45 m/s of airspeed.
- **deploy**: the last sample before specific force rises above its freefall
  level (≈ 1 g at terminal velocity, less while still accelerating).
- **open**: the opening shock has passed and specific force has settled back to
  about 1 g.
- **landing**: the impact spike.

## Jump attributes

### platform

- `aircraft`: aeroplane or helicopter.
- `object`: building, antenna, span (bridge), earth (cliff).
- `other`: paraglider, balloon, anything else. Use the note to say what.

### discipline

The dominant mode of flight between `exit` and `deploy`, by time. Judge it by
the glide ratio (vH / vD) once the jumper is flying, not during the exit
acceleration or a flare:

- `freefall`: glide ratio below about 0.5. Belly, freefly, sit, head-down.
- `tracking`: about 0.5–1.5. Tracking, tracksuit.
- `wingsuit`: above about 1.5.

A short track for break-off at the end of a freefall jump is still `freefall`.

## Flags

Per marker:

- `unsure`: the marker can't be placed within about ±1 s. The eval leaves
  unsure markers out of timing error statistics.

Per jump:

- `cutaway`: the main was cut away. `deploy` and `open` are for the canopy that
  was landed; say what happened in the note.
- `bad-gps`: poor fix quality within the jump.

Per file:

- `bad-gps`: the whole recording is poor enough that it shouldn't be used for
  evaluation.

## File status

- `unreviewed`: pre-filled by the classifier, not yet checked by a person.
- `labelled`: checked by a person. `jumps: []` means the file has no jump.
- `skip`: deliberately not labelled (e.g. unusable file); say why in the note.

## Label file format

One JSON file per track at `labels/tracks/<sha256>.json`, where `<sha256>` is
the SHA-256 of the track file's bytes as written by the FlySight. Types and the
validator are in `src/labels/schema.ts`.

Times are UTC ISO 8601 with milliseconds (`2026-09-26T13:58:36.700Z`) and must
match the time of a sample in the track. FlySight 1 writes centiseconds
(`08:18:48.10Z`); those are normalised to `08:18:48.100Z`.

```jsonc
{
  "schema": 1,
  "sha256": "3f9a…c1",
  "source": "fly2/26-09-26/13-34-06/TRACK.CSV",
  "status": "labelled",
  "jumps": [
    {
      "platform": "aircraft",
      "discipline": "wingsuit",
      "exit":    { "t": "2026-09-26T13:58:36.700Z" },
      "deploy":  { "t": "2026-09-26T14:01:12.300Z" },
      "open":    { "t": "2026-09-26T14:01:16.100Z", "unsure": true },
      "landing": { "t": "2026-09-26T14:05:00.200Z" },
      "flags": [],
      "note": ""
    }
  ],
  "flags": [],
  "note": "",
  "prefill": {
    "classifier": "0.1.0",
    "jumps": [ /* the classifier's markers, same shape as jumps */ ]
  },
  "labelledBy": "olegr",
  "updatedAt": "2026-09-28T12:00:00.000Z"
}
```

- `source` is the path relative to the data root when the file was labelled.
  It is informational; the hash is the identity.
- `prefill` keeps what the classifier suggested, so corrections can be measured
  even after the classifier changes.
