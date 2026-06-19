# Codec Internals

A practical deep dive into the frame structures that datamoshing exploits.
This is the "how it works" doc — read this before reading the others.

## GOPs, slices, and frame types

Modern video codecs don't store every frame independently. Instead they
group frames into a **GOP (Group of Pictures)** that begins with a fully
self-contained frame and follows with frames that reference it:

- **I-frame (Intra-coded)**: A complete image, decodable on its own, much
  like a JPEG. Expensive in bits, but it's the anchor everything else
  depends on.
- **P-frame (Predictive-coded)**: Stores only the *difference* (residual)
  from a previous reference frame, plus motion vectors describing how
  blocks of the reference should be shifted before the residual is added.
- **B-frame (Bidirectionally predictive-coded)**: Like a P-frame, but can
  reference both a past *and* a future frame, blending predictions from
  both. Cheaper still, but more fragile — wrong references corrupt in
  more directions at once.

A GOP is typically `I P B B P B B P B B ... I` — one I-frame followed by a
run of P/B-frames until the next forced keyframe (e.g. by `-g` in ffmpeg).

**Slices** subdivide a frame into independently decodable strips, mostly
for error resilience and parallel decoding — datamosh tools generally
don't need to care about slice boundaries directly, but they explain why
some corrupted streams "tear" horizontally instead of corrupting globally.

## Macroblocks and CTUs

- **H.264/AVC**: divides each frame into 16x16 **macroblocks**, which can
  be further partitioned down to 4x4 for finer motion estimation.
- **H.265/HEVC**: replaces fixed macroblocks with **CTUs (Coding Tree
  Units)**, up to 64x64, recursively split via a quadtree into smaller
  Coding Units. More flexible, less "blocky" by default, but datamosh
  artifacts still appear as warped quad regions.
- **VP9**: similar superblock concept, up to 64x64, with its own
  partitioning scheme independent of H.26x.
- **AV1**: superblocks up to 128x128, partitioned with a richer set of
  split types (including T-shapes), plus more reference frame slots (up
  to 7) — this is why `av1_frame_stripper.py` targets AV1's frame
  structure separately rather than reusing H.264 macroblock logic.

## Motion vectors and prediction

Each predicted block stores a **motion vector**: a 2D `(dx, dy)` offset
saying "copy this block from `(x + dx, y + dy)` in the reference frame."
The decoder applies the vector, then adds the stored residual (the part
the prediction got wrong) to reconstruct the block.

Motion vectors are themselves predicted from neighboring blocks' vectors
(median or directional prediction) to save bits — only the *difference*
from the predicted vector is actually encoded. This is part of why
corrupting one region's vectors tends to visually "drag" into adjacent
regions: the prediction chain propagates the error.

**Reference frame lists** tell a P/B-frame which previously decoded
frames it's allowed to predict from. Datamoshing frequently works by
either removing the I-frame a GOP depended on (forcing P-frames to
predict from a now-missing or stale reference) or by re-pointing/-reusing
frames so the reference list resolves to the *wrong* image entirely
(cross-prediction).

## DCT quantization and chroma subsampling

Residuals (and full I-frame blocks) are transformed via a **DCT
(Discrete Cosine Transform)** into frequency coefficients, then
**quantized** — higher quantization step sizes throw away more
high-frequency detail to save bits. Visible "block artifacts" at low
bitrate are literally the DCT block boundaries becoming visible because
adjacent blocks quantized independently no longer agree at their edges.

**Chroma subsampling** (commonly 4:2:0) stores color (chroma) at lower
resolution than brightness (luma) — humans are less sensitive to color
detail. When datamosh corruption hits, luma tends to "survive" longer
and with sharper edges than chroma, which is part of why moshed footage
often reads as desaturated/grayscale with smeared color blooms rather
than fully scrambled.

## Entropy coding and bitstream structure

After quantization, coefficients are entropy-coded (CAVLC or CABAC in
H.264, similar arithmetic coding in later codecs) to squeeze out
remaining redundancy. This stage is why naive byte-level edits to a
compressed file ("AVI glitch" style hex editing, see
`wiki_avi_glitch.md`) mostly work on *uncompressed* or *lightly
compressed* containers (raw AVI, MJPEG) — directly mangling
CABAC-encoded H.264 bits is far more likely to produce an undecodable
stream than a pretty artifact, which is why modern datamosh tooling
tends to work at the frame-selection/re-muxing level (as in
`ffmpeg_datamosh.py`) rather than raw bitstream editing.
