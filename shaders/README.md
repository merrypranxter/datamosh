# Shaders

GLSL ES fragment shaders simulating datamosh aesthetics without touching an
actual video codec. Each shader assumes a standard fullscreen-triangle/quad
vertex shader passing `varying vec2 v_uv` in `[0, 1]`.

| Shader | Effect |
|---|---|
| `datamosh_glitchcore.frag` | Perlin-noise flow field standing in for motion vectors; smears and quantizes based on a "compression level" uniform |
| `block_artifact_bleed.frag` | Macroblock-grid distortion with per-block channel splitting and warp |
| `cross_prediction_bleed.frag` | Two-texture blend where scene A's motion field displaces scene B's pixels |
| `i_frame_repeater.frag` | Freezes the sampled reference while motion keeps drifting |
| `temporal_ghosting.frag` | Feedback-buffer residual accumulation; needs a ping-pong framebuffer |

## Trying them out

Any WebGL2 quad-render harness works. Quick options:
- Paste into [Shadertoy](https://www.shadertoy.com/) (swap `texture2D`/`varying` for Shadertoy's `iChannel0`/`fragCoord` conventions).
- Use [glslCanvas](https://github.com/patriciogonzalezvivo/glslCanvas) or [glsl-canvas](https://marketplace.visualstudio.com/items?itemName=circledev.glsl-canvas) for live preview in-editor.
- Drop into a minimal Three.js `ShaderMaterial` with a plane geometry.

`temporal_ghosting.frag` is the only one requiring a feedback loop (render to texture A, feed it back in as `u_previous_frame` next frame, ping-pong with texture B).
