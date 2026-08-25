# Sabotage sounds

These play out of the **victim room's** table PC speakers.

## The files that ship here

The `.wav` files in this folder are **synthesised placeholders** so the system
makes noise the moment you start it. They are crude on purpose — an oscillator's
idea of an air horn. Replace them with real recordings before you run this for
paying customers.

## Using your own

1. Drop the file in this folder (`.mp3`, `.wav`, `.ogg`, and `.m4a` all work).
2. Add or edit an entry in the VS server's `config.json`:

```json
"sounds": [
  { "id": "airhorn", "label": "Air Horn", "file": "airhorn.mp3" }
]
```

- `id` is what the server and soundboard use internally — keep it stable.
- `label` is the button text on the soundboard, so write it for players.
- `file` is the filename here, exactly.

Restart the VS server and reload the tables.

## What makes a good one

- **Two to five seconds.** The Annoying Noise sabotage fires one and it needs to
  land and be over. Anything longer stops being funny and starts drowning out
  the game.
- **Loud and mid-range.** It has to carry across a room over whatever ambient
  soundtrack the escape room already runs.
- **Recognisable in the first half second.** The joke is the reaction, and the
  reaction happens immediately.
- **Eight to twelve of them.** The soundboard sabotage gives a team 60 seconds
  of free rein, and they will use all of it.

Keep files reasonably small — every table preloads all of them at startup so a
sabotage never waits on a disk read.

## Licensing

Check the licence on anything you download. Freesound.org and Pixabay both have
usable libraries; a commercial escape room is a commercial use, so avoid
anything with a non-commercial restriction.
