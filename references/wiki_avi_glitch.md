# AVI Glitch / Null Frame Technique

The original, low-tech datamosh method — predating dedicated software —
worked directly on AVI container files in a hex editor.

## The technique

Classic AVI (and some early MPEG containers) store frames more or less
sequentially with relatively simple, well-documented chunk headers. The
"AVI glitch" technique exploits that simplicity:

1. Open an AVI file in a hex editor (or a byte-level scripting tool).
2. Locate the frame headers that mark **keyframes** (`I` frames) versus
   delta frames.
3. Either delete the keyframe data while leaving its header/chunk
   structure intact, or overwrite a keyframe chunk with a "null frame" —
   a chunk that signals "no change" or duplicates the previous delta.
4. The result: when the file is played back, the decoder reaches a point
   where it expects a fresh reference image but finds none (or finds a
   repeat), so all subsequent delta frames keep applying their
   motion/residual data to an increasingly stale or absent reference.

This is conceptually identical to what `ffmpeg_datamosh.py` does
programmatically — strip or duplicate keyframes — but done by hand,
chunk by chunk, with no codec-aware tooling. It only works reliably on
formats whose frame data isn't itself a fragile entropy-coded bitstream,
which is why classic AVI/MJPEG and early DV formats were the playground
for this technique rather than CABAC-encoded H.264.

## Why it became culturally significant

Because it required no special software — just a hex editor and a video
file willing to "survive" the corruption — the AVI glitch technique
spread informally through video art and (later) glitch-art forums well
before dedicated datamosh tools existed. It's the direct ancestor of:

- Compressor-based "keyframe deletion" workflows in tools like Avidemux
  and VirtualDub (delete/duplicate GOP-level frames through a UI instead
  of a hex editor).
- The Tachyons+ hardware approach (see `tachyons_plus.md`), which
  achieves an analogous effect at the signal level instead of the file
  level.
- Modern scripted approaches like `tools/ffmpeg_datamosh.py` in this
  repo, which automate exactly this "find the keyframe, remove or
  duplicate it" logic.

## Caveats

- Results are extremely format- and player-dependent; a file glitched
  this way may not play in every decoder, and "pretty" corruption is
  closer to lucky than guaranteed.
- Re-encoding a glitched file (e.g. exporting from a video editor) will
  almost always "heal" the corruption, since the editor decodes to raw
  frames and re-encodes cleanly — the glitch has to be baked in at
  export, not just previewed.
