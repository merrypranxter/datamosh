// =============================================================================
// cross_prediction_bleed.frag
// Cross-Scene Color Bleeding — GLSL ES 1.0 Fragment Shader
//
// Simulates the "scene bleed" effect that is the signature of datamoshing:
// when a P-frame from Scene B attempts to predict from an I-frame that
// actually belongs to Scene A, the motion vectors from B's content get
// applied to A's pixel data, causing Scene A's colors and shapes to
// "bleed" through Scene B's geometry.
//
// This is the most aesthetically distinctive datamosh artifact:
// a person walking might carry the colors of a sunset that appeared
// 30 seconds earlier in the video. The shapes are new; the colors are old.
//
// CODEC MECHANICS:
//   When a scene cut happens in a datamoshed video, the decoder's DPB
//   (Decoded Picture Buffer) still holds the reference I-frame from the
//   previous scene. The P-frames from the new scene contain motion vectors
//   (MVs) that describe motion in the NEW scene — but those MVs are applied
//   to the OLD scene's reference pixels. The result: motion from B paints
//   pixels from A.
//
// SHADER IMPLEMENTATION:
//   u_texture_a: The "reference" — Scene A's visual content (the color donor)
//   u_texture_b: The "motion source" — Scene B's visual content (the motion donor)
//
//   We extract motion information from texture B using its spatial gradient
//   (proxy for motion vectors), then use that to displace sampling of texture A.
//   The blend ratio controls how much of A bleeds through B.
//
// Uniforms:
//   u_texture_a        — Scene A: the reference frame / color donor
//   u_texture_b        — Scene B: the current scene / motion donor
//   u_blend_ratio      — How much of Scene A bleeds through (0.0–1.0)
//   u_displacement_scale — Magnitude of cross-scene displacement
//   u_time             — Animation clock (drives temporal variation)
//   u_resolution       — Viewport dimensions
// =============================================================================

#ifdef GL_ES
precision mediump float;
#endif

// ---------------------------------------------------------------------------
// Uniforms
// ---------------------------------------------------------------------------
uniform sampler2D u_texture_a;         // Scene A — reference / color donor
uniform sampler2D u_texture_b;         // Scene B — motion donor / current scene
uniform float     u_blend_ratio;       // Cross-scene bleed amount [0.0 .. 1.0]
uniform float     u_displacement_scale; // Motion displacement magnitude [0.0 .. 1.0]
uniform float     u_time;              // Animation clock (seconds)
uniform vec2      u_resolution;        // Viewport dimensions

// ---------------------------------------------------------------------------
// Hash Primitives
// ---------------------------------------------------------------------------
float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float hash11(float n) {
    return fract(sin(n) * 43758.5453123);
}

// ---------------------------------------------------------------------------
// Texture Gradient (Proxy Motion Vector Estimation)
//
// In real P-frames, motion vectors are explicitly encoded in the bitstream.
// Each macroblock stores an (MVx, MVy) vector pointing from the reference
// frame to the matching block in the current frame.
//
// Here we approximate motion vectors using the spatial gradient of texture B.
// High-contrast edges in B generate large gradients — these are the regions
// where the codec would typically encode large motion vectors (object boundaries,
// moving edges). Low-contrast regions (smooth areas) generate small gradients
// — these correspond to small or zero motion vectors.
//
// This is a crude approximation, but it captures the key behavior: motion
// information is extracted from B's structure, and used to sample A.
//
// Implementation: Sobel-style edge detection on texture B
// ---------------------------------------------------------------------------
vec2 textureGradient(sampler2D tex, vec2 uv, vec2 texelSize) {
    // Sample 3×3 neighborhood for Sobel operator
    vec3 tl = texture2D(tex, uv + texelSize * vec2(-1.0,  1.0)).rgb;
    vec3 tc = texture2D(tex, uv + texelSize * vec2( 0.0,  1.0)).rgb;
    vec3 tr = texture2D(tex, uv + texelSize * vec2( 1.0,  1.0)).rgb;
    vec3 ml = texture2D(tex, uv + texelSize * vec2(-1.0,  0.0)).rgb;
    vec3 mr = texture2D(tex, uv + texelSize * vec2( 1.0,  0.0)).rgb;
    vec3 bl = texture2D(tex, uv + texelSize * vec2(-1.0, -1.0)).rgb;
    vec3 bc = texture2D(tex, uv + texelSize * vec2( 0.0, -1.0)).rgb;
    vec3 br = texture2D(tex, uv + texelSize * vec2( 1.0, -1.0)).rgb;

    // Sobel kernels: Gx and Gy
    // Gx detects horizontal edges (vertical motion component)
    // Gy detects vertical edges (horizontal motion component)
    vec3 gx = (-1.0 * tl + 1.0 * tr
               -2.0 * ml + 2.0 * mr
               -1.0 * bl + 1.0 * br);
    vec3 gy = ( 1.0 * tl + 2.0 * tc + 1.0 * tr
               -1.0 * bl - 2.0 * bc - 1.0 * br);

    // Convert to luminance (Y = 0.299R + 0.587G + 0.114B)
    // This mirrors how H.264 processes luma (Y) and chroma separately
    float gxLuma = dot(gx, vec3(0.299, 0.587, 0.114));
    float gyLuma = dot(gy, vec3(0.299, 0.587, 0.114));

    return vec2(gxLuma, gyLuma);
}

