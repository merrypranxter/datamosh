// =============================================================================
// i_frame_repeater.frag
// Frozen Reference Frame with Continuing Displacement — GLSL ES 1.0
//
// Simulates the classic "frozen frame while motion continues" datamosh effect.
// This is what happens when an I-frame is repeated (or when P-frames loop
// back to reference the same outdated I-frame) while the motion vectors
// keep advancing through new P-frames.
//
// CODEC MECHANICS:
//   In normal video playback:
//     frame_n = I_frame + Δ₁ + Δ₂ + ... + Δₙ
//   
//   When the I-frame is frozen (repeated), the decoder keeps using the same
//   reference image, but the P-frame motion vectors keep pointing to new
//   positions within that frozen reference. The result: the image doesn't
//   update its content (the subject stays frozen), but motion vectors keep
//   warping and distorting that frozen content.
//
//   Visually: it looks like a paused video that forgot to pause. Or a
//   photograph being slowly stretched and folded by an invisible hand.
//   The frozen face keeps getting pulled, distorted, and smeared as if
//   it's made of taffy.
//
// SHADER IMPLEMENTATION:
//   u_texture:    The "frozen" reference frame (the stuck I-frame)
//   u_freeze_time: The moment at which the frame froze (a timestamp)
//
//   The shader samples u_texture at a displaced UV, where the displacement
//   is driven by animated noise that grows in magnitude from u_freeze_time.
//   This models the error accumulation — the longer since the last valid
//   I-frame, the more distorted the frozen reference becomes.
//
// Uniforms:
//   u_texture      — The frozen reference frame (the stuck I-frame)
//   u_time         — Current animation clock (seconds)
//   u_resolution   — Viewport dimensions
//   u_freeze_time  — The timestamp when the I-frame "froze" (seconds)
//   u_thaw_rate    — Speed of displacement growth after freezing (0.0–1.0)
//   u_noise_scale  — Spatial scale of the displacement noise field
// =============================================================================

#ifdef GL_ES
precision mediump float;
#endif

// ---------------------------------------------------------------------------
// Uniforms
// ---------------------------------------------------------------------------
uniform sampler2D u_texture;      // Frozen reference frame (the stuck I-frame)
uniform float     u_time;         // Current time (seconds)
uniform vec2      u_resolution;   // Viewport dimensions
uniform float     u_freeze_time;  // Time at which the I-frame froze
uniform float     u_thaw_rate;    // Rate of distortion growth post-freeze [0.0..1.0]
uniform float     u_noise_scale;  // Spatial scale of displacement noise [0.5..4.0]

// ---------------------------------------------------------------------------
// Hash & Noise Primitives
// ---------------------------------------------------------------------------
float hash21(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
}

float hash11(float n) {
    return fract(sin(n) * 43758.5453123);
}

// Smooth gradient noise
float gradientNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f); // Cubic Hermite interpolation

    float a = hash21(i + vec2(0.0, 0.0));
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

// Multi-octave noise for organic displacement
float fbm(vec2 p) {
    float val = 0.0;
    float amp = 0.5;
    float freq = 1.0;
    for (int i = 0; i < 6; i++) {
        val  += amp * gradientNoise(p * freq);
        amp  *= 0.5;
        freq *= 2.03;
    }
    return val;
}

// ---------------------------------------------------------------------------
// Post-Freeze Time
//
// Returns elapsed time since the I-frame froze. This drives the magnitude
// of all distortions — the longer since the last I-frame, the worse
// the accumulated prediction error, the more distorted the image.
//
// In real codec terms: P-frame prediction error accumulates as
//   error_n ≈ QP² × n / GOP_size
// where n is the frame distance from the last I-frame.
// ---------------------------------------------------------------------------
float postFreezeTime() {
    return max(0.0, u_time - u_freeze_time);
}

// ---------------------------------------------------------------------------
// Freeze Distortion Field
//
// The displacement field that deforms the frozen reference frame.
// After freeze, the field grows from zero (clean reference) to
// increasingly large displacements (heavily accumulated error).
//
// Two components:
//   1. Smooth, large-scale warp: simulates the long-range motion vectors
//      that drag large chunks of the image around
//   2. Fine, block-level jitter: simulates the frame-to-frame variation
//      in motion compensation within individual macroblocks
// ---------------------------------------------------------------------------
vec2 freezeDistortionField(vec2 uv, float elapsed) {
    float scale = u_noise_scale;

    // Large-scale component: slow evolution tied to elapsed time
    // This models how the dominant motion direction in the video
    // pulls the frozen image in a persistent direction
    float fx = fbm(uv * scale + vec2(elapsed * 0.17, 0.0));
    float fy = fbm(uv * scale + vec2(0.0, elapsed * 0.14) + vec2(3.7, 8.1));
    vec2 largeScale = vec2(fx, fy);

    // Fine-scale component: faster variation, smaller magnitude
    // Simulates the frame-level jitter from residual DCT energy
    float tfine = elapsed * 4.0; // Higher temporal frequency
    float jx = gradientNoise(uv * scale * 4.0 + vec2(tfine, 0.0)) * 0.25;
    float jy = gradientNoise(uv * scale * 4.0 + vec2(0.0, tfine * 1.1)) * 0.25;
    vec2 fineScale = vec2(jx, jy);

    return largeScale + fineScale * 0.3;
}

