# datamosh

> *"The codec is not broken. The codec is finally telling the truth."*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GLSL](https://img.shields.io/badge/GLSL-ES%201.0-blue.svg)](https://www.khronos.org/opengles/sdk/docs/reference_cards/OpenGL-ES-2_0-Reference-card.pdf)
[![Python](https://img.shields.io/badge/Python-3.8%2B-green.svg)](https://python.org)
[![FFmpeg](https://img.shields.io/badge/FFmpeg-6.0%2B-red.svg)](https://ffmpeg.org)

---

A repository for the intentional corruption of video compression as an aesthetic medium. **Datamoshing** exploits the predictive nature of modern video codecs — MPEG-2, H.264/AVC, H.265/HEVC, VP9, AV1 — by surgically removing intra-coded frames (I-frames) and forcing the codec's motion compensation machinery to carry visual data across scene boundaries where it was never meant to reach.

The result: reality melts. Pixels from one scene bleed into the geometry of another. Motion vectors meant to track a person walking through a door instead smear a waterfall across a cityscape. The codec's elegant prediction engine, suddenly unmoored from its reference, begins to hallucinate.

This is not a bug. This is the medium.

---

## What Is Datamoshing?

Modern video codecs don't store every frame as a complete image. Instead, they exploit **temporal redundancy** — the fact that adjacent frames in a video are usually very similar. Codecs store:

- **I-frames (Intra-coded frames):** Complete images, encoded independently. These are the "keyframes" — the anchor points that the decoder uses to reconstruct everything else.
- **P-frames (Predictive frames):** Encoded as the *difference* from a previous reference frame, plus motion vectors describing how blocks of pixels have moved.
- **B-frames (Bidirectional frames):** Encoded as differences from both past and future reference frames.

A **GOP (Group of Pictures)** is the unit between two I-frames. In a standard encoding:

```
I P P P P P P P P P P P P I P P P P ...
```

When you **remove the I-frame** at a scene cut, the P-frames from the new scene suddenly have no valid reference. They try to predict pixel motion from the last frame of the *previous* scene. The codec applies the new scene's motion vectors to the old scene's pixel data. The visual result is the "smear" — the old scene's colors and shapes warp and flow, driven by motion that belongs to completely different subject matter.

This is datamoshing at its purest: **semantic collision at the signal level**.

---

## Repository Structure

```
datamosh/
├── shaders/
│   ├── datamosh_glitchcore.frag        # Motion vector smear simulation (GLSL)
│   ├── block_artifact_bleed.frag        # Macroblock boundary distortion (GLSL)
│   ├── cross_prediction_bleed.frag      # Scene-to-scene color bleeding (GLSL)
│   ├── i_frame_repeater.frag            # Frozen reference + live displacement (GLSL)
│   └── temporal_ghosting.frag           # Residual error accumulation (GLSL)
├── notebooks/
│   ├── datamosh_simulator.ipynb         # NumPy MPEG simulation pipeline
│   └── frame_type_analyzer.ipynb        # I/P/B frame distribution analysis
├── tools/
│   ├── ffmpeg_datamosh.py               # FFmpeg-based datamosh pipeline
│   ├── av1_frame_stripper.py            # AV1/WebM OBU-level frame stripping
│   └── motion_vector_extractor.py       # Motion vector extraction + visualization
├── references/
│   ├── codec_internals.md               # H.264/VP9/AV1 deep dive
│   ├── tachyons_plus.md                 # Tachyons+ hardware datamosh device
│   ├── sven_konig.md                    # Sven König's video glitch work
│   └── wiki_avi_glitch.md              # Classic AVI hex-editing technique
├── gallery/                             # Output renders
└── README.md
```

---

## Shaders

The GLSL shaders in `shaders/` simulate datamosh effects **without actual video encoding**. They run in real-time in WebGL, recreating the visual language of codec corruption using noise functions, flow fields, and texture displacement.

### `datamosh_glitchcore.frag`
The core datamosh aesthetic: motion vector smear. Uses a Perlin-style noise-based flow field to displace texture coordinates, simulating the way P-frame motion vectors drag pixel data across the screen when they reference a missing or wrong I-frame.

**Key uniforms:**
- `u_time` — animation clock
- `u_flow_intensity` — magnitude of displacement (0.0–1.0)
- `u_smear_length` — number of steps in the smear trail

### `block_artifact_bleed.frag`
Simulates macroblock boundaries as visible, animated grid distortions. Each block independently warps, shifts its color channels, and exhibits DCT quantization ringing. The block size is configurable (8, 16, 32px) mirroring H.264's variable block sizes.

### `cross_prediction_bleed.frag`
A two-texture shader that takes motion information from texture A and applies it to sample texture B. This directly simulates cross-scene prediction bleed — when P-frames from a new scene try to predict from the wrong I-frame.

### `i_frame_repeater.frag`
Freezes a reference frame while continuing to animate noise-driven displacement — the visual equivalent of a video that has stopped updating its I-frame while P-frame motion continues to accumulate.

### `temporal_ghosting.frag`
Accumulates residual frame differences over time, creating decaying ghost trails. Models the error accumulation that happens when a decoder applies a long chain of P-frame deltas without ever resetting to a clean I-frame.

---

## Python Tools

### `tools/ffmpeg_datamosh.py`

A complete pipeline for datamoshing real video files using FFmpeg.

```bash
# Basic datamosh: strip I-frames from an MP4
python tools/ffmpeg_datamosh.py --input input.mp4 --output moshed.mp4 --mode strip_iframes

# Inject null frames at scene cuts
python tools/ffmpeg_datamosh.py --input input.mp4 --output moshed.mp4 --mode null_inject --null_count 3

# Repeat P-frames for the "stuck" effect
python tools/ffmpeg_datamosh.py --input input.mp4 --output moshed.mp4 --mode repeat_pframes --repeat_count 8

# Full pipeline with low GOP re-encoding
python tools/ffmpeg_datamosh.py --input input.mp4 --output moshed.mp4 --mode full_pipeline --gop_size 4
```

### `tools/av1_frame_stripper.py`

AV1/WebM-specific frame manipulation. AV1 uses a completely different structure than H.264 — OBUs (Open Bitstream Units) instead of NAL units, tiles instead of macroblocks, and temporal prediction units (TPUs) that span across frames differently.

```bash
python tools/av1_frame_stripper.py --input input.webm --output moshed.webm --strip-key-frames
python tools/av1_frame_stripper.py --input input.webm --output moshed.webm --list-obus
```

### `tools/motion_vector_extractor.py`

Extracts and visualizes motion vectors from any video file using FFmpeg's `codecview` filter.

```bash
python tools/motion_vector_extractor.py --input input.mp4 --output vectors.png --frame 42
python tools/motion_vector_extractor.py --input input.mp4 --animate --output vectors.mp4
```

---

## Notebooks

### `notebooks/datamosh_simulator.ipynb`
A pedagogical Python simulation of MPEG-style encoding. Implements a simplified codec from scratch using NumPy:
- 8×8 DCT and quantization
- Block-based motion estimation
- I-frame and P-frame simulation
- I-frame stripping with visual corruption output

Run with: `jupyter notebook notebooks/datamosh_simulator.ipynb`

### `notebooks/frame_type_analyzer.ipynb`
Analyzes real video files using `ffprobe` to extract frame type metadata. Plots:
- I/P/B frame distribution timeline
- GOP size histogram
- Motion vector density heatmap
- "Most corruptible segment" detection

Run with: `jupyter notebook notebooks/frame_type_analyzer.ipynb`

---

## Quick Start

### Requirements

```bash
pip install numpy matplotlib scipy jupyter Pillow
# FFmpeg must be installed and in PATH
ffmpeg -version
```

### Running a Shader

The shaders are GLSL ES 1.0 compatible (WebGL 1.0). You can load them in:
- [GLSL Sandbox](http://glslsandbox.com/) (paste the shader source)
- [Shadertoy](https://www.shadertoy.com/) (adapt uniform names)
- [veda](https://github.com/fand/veda) (Atom/VSCode live shader editor)
- Any Three.js or raw WebGL app

### Running a Datamosh

```bash
# Install dependencies
pip install -r requirements.txt

# Run the core datamosh pipeline
python tools/ffmpeg_datamosh.py \
    --input your_video.mp4 \
    --output datamoshed.mp4 \
    --mode strip_iframes \
    --verbose
```

---

## Aesthetic Notes

Datamoshing works best with:

- **Hard scene cuts** — the more abrupt the transition, the more violent the bleed
- **High-motion source material** — more motion vectors = more material for the smear
- **Low-bitrate encoding** — more aggressive compression = more visible macroblocks
- **Contrasting color palettes** — the color bleeding is most striking when hues clash

The "right" amount of corruption is subjective. Too little, and the effect reads as compression artifact. Too much, and the image becomes pure noise. The sweet spot is where the original subject matter is still *almost* legible — where the viewer's brain keeps trying to resolve the shape, keeps almost seeing the face, keeps almost reading the motion.

That zone of unresolved perception is where datamosh lives.

---

## Technical Background

For a deep dive into the codec internals that make datamoshing possible, see:

- [`references/codec_internals.md`](references/codec_internals.md) — H.264, VP9, AV1 frame structure
- [`references/wiki_avi_glitch.md`](references/wiki_avi_glitch.md) — The original AVI hex-editing technique
- [`references/tachyons_plus.md`](references/tachyons_plus.md) — Hardware datamosh with Tachyons+
- [`references/sven_konig.md`](references/sven_konig.md) — Historical context and art world significance

---

## Influences & References

- **Sven König** — Early datamosh art and the " aviglitch" workflow
- **Tachyons+** — Hardware HDMI signal corruption
- **Takeshi Murata** — *Monster Movie* (2005), one of the first datamosh artworks
- **Chairlift** — *Evident Utensil* music video (2009), brought datamosh to mainstream attention
- **DVBlast / Video Codec Black Book** — Technical reference for container and bitstream structure
- **The H.264 and HEVC Video Compression Standards** — Richardson, Iain E. G.

---

## License

MIT — use it, break it, corrupt it, smear it across something else.

---

*This repository treats codec failure as a first-class aesthetic. The glitch is not incidental. The glitch is the point.*