// ---------------------------------------------------------------------------
// Macroblock-Quantized Motion
//
// Real motion vectors in H.264 have a half-pixel or quarter-pixel precision
// and are quantized at the macroblock level. This function "snaps" the
// continuous gradient to a grid, simulating MB-level quantization of MVs.
//
// The result is that displacement happens in "steps" corresponding to
// macroblock boundaries rather than smoothly varying per-pixel — which
// is exactly the blocky smear appearance of real datamosh.
// ---------------------------------------------------------------------------
vec2 quantizeToMacroblock(vec2 flow, float mbSize) {
    // Quantize flow vector to macroblock precision
    // The 1/4 pixel precision of H.264 is modeled as very fine quantization
    float quantStep = 1.0 / (u_resolution.x / mbSize);
    return floor(flow / quantStep + 0.5) * quantStep;
}

// ---------------------------------------------------------------------------
// Cross-Prediction Displacement Field
//
// Combines the gradient-based motion from texture B with a time-varying
// noise component that models temporal prediction error accumulation.
//
// In a real datamosh, the longer the decoder runs without an I-frame reset,
// the more prediction error accumulates — the errors compound. We model
// this as an increasing noise contribution over time.
// ---------------------------------------------------------------------------
vec2 crossPredictionField(vec2 uv, vec2 texelSize) {
    // Gradient from Scene B (the motion donor)
    vec2 bGrad = textureGradient(u_texture_b, uv, texelSize);

    // Temporal phase: prediction error accumulates over time
    // sin/cos creates a slow drift that simulates the "error walk"
    // of a decoder that hasn't seen an I-frame in many frames
    float timeDrift = u_time * 0.08;
    vec2 temporalDrift = vec2(
        sin(uv.y * 4.0 + timeDrift * 1.3) * 0.3,
        cos(uv.x * 3.7 + timeDrift * 0.9) * 0.3
    );

    // Macroblock-level noise: each MB gets a slightly different error term
    // This is the "error concealment" mode of the decoder kicking in
    float mbSize = 16.0;
    vec2 mbCoord = floor(uv * u_resolution / mbSize);
    float mbNoise = hash21(mbCoord + floor(u_time * 0.5)) * 2.0 - 1.0;
    vec2 mbError = vec2(mbNoise, hash21(mbCoord.yx + 3.7)) * 0.1;

    // Combine: gradient drives the primary displacement,
    // temporal drift and MB error add variation and temporal animation
    return bGrad * 2.0 + temporalDrift * 0.5 + mbError;
}

