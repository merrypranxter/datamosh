// =============================================================================
// temporal_ghosting.frag
// Residual Error Accumulation Effect — GLSL ES 1.0 Fragment Shader
//
// Simulates the accumulation of P-frame prediction residuals over time,
// creating trailing ghost images that linger and decay long after the
// subject has moved on. This is one of the most haunting datamosh effects.
//
// CODEC MECHANICS:
//   When H.264 encodes a P-frame, each macroblock is encoded as:
//     MB_current = MC(MB_reference, MV) + Residual
//
//   Where:
//     MC()     = motion-compensated prediction (the "guess")
//     MV       = motion vector (where to find the reference block)
//     Residual = the error between the prediction and reality (encoded as DCT)
//
//   When the reference frame is wrong (datamosh), the Residual term explodes
//   in size — the difference between what the codec predicted (old scene)
//   and what's actually there (new scene) is enormous. This residual energy
//   doesn't disappear immediately — it persists in the decoder's state,
//   leaking into subsequent frames as a decaying ghost of the original error.
//
//   The result looks like: frames leave traces of themselves as they move.
//   Bright regions drag long luminous tails. Motion paths are illuminated
//   by the residual energy of previous positions.
//
// SHADER APPROACH:
//   Since we can't maintain actual frame history in a single-pass shader,
//   we simulate the accumulation by:
//   1. Using the spatial gradient of the current frame as a "residual proxy"
//      (high-gradient regions = high residual energy in real codec)
//   2. Computing ghost contributions at multiple time offsets using animated
//      noise to simulate where the subject "was" in previous frames
//   3. Applying an exponential decay model to weight recent ghosts more than old
//
// Uniforms:
//   u_texture        — Current video frame
//   u_time           — Animation clock (seconds)
//   u_resolution     — Viewport dimensions
//   u_decay          — Ghost decay rate [0.0=no decay .. 1.0=instant decay]
//   u_ghost_intensity — Overall ghost visibility [0.0 .. 1.0]
//   u_residual_scale — Scale of residual error magnitude [0.0 .. 1.0]
// =============================================================================

#ifdef GL_ES
precision mediump float;
#endif

// ---------------------------------------------------------------------------
// Uniforms
// ---------------------------------------------------------------------------
uniform sampler2D u_texture;         // Current frame
uniform float     u_time;            // Animation clock (seconds)
uniform vec2      u_resolution;      // Viewport dimensions
uniform float     u_decay;           // Ghost decay coefficient [0.0 .. 1.0]
uniform float     u_ghost_intensity; // Overall ghost visibility [0.0 .. 1.0]
uniform float     u_residual_scale;  // Residual error magnitude [0.0 .. 1.0]

// ---------------------------------------------------------------------------
// Hash & Noise
// ---------------------------------------------------------------------------
float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float hash11(float n) {
    return fract(sin(n) * 43758.5453);
}

float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm2(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
        v += a * (valueNoise(p) * 2.0 - 1.0);
        p = p * 2.07 + vec2(1.3, 4.7);
        a *= 0.5;
    }
    return v;
}