// ---------------------------------------------------------------------------
// Error Accumulation Envelope
//
// Models how prediction error grows over time without an I-frame refresh.
// Real error accumulation is roughly:
//   error(n) = error_initial × amplification_factor^n
//
// Near the frozen I-frame (elapsed ≈ 0), distortion is minimal.
// As time passes, it grows with a sigmoid-like curve that eventually
// saturates — even very bad datamosh eventually "settles" into maximum
// distortion.
// ---------------------------------------------------------------------------
float errorEnvelope(float elapsed) {
    float growthRate = u_thaw_rate * 1.5 + 0.1;

    // Sigmoid growth: starts slow, accelerates, then saturates
    // This matches the observed behavior in real codec error propagation
    return 1.0 - exp(-elapsed * growthRate * 0.3);
}

// ---------------------------------------------------------------------------
// Scanline / Interlace Artifact
//
// When I-frames are removed in interlaced video (which H.264 supports via
// MBAFF — Macroblock Adaptive Frame/Field coding), field order confusion
// creates horizontal scanline artifacts. Even in progressive video,
// datamosh sometimes creates horizontal banding as whole rows of
// macroblocks "slip" together.
//
// We model this as periodic horizontal displacement that varies per
// scanline band.
// ---------------------------------------------------------------------------
float scanlineSlip(vec2 uv, float elapsed) {
    // Scan bands (analogous to H.264 slice structure)
    float bandFreq = 8.0 + 4.0 * hash11(floor(elapsed * 2.0));
    float band = floor(uv.y * bandFreq) / bandFreq;

    // Each band can slip horizontally
    float slipAmount = hash11(band * 17.3 + floor(elapsed * 3.0)) * 2.0 - 1.0;
    float slipMask = step(0.6, hash11(band * 5.7 + floor(elapsed * 1.5)));

    return slipAmount * slipMask;
}

// ---------------------------------------------------------------------------
// Frozen Frame Sampling
//
// Samples the frozen reference with accumulated distortion.
// The key insight: we're always sampling the SAME texture (the frozen I-frame),
// but at increasingly distorted coordinates. The texture itself never changes
// — only the UV coordinates do, driven by the P-frame motion accumulation.
//
// This gives the characteristic feel of a face melting while staying
// recognizably that face.
// ---------------------------------------------------------------------------
vec4 sampleFrozenFrame(vec2 uv, float elapsed) {
    vec2 distortion = freezeDistortionField(uv, elapsed);
    float envelope = errorEnvelope(elapsed);
    float slipX = scanlineSlip(uv, elapsed);

    // Combine distortions, weighted by error envelope
    vec2 displacement = distortion * envelope * 0.12 * (u_thaw_rate + 0.1);
    displacement.x += slipX * envelope * 0.02;

    vec2 displacedUV = clamp(uv + displacement, 0.001, 0.999);

    // Chroma aberration increases with distortion
    float chromaOffset = envelope * 0.005 * u_thaw_rate;
    float r = texture2D(u_texture, clamp(displacedUV + vec2(chromaOffset, 0.0), 0.0, 1.0)).r;
    float g = texture2D(u_texture, displacedUV).g;
    float b = texture2D(u_texture, clamp(displacedUV - vec2(chromaOffset, 0.0), 0.0, 1.0)).b;

    return vec4(r, g, b, 1.0);
}

// ---------------------------------------------------------------------------
// Macroblock Freeze Pattern
//
// Not all macroblocks freeze simultaneously. In a real datamosh,
// the decoder processes MBs in raster order — some may be in error
// concealment mode while others are still decoding correctly.
// We simulate this with a spatially-varying freeze mask that creates
// patches of frozen and "almost-updating" regions.
// ---------------------------------------------------------------------------
float macroblockFreezeMask(vec2 uv, float elapsed) {
    float mbSize = 16.0;
    vec2 mbCoord = floor(uv * u_resolution / mbSize);

    // Each macroblock has its own "freeze onset time"
    // Some freeze early, some late — creating a spreading freeze effect
    float mbFreezeTime = hash21(mbCoord) * 0.8;
    float mbElapsed = max(0.0, elapsed - mbFreezeTime);

    // Smooth sigmoid: MB transitions from "updating" to "frozen" gradually
    return 1.0 / (1.0 + exp(-mbElapsed * 4.0 + 2.0));
}

// ---------------------------------------------------------------------------
// Main Fragment
// ---------------------------------------------------------------------------
void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;

    // Time elapsed since the I-frame froze
    float elapsed = postFreezeTime();

    // Sample the frozen (and distorting) reference frame
    vec4 frozenSample = sampleFrozenFrame(uv, elapsed);

    // Macroblock freeze mask: controls spatial distribution of the effect
    float mbMask = macroblockFreezeMask(uv, elapsed);

    // Unaffected clean sample (what the image looks like before freeze)
    vec4 cleanSample = texture2D(u_texture, uv);

    // Blend: early elapsed = mostly clean; late elapsed = fully distorted
    vec4 result = mix(cleanSample, frozenSample, mbMask * errorEnvelope(elapsed));

    // Temporal quantization noise: as prediction error grows, so does
    // the visible noise floor — models the increase in quantization
    // error from compounding P-frame deltas
    float noiseFloor = errorEnvelope(elapsed) * 0.04;
    float noise = (hash21(uv * 1000.0 + fract(elapsed * 60.0)) - 0.5) * noiseFloor;
    result.rgb += noise;

    // Desaturation under extreme distortion
    // Heavily corrupted video loses color fidelity — extreme quantization
    // collapses chroma. We model this as progressive desaturation.
    float saturation = 1.0 - errorEnvelope(elapsed) * 0.4 * u_thaw_rate;
    float luma = dot(result.rgb, vec3(0.299, 0.587, 0.114));
    result.rgb = mix(vec3(luma), result.rgb, saturation);

    result.rgb = clamp(result.rgb, 0.0, 1.0);
    gl_FragColor = result;
}
