# datamosh

A repository exploring intentional video compression artifacting as an
aesthetic medium. Datamoshing exploits the predictive nature of video
codecs (MPEG, H.264, VP9, AV1) by removing intra-frames (I-frames) and
forcing motion vectors to carry visual data across scene boundaries,
creating bleeding, smearing, and organic distortion that looks like
reality melting.

## The Aesthetic

- **Motion vector bleeding** — P-frames and B-frames continue predicting
  motion from the wrong reference, smearing colors across cuts.
- **I-frame removal / repetition** — freezing a keyframe while motion
  continues, creating "painting" effects.
- **Cross-prediction** — forcing one scene's motion vectors to decode
  another scene's residual data.
- **Quantization artifacting** — pushing compression to the point where
  block artifacts become visible texture.
- **Glitch as narrative** — the moment the codec "fails" is the moment
  the art appears.

## Core Concepts

- **I-frames vs P-frames** — intra-coded frames vs. predictive-coded
  frames. Datamosh removes I-frames so all subsequent frames depend on a
  stale reference.
- **Motion vectors** — 2D displacement fields telling the decoder how to
  move blocks of pixels from the previous frame. Misapplied, they drag
  the wrong pixels across the screen.
- **Macroblock structures** — H.264 divides frames into 16x16 (or
  smaller) blocks. Datamosh exploits block boundaries as visible
  artifacts.
- **B-frame bidirectional prediction** — uses both past and future
  references, creating weirder smearing when corrupted.

See `references/codec_internals.md` for the full technical deep dive.

## Repository Structure

```
├── shaders/           GLSL simulations of datamosh artifacts (no real codec involved)
├── notebooks/         Jupyter notebooks for learning + analyzing real footage
├── tools/              FFmpeg/AV1 pipelines for real, codec-level datamosh
├── references/         Notes on datamosh history, culture, and codec internals
├── gallery/            Output renders (gitignored by default, see gallery/README.md)
└── LICENSE
```

### `shaders/`
GLSL fragment shaders simulating motion vector smear, macroblock bleed,
cross-prediction, freeze-frame, and temporal ghosting effects — useful
for real-time/interactive work (WebGL, Shadertoy, Three.js) without
needing an actual video file. See `shaders/README.md` for usage.

### `notebooks/`
- `datamosh_simulator.ipynb` — a from-scratch numpy simulation of a
  simplified I/P-frame encode-decode pipeline, for building intuition
  about *why* datamosh corruption looks the way it does.
- `frame_type_analyzer.ipynb` — analyzes a real video's I/P/B frame
  distribution and GOP structure via `ffprobe`, to find the most
  "corruptible" segments before running the tools below on it.

### `tools/`
- `ffmpeg_datamosh.py` — H.264/MPEG-style pipeline: re-encode with a
  controlled GOP size, strip I-frames, optionally duplicate frames to
  extend the smear.
- `av1_frame_stripper.py` — same idea, targeting AV1/WebM's key
  frame/superblock structure instead of H.264 macroblocks.
- `motion_vector_extractor.py` — extracts and visualizes motion vectors
  via ffmpeg's `mestimate` filter, to preview flow direction/magnitude
  before committing to a full mosh pass.

All three require `ffmpeg`/`ffprobe` on `PATH`; Python dependencies are
in `tools/requirements.txt`.

### `references/`
- `codec_internals.md` — H.264/HEVC/VP9/AV1 frame structure deep dive:
  GOPs, slices, macroblocks/CTUs, motion vector prediction, DCT
  quantization, chroma subsampling.
- `wiki_avi_glitch.md` — the original hex-editor AVI glitch technique
  that predates dedicated datamosh tooling.
- `sven_konig.md` — early video glitch art context.
- `tachyons_plus.md` — notes on hardware (signal-level) datamoshing, as
  a contrast to the file/codec-level techniques used elsewhere in this
  repo.

## Getting Started

```bash
# Tools (real, codec-level datamosh)
pip install -r tools/requirements.txt
python tools/ffmpeg_datamosh.py input.mp4 output.mp4 --gop-size 120

# Notebooks (simulation + analysis)
jupyter notebook notebooks/

# Shaders (simulation, no video file needed)
# paste shaders/*.frag into Shadertoy, glslCanvas, or a Three.js ShaderMaterial
```

## Design Prompts

Ideas for extending this repo:

- *"Create a datamosh shader where the smear direction is determined by
  a Perlin noise flow field instead of real motion vectors. The user
  should be able to control 'compression level', which maps to block
  size and color quantization."* — see `shaders/datamosh_glitchcore.frag`.
- *"Build a two-pass effect: pass 1 captures a frame into a frozen
  buffer, pass 2 applies directional displacement using that buffer as
  the reference for P-frame-style prediction. Time should control when
  the buffer refreshes."* — see `shaders/i_frame_repeater.frag`.
- *"Design a 'datamosh painter' that turns a webcam feed into a smeared,
  motion-bleeding canvas. Movement should leave trails, and when the
  user stops moving, the trails freeze into a still image."* — combine
  `temporal_ghosting.frag` with a webcam `u_texture` source.

## Color Palette

Compression artifact palettes are not chosen — they are emergent. But
typical bias:

- **Purple-blue shadows** — from chroma subsampling (4:2:0) smearing UV
  channels.
- **Green macroblock edges** — DCT quantization bias in H.264.
- **Magenta highlights** — color channel misalignment in interlaced
  formats.
- **Neutral grays** — where luma information survives but chroma dies.

## Mood

Like watching a memory deteriorate in real time. The art is in the
failure. The codec tried to be efficient, and in its desperation, it
created something beautiful.

## References

- Sven König, *Browser Based* (early video glitch) — see `references/sven_konig.md`
- Tachyons+ hardware datamosh — see `references/tachyons_plus.md`
- YouTube "datamosh tutorial" culture (circa 2012-2015)
- H.264 specification, sections on slice types and motion vector prediction
- FFmpeg `null` and `copy` codec tricks for container-level glitch

## License

MIT — see `LICENSE`.