// ---------------------------------------------------------------------------
// Bleed Mask
//
// Not all regions bleed equally. Areas where Scene B has high contrast
// (the "edges" of motion in B) tend to show the most bleed from A.
// Low-contrast regions of B may show little or no bleed.
//
// This mirrors how motion compensation works: blocks with complex content
// (high DCT energy) are harder to predict and accumulate more error,
// making them more visible "bleeding" regions.
// ---------------------------------------------------------------------------
float bleedMask(vec2 uv, vec2 texelSize, float t) {
    // Edge strength from B (high = more bleed)
    vec2 grad = textureGradient(u_texture_b, uv, texelSize);
    float edgeStrength = length(grad);

    // Temporal pulsing: bleed intensity varies over time
    // (models the cyclical nature of GOP structure — bleed peaks
    // near the removed I-frame and decays as P-frame errors accumulate)
    float pulse = 0.5 + 0.5 * sin(t * 0.4 + length(uv - 0.5) * 5.0);

    return clamp(edgeStrength * 3.0 * pulse, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Scene A Color Extraction (with drift)
//
// Samples Scene A with a displacement derived from Scene B's motion field.
// The chroma planes are sampled with additional offset to simulate
// 4:2:0 chroma prediction error (chroma MVs derived from luma MVs at
// half resolution, causing additional chroma drift).
// ---------------------------------------------------------------------------
vec4 sampleSceneAWithBleed(vec2 baseUV, vec2 motionVector, float scale) {
    // Primary displacement: Scene B's motion applied to Scene A's pixels
    // This is the exact cross-prediction operation that happens in real datamosh
    vec2 displacedUV = baseUV + motionVector * scale * 0.08;
    displacedUV = clamp(displacedUV, 0.001, 0.999);

    // Sample luma proxy (Y channel via luminance weighting)
    vec4 aBase = texture2D(u_texture_a, displacedUV);

    // Chroma channels get additional 4:2:0 drift
    // (half-resolution chroma means chroma MVs are imprecise)
    vec2 chromaOffset = motionVector * scale * 0.04; // Half luma displacement
    float aCb = texture2D(u_texture_a, clamp(displacedUV + chromaOffset * vec2(1.0, 0.0), 0.001, 0.999)).b;
    float aCr = texture2D(u_texture_a, clamp(displacedUV + chromaOffset * vec2(0.0, 1.0), 0.001, 0.999)).r;

    return vec4(aCr, aBase.g, aCb, aBase.a);
}

// ---------------------------------------------------------------------------
// Main Fragment
// ---------------------------------------------------------------------------
void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;
    vec2 texelSize = 1.0 / u_resolution;

    // -------------------------------------------------------------------------
    // Step 1: Sample the current scene (Scene B — the motion donor)
    // -------------------------------------------------------------------------
    vec4 sceneB = texture2D(u_texture_b, uv);

    // -------------------------------------------------------------------------
    // Step 2: Compute the cross-prediction displacement field
    // (motion vectors from B, to be applied to A)
    // -------------------------------------------------------------------------
    vec2 motionField = crossPredictionField(uv, texelSize);
    vec2 quantizedMV = quantizeToMacroblock(motionField, 16.0);

    // -------------------------------------------------------------------------
    // Step 3: Sample Scene A with B's motion applied (the bleed)
    // -------------------------------------------------------------------------
    vec4 bleedFromA = sampleSceneAWithBleed(uv, quantizedMV, u_displacement_scale);

    // -------------------------------------------------------------------------
    // Step 4: Compute the bleed mask — where does A show through?
    // -------------------------------------------------------------------------
    float mask = bleedMask(uv, texelSize, u_time);

    // Combine blend ratio with mask: ratio sets the maximum possible bleed,
    // mask determines its spatial distribution based on B's edge structure
    float effectiveBlend = u_blend_ratio * mask;

    // -------------------------------------------------------------------------
    // Step 5: Composite A's bleed on top of B
    //
    // This is the visual equivalent of the decoder's output:
    //   - Where B has strong edges (motion), A's color shows through
    //   - Where B is smooth (static), only B is visible
    //   - The transition is governed by the blend ratio parameter
    // -------------------------------------------------------------------------
    vec4 result = mix(sceneB, bleedFromA, effectiveBlend);

    // -------------------------------------------------------------------------
    // Step 6: Prediction error residual accumulation
    //
    // In real P-frames, prediction error (the difference between the predicted
    // block and the actual block) is encoded as DCT residuals. When the
    // prediction is wrong (wrong I-frame reference), these residuals are large.
    // We model this as a subtle additive "residual glow" at prediction
    // boundaries — the difference signal is visible as added brightness.
    // -------------------------------------------------------------------------
    vec4 residual = abs(bleedFromA - sceneB);
    float residualLuma = dot(residual.rgb, vec3(0.299, 0.587, 0.114));
    result.rgb += residualLuma * 0.08 * u_displacement_scale;

    // -------------------------------------------------------------------------
    // Step 7: Temporal de-correlation noise
    // Adds a fine frame-to-frame variation that prevents the effect from
    // looking "stuck" — in real video, prediction error changes every frame
    // -------------------------------------------------------------------------
    float noise = hash21(uv * 1000.0 + fract(u_time * 60.0)) * 0.03 - 0.015;
    result.rgb += noise * u_blend_ratio;
    result.rgb = clamp(result.rgb, 0.0, 1.0);

    gl_FragColor = result;
}
