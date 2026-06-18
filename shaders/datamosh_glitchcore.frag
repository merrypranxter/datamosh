// =============================================================================
// datamosh_glitchcore.frag
// Motion Vector Smear — GLSL ES 1.0 Fragment Shader
//
// Simulates the core datamosh aesthetic: the "smear" produced when P-frames
// lose their I-frame reference and begin applying motion vectors from one
// scene's content to another scene's pixel data.
//
// In a real codec, P-frames encode only the *difference* from a reference
// frame plus motion vectors describing block displacement. When the reference
// I-frame is removed, the decoder applies those motion vectors to whatever
// was on screen before — producing the characteristic bleeding, smearing,
// and directional drag that defines datamosh.
//
// This shader approximates that process using:
//   1. A Perlin-style noise-based flow field (approximating motion vectors)
//   2. Multi-step texture displacement along the flow direction (the smear trail)
//   3. Time-driven animation (the "continued motion" of P-frames without reset)
//
// Uniforms:
//   u_time           — Animation clock in seconds
//   u_resolution     — Viewport dimensions in pixels (vec2)
//   u_texture        — The source image/video frame being "corrupted"
//   u_flow_intensity — Magnitude of the displacement field (0.0 = none, 1.0 = extreme)
//   u_smear_length   — Number of accumulation steps in the smear trail (1–32)
//
// Usage: Load in GLSL Sandbox, Shadertoy (rename uniforms), veda, or any
//        WebGL 1.0 context. Provide a texture for u_texture.
// =============================================================================

#ifdef GL_ES
precision mediump float;
#endif

// ---------------------------------------------------------------------------
// Uniforms
// ---------------------------------------------------------------------------
uniform float     u_time;           // Seconds since start
uniform vec2      u_resolution;     // Viewport width, height in pixels
uniform sampler2D u_texture;        // Source video frame / image
uniform float     u_flow_intensity; // Displacement magnitude [0.0 .. 1.0]
uniform float     u_smear_length;   // Steps in smear accumulation [1 .. 32]

// ---------------------------------------------------------------------------
// Hash & Noise Primitives
//
// These functions approximate Perlin noise without requiring a texture lookup.
// They produce smooth, pseudo-random gradients that we use to build the flow
// field — analogous to the motion vector field in a real P-frame.
// ---------------------------------------------------------------------------

// 2D hash: maps a vec2 seed to a pseudo-random scalar in [0, 1)
float hash21(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
}

// 2D hash returning a vec2, used for gradient generation
vec2 hash22(vec2 p) {
    float n = hash21(p);
    return vec2(
        fract(n * 127.1),
        fract(n * 311.7)
    ) * 2.0 - 1.0; // Remap to [-1, 1] — matches gradient direction in Perlin
}

// Quintic smoothstep: C2-continuous interpolation
// Smoother than cubic Hermite — reduces banding in the flow field.
// This is the same smoothing Perlin himself uses in his "improved" noise (2002).
vec2 smootherstep2(vec2 t) {
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

// ---------------------------------------------------------------------------
// Value Noise (2D)
//
// Returns a smooth noise value in [-1, 1] at position p.
// The grid-based approach mirrors how a codec divides a frame into
// macroblocks — each cell in this grid corresponds conceptually to
// a macroblock in an H.264 P-frame.
// ---------------------------------------------------------------------------
float valueNoise(vec2 p) {
    vec2 i = floor(p); // Grid cell (macroblock index)
    vec2 f = fract(p); // Position within cell (sub-block offset)
    vec2 u = smootherstep2(f);

    // Sample the four corners of the cell
    float a = hash21(i + vec2(0.0, 0.0));
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));

    // Bilinear interpolation
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

// ---------------------------------------------------------------------------
// Fractal Noise (fBm — Fractional Brownian Motion)
//
// Layering multiple octaves of value noise creates a more organic,
// multi-scale flow field. This mirrors the hierarchical motion estimation
// in modern codecs: large-scale inter-frame motion is encoded first,
// then refined at finer block granularities.
//
// Parameters:
//   p       — sample position
//   octaves — number of frequency layers (higher = more detail, more cost)
// ---------------------------------------------------------------------------
float fbm(vec2 p, int octaves) {
    float value     = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;
    float total     = 0.0;

    for (int i = 0; i < 8; i++) {
        if (i >= octaves) break; // GLSL ES 1.0: loop bound must be constant — guard manually
        value     += amplitude * valueNoise(p * frequency);
        total     += amplitude;
        amplitude *= 0.5;   // Each octave has half the contribution
        frequency *= 2.1;   // Slightly inharmonic scaling avoids grid alignment artifacts
    }
    return value / total;
}

// ---------------------------------------------------------------------------
// Flow Field Generation
//
// A flow field is a 2D vector field where each point has a direction.
// In datamosh, motion vectors ARE the flow field — each macroblock has
// a (dx, dy) motion vector pointing from the reference frame to the
// current frame's block position.
//
// We approximate this with two offset noise samples (one per axis),
// which gives us smooth, curl-free directional flow.
//
// The time parameter animates the field, simulating the "continued motion"
// of P-frames that keep accumulating displacement without an I-frame reset.
// ---------------------------------------------------------------------------
vec2 flowField(vec2 uv, float t) {
    // Two independent noise channels = one 2D vector
    // The small offset (vec2(43.2, 17.8)) decorrelates the two channels
    // so x and y flow directions aren't identical
    float fx = fbm(uv + vec2(t * 0.15, 0.0), 4);
    float fy = fbm(uv + vec2(43.2, 17.8 + t * 0.12), 4);
    return vec2(fx, fy);
}

