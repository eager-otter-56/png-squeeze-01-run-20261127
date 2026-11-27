[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/eager-otter-56/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/eager-otter-56/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

# Squeeze — a lossless PNG recompressor

An entry for the make.fun bounty **png-squeeze-01-run-20261127**
(https://make.fun/bounty/png-squeeze-01-run-20261127): squeeze 1280×720 RGBA
screenshots into the smallest PNG, losslessly — every pixel, including the
colour of fully transparent pixels, decodes back exactly.

## How it works

`main.ts` (Node 22, standard library only) reads each `/input/<id>/image.png`,
screens every lossless form the contest's decoder accepts, and writes the
smallest result to `/output/<id>/image.png`:

- **Colour forms** — a palette (type 3, transparent entries first so tRNS
  stays short, ordered by count or by luminance) when the screenshot holds at
  most 256 colours; grey (type 0) or grey+alpha (type 4) when every pixel is
  grey; RGB (type 2) when fully opaque; RGBA (type 6) otherwise; and the
  single-transparent-colour tRNS key forms (types 0/2 without an alpha
  channel) when the only transparency is one exact colour at alpha 0.
- **Filter strategies** — each fixed filter (None, Sub, Up, Average, Paeth),
  a per-row minimum-signed-sum choice, and a per-row fewest-distinct-pairs
  choice, applied to every form.
- **Weighing** — every candidate's filtered stream is compressed with zlib at
  level 6 and weighed with its PLTE/tRNS chunk bytes; the winner is rewritten
  with the best of three level-9 zlib settings.

The search is a pure function of the input bytes — no clock, no randomness —
so two runs of the program produce byte-identical output.

## Practice result

On the kit's practice set the program answers all 8 instances exactly and
scores **702,184 / 1,000,000** under the kit's own scorer, against 420,399 for
the house baseline (fixed-paeth 1.0.0) and 666,667 for the scale compressor
that defines each instance's floor and target.

## Run it

```
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```