// ---------------------------------------------------------------------------
// Residual Energy Estimation
//
// In a real P-frame, the residual is the difference between:
//   1. The motion-compensated prediction from the reference frame
//   2. The actual current frame content
//
// When the reference is wrong (datamosh), this difference is large.
// We approximate the residual energy using the spatial gradient magnitude
// of the current frame — regions with high spatial frequency content
// (edges, textures) have higher residual energy under bad prediction.
//
// This is a known relationship: flat regions are easy to predict
// (small residual), while edges and textures are hard (large residual).
// The codec allocates more bits to high-residual macroblocks.
// ---------------------------------------------------------------------------
float residualEnergy(vec2 uv, vec2 texelSize) {
    // Sobel gradient magnitude
    vec3 c00 = texture2D(u_texture, uv + texelSize * vec2(-1.0, -1.0)).rgb;
    vec3 c10 = texture2D(u_texture, uv + texelSize * vec2( 0.0, -1.0)).rgb;
    vec3 c20 = texture2D(u_texture, uv + texelSize * vec2( 1.0, -1.0)).rgb;
    vec3 c01 = texture2D(u_texture, uv + texelSize * vec2(-1.0,  0.0)).rgb;
    vec3 c21 = texture2D(u_texture, uv + texelSize * vec2( 1.0,  0.0)).rgb;
    vec3 c02 = texture2D(u_texture, uv + texelSize * vec2(-1.0,  1.0)).rgb;
    vec3 c12 = texture2D(u_texture, uv + texelSize * vec2( 0.0,  1.0)).rgb;
    vec3 c22 = texture2D(u_texture, uv + texelSize * vec2( 1.0,  1.0)).rgb;

    vec3 gx = -c00 + c20 - 2.0*c01 + 2.0*c21 - c02 + c22;
    vec3 gy = -c00 - 2.0*c10 - c20 + c02 + 2.0*c12 + c22;

    float gradMag = length(gx) + length(gy);
    // Normalize: typical gradient magnitude is in [0, ~10], clamp to [0,1]
    return clamp(gradMag * 0.1, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Motion Path Estimation
//
// In the absence of actual temporal frame storage, we estimate where
// a given point "was" in previous virtual frames using the gradient
// direction as a proxy for motion direction. High-gradient regions
// tend to be the leading edge of motion, and the gradient direction
// points approximately opposite to the motion direction.
//
// Returns a displacement vector pointing "backward in time" for this pixel.
// ---------------------------------------------------------------------------
vec2 estimatedMotionPath(vec2 uv, vec2 texelSize, float frameOffset) {
    // Use the texture gradient as a motion direction proxy
    vec2 gradX = (texture2D(u_texture, uv + vec2(texelSize.x, 0.0)).rgb
                - texture2D(u_texture, uv - vec2(texelSize.x, 0.0)).rgb).rg;
    vec2 gradY = (texture2D(u_texture, uv + vec2(0.0, texelSize.y)).rgb
                - texture2D(u_texture, uv - vec2(0.0, texelSize.y)).rgb).rg;

    // Approximate motion direction from gradient
    float gMagX = length(gradX);
    float gMagY = length(gradY);
    vec2 motionDir = normalize(vec2(gMagX - gMagY, gMagX + gMagY) + 0.0001);

    // Add noise to model the per-macroblock variation in motion vectors
    float noiseScale = 3.0;
    float nx = fbm2(uv * noiseScale + vec2(u_time * 0.1, 0.0));
    float ny = fbm2(uv * noiseScale + vec2(7.3, u_time * 0.08));
    vec2 noiseMotion = vec2(nx, ny) * 0.3;

    // Scale by frame offset (earlier frames = more displacement)
    return (motionDir * 0.015 + noiseMotion * 0.02) * frameOffset;
}

// ---------------------------------------------------------------------------
// Ghost Sample
//
// Samples the texture at a "past position" — where this pixel would have
// been frameOffset frames ago, based on the estimated motion path.
// Applies exponential decay based on the frame distance.
//
// The decay models: ghost_weight(n) = (1 - decay)^n
// In real codecs, error propagation follows a similar exponential pattern:
// each P-frame both inherits and amplifies the previous frame's error.
// ---------------------------------------------------------------------------
vec4 ghostSample(vec2 uv, vec2 texelSize, float frameOffset, float decayRate) {
    // Displace UV backward in time along estimated motion path
    vec2 pastUV = uv - estimatedMotionPath(uv, texelSize, frameOffset);
    pastUV = clamp(pastUV, 0.001, 0.999);

    // Sample the ghost
    vec4 ghost = texture2D(u_texture, pastUV);

    // Exponential decay weight
    float weight = pow(1.0 - decayRate, frameOffset);

    // Temporal phase modulation: ghosts flicker slightly
    // Models the quantization noise floor in P-frame residuals
    float phase = hash11(frameOffset * 7.3 + fract(u_time * 8.0));
    float flicker = 0.85 + 0.15 * phase;

    return ghost * weight * flicker;
}

// ---------------------------------------------------------------------------
// Residual Smear Direction
//
// In real datamosh, the smear direction depends on the motion vectors
// in the P-frames. The residual energy trails behind the motion.
// We use the gradient to estimate this direction and add a time-varying
// component to simulate the evolution of the motion field over the GOP.
// ---------------------------------------------------------------------------
vec2 residualSmearDir(vec2 uv, float t) {
    float scale = 2.0;
    float sx = fbm2(uv * scale + vec2(t * 0.2, 0.0));
    float sy = fbm2(uv * scale + vec2(0.0, t * 0.17) + vec2(5.1, 2.9));
    return vec2(sx, sy) * u_residual_scale * 0.05;
}

// ---------------------------------------------------------------------------
// Macroblock Residual Quantization Effect
//
// In H.264, residuals are DCT-transformed and quantized before encoding.
// When prediction is bad (datamosh), the DCT coefficients are large
// and the quantization error is visible. This manifests as:
//   - Block-level posterization (coefficient truncation)
//   - High-frequency ringing at block boundaries
//   - Overall luminance bias in affected blocks
//
// We model this as per-macroblock posterization of the ghost color.
// ---------------------------------------------------------------------------
vec4 quantizeResiual(vec4 ghost, vec2 uv, float energy) {
    float mbSize = 8.0; // Use 8x8 DCT block size
    vec2 mbCoord = floor(uv * u_resolution / mbSize);
    float mbID = hash21(mbCoord);

    // Posterization levels inversely proportional to residual energy
    // (high energy = coarse quantization = few distinct levels)
    float levels = mix(32.0, 4.0, energy * u_residual_scale);
    vec3 quantized = floor(ghost.rgb * levels + 0.5) / levels;

    // Blend: high-energy regions get more posterization
    ghost.rgb = mix(ghost.rgb, quantized, energy * 0.7);
    return ghost;
}

// ---------------------------------------------------------------------------
// Main Fragment
// ---------------------------------------------------------------------------
void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;
    vec2 texelSize = 1.0 / u_resolution;

    // Current frame sample (the "present" — no decay, full weight)
    vec4 currentFrame = texture2D(u_texture, uv);

    // Residual energy at this pixel
    float energy = residualEnergy(uv, texelSize);

    // Smear direction
    vec2 smearDir = residualSmearDir(uv, u_time);

    // ---------------------------------------------------------------------------
    // Accumulate ghost layers
    //
    // Each layer represents one "virtual past frame." We accumulate up to 8 layers
    // (simulating a moderate GOP length of 8–12 frames before the I-frame).
    //
    // In real datamosh, the number of ghost layers ≈ distance from last I-frame.
    // The decay parameter controls how quickly earlier frames fade out.
    // ---------------------------------------------------------------------------
    vec4 ghostAccum   = vec4(0.0);
    float totalWeight = 0.0;
    float decayRate   = clamp(u_decay, 0.05, 0.95);
    int   numGhosts   = 8;

    for (int i = 1; i <= 8; i++) {
        if (i > numGhosts) break;

        float fi = float(i);

        // Add smear displacement that accumulates with each ghost layer
        vec2 smearUV = uv + smearDir * fi;
        smearUV = clamp(smearUV, 0.001, 0.999);

        // Sample ghost at displaced UV
        vec2 pastUV = smearUV - estimatedMotionPath(smearUV, texelSize, fi);
        pastUV = clamp(pastUV, 0.001, 0.999);

        vec4 ghost = texture2D(u_texture, pastUV);

        // Apply residual quantization to the ghost
        ghost = quantizeResiual(ghost, smearUV, energy);

        float weight = pow(1.0 - decayRate, fi);

        ghostAccum   += ghost * weight;
        totalWeight  += weight;
    }

    // Normalize accumulated ghost
    vec4 normalizedGhost = (totalWeight > 0.001) ? ghostAccum / totalWeight : currentFrame;

    // ---------------------------------------------------------------------------
    // Blend ghost with current frame
    //
    // The blend is weighted by:
    //   1. u_ghost_intensity: overall user-controlled intensity
    //   2. residual energy: high-energy (edge) regions show more ghost
    //
    // This mirrors the codec: regions with high residual energy contribute
    // more to the visible artifact.
    // ---------------------------------------------------------------------------
    float blendFactor = u_ghost_intensity * (0.4 + 0.6 * energy);
    vec4 result = mix(currentFrame, normalizedGhost, blendFactor);

    // ---------------------------------------------------------------------------
    // Residual color cast
    //
    // Accumulated prediction error has a characteristic color bias.
    // In over-compressed video, error residuals tend to be blue-shifted
    // (the B channel is last in 4:2:0 processing and accumulates the most error).
    // We add a subtle blue/cyan cast to the ghost overlay.
    // ---------------------------------------------------------------------------
    float residualCast = blendFactor * u_residual_scale * 0.1;
    result.rgb += vec3(-residualCast * 0.3, residualCast * 0.1, residualCast);

    // ---------------------------------------------------------------------------
    // Temporal dithering
    // Adds subtle frame-to-frame variation to prevent static "baked" look
    // ---------------------------------------------------------------------------
    float dither = (hash21(uv * u_resolution + fract(u_time * 60.0)) - 0.5) * 0.02;
    result.rgb += dither * u_ghost_intensity;

    result.rgb = clamp(result.rgb, 0.0, 1.0);
    gl_FragColor = result;
}