// ---------------------------------------------------------------------------
// Datamosh Smear Accumulation
//
// This is the heart of the effect. We step backward along the flow direction
// multiple times, sampling the texture at each offset position and
// accumulating the results.
//
// This simulates the error accumulation that occurs when a decoder applies
// a chain of P-frame deltas without a clean I-frame reset:
//   frame_n = frame_0 + Δ₁ + Δ₂ + Δ₃ + ... + Δₙ
//
// Each step in our loop corresponds to one P-frame's worth of accumulated
// motion displacement. The decay factor (pow) models the fact that
// earlier P-frames contribute progressively less to the visible artifact.
//
// Parameters:
//   uv       — Normalized texture coordinate [0,1]²
//   flow     — 2D flow vector at this position (from flowField())
//   intensity — Overall displacement scale
//   steps    — Number of smear accumulation steps
// ---------------------------------------------------------------------------
vec4 datamoshSmear(vec2 uv, vec2 flow, float intensity, float steps) {
    vec4 color = vec4(0.0);
    float totalWeight = 0.0;

    float stepCount = max(1.0, min(steps, 32.0));

    for (int i = 0; i < 32; i++) {
        if (float(i) >= stepCount) break;

        float t = float(i) / stepCount;

        // Decay: earlier steps (larger displacement) have less weight.
        // This models how P-frame errors are smallest near the I-frame
        // and largest far from it.
        float weight = pow(1.0 - t, 2.0);

        // Step backward along the flow vector (negative sign: we're
        // asking "where did this pixel come from?", not "where is it going?")
        vec2 offset = -flow * intensity * t * 0.15;
        vec2 sampleUV = uv + offset;

        // Clamp to valid texture coordinates (simulates decoder's handling
        // of out-of-frame motion vector references)
        sampleUV = clamp(sampleUV, 0.001, 0.999);

        color += texture2D(u_texture, sampleUV) * weight;
        totalWeight += weight;
    }

    return color / max(totalWeight, 0.001);
}

// ---------------------------------------------------------------------------
// Chroma Shift
//
// Real codec artifacts often include color channel separation, because
// chroma (Cb/Cr) is typically subsampled (4:2:0) and motion-compensated
// separately from luma (Y). The chroma channels often lag or misalign.
//
// We simulate this by applying a slightly different displacement to each
// color channel — a subtle chromatic aberration effect.
// ---------------------------------------------------------------------------
vec4 chromaShift(vec2 uv, vec2 flow, float intensity) {
    float shift = intensity * 0.008;

    // Sample R channel with slight rightward chroma offset
    float r = texture2D(u_texture, uv + vec2(shift, 0.0)).r;
    // Sample G channel unshifted (Y/luma proxy)
    float g = texture2D(u_texture, uv).g;
    // Sample B channel with leftward chroma offset
    float b = texture2D(u_texture, uv - vec2(shift, 0.0)).b;
    float a = texture2D(u_texture, uv).a;

    return vec4(r, g, b, a);
}

// ---------------------------------------------------------------------------
// Main Fragment
// ---------------------------------------------------------------------------
void main() {
    // Normalized UV coordinates [0, 1]²
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;

    // Aspect-correct UV for noise sampling
    // (prevents the flow field from being stretched on non-square viewports)
    vec2 noiseUV = vec2(uv.x * (u_resolution.x / u_resolution.y), uv.y);

    // Scale noise UV to control the "macroblock size" of the flow field.
    // Lower values = larger flow structures (large macroblocks / low-bitrate feel)
    // Higher values = tighter, more granular flow (small macroblocks / high-quality encoding)
    float noiseScale = 2.5;
    vec2 scaledUV = noiseUV * noiseScale;

    // Generate the flow field at this position
    // The time parameter causes the field to slowly evolve,
    // simulating the continuous accumulation of P-frame motion
    vec2 flow = flowField(scaledUV, u_time);

    // Blend intensity with a subtle time-based pulse.
    // In real video, datamosh artifacts aren't constant — they flare up
    // near scene cuts and decay as the GOP progresses toward the next I-frame.
    float intensity = u_flow_intensity * (0.85 + 0.15 * sin(u_time * 0.7));

    // Compute the smeared sample
    vec4 moshed = datamoshSmear(uv, flow, intensity, u_smear_length);

    // Apply chroma shift on top of the smear
    // (mix based on intensity: at zero intensity, pure chroma shift; at max, full smear)
    vec4 chroma = chromaShift(uv, flow, intensity);
    vec4 result = mix(chroma, moshed, clamp(intensity * 1.2, 0.0, 1.0));

    // Subtle vignette — datacorruption is always worst at the edges,
    // where encoder quality typically degrades first
    float vignette = 1.0 - 0.3 * length(uv - 0.5) * 2.0;
    result.rgb *= vignette;

    gl_FragColor = result;
}
