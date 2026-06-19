# Tachyons+

Notes on the legendary **Tachyons+**, a hardware datamosh device
that corrupts video at the analog/signal level rather than the codec
level — physically glitching an HDMI (or composite/component) signal
chain to produce smearing and tearing in real time, on live video,
without any file-based encoding step at all.

## Why it's spiritually relevant, not technically identical

Everything else in this `references/` directory — AVI glitching, codec
internals, software datamosh pipelines — operates on a *compressed file*:
keyframes, motion vectors, GOPs, all properties of an encoded bitstream.
The Tachyons+ approach operates on a *signal*: it interferes with
sync, timing, or signal integrity directly on the wire, which produces
visually similar smearing/tearing/color-bleed effects through a
completely different mechanism (no codec, no frames in the MPEG sense,
just a continuous signal being deliberately destabilized).

That's the throughline worth preserving in this repo: datamoshing isn't
really about one specific tool or format — it's an aesthetic stance
toward *any* lossy transmission/encoding pipeline, applied at whichever
layer is most accessible. Software folks exploit GOP structure; hardware
glitch artists exploit signal timing; AVI-glitch folks exploit container
chunk layout. Same mood, different attack surface.

## Practical takeaway for this repo

Because the hardware approach can't be replicated by editing a file, the
shaders in `shaders/` (especially `datamosh_glitchcore.frag` and
`block_artifact_bleed.frag`) lean on flow-field noise and per-block
jitter to *simulate* the organic, continuous-signal feel of hardware
glitching, rather than only simulating discrete codec-level corruption.
If you're chasing the Tachyons+ look specifically, push
`u_flow_intensity` and `u_warp_strength` higher and lean less on the
hard block-quantization uniforms — the analog look reads as continuous
distortion, not discrete blocks.

## Caveat

Specifics of the original device (manufacturer, exact release era, full
technical mechanism) are not independently verified in this file — if you
have firsthand knowledge or sourcing, please correct/expand this doc.
