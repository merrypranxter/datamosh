// =============================================================================
// block_artifact_bleed.frag
// Macroblock Boundary Distortion — GLSL ES 1.0 Fragment Shader
//
// Simulates the "blocky" look of over-compressed or corrupted video by making
// macroblock boundaries the primary visual element rather than hiding them.
//
// In H.264, the frame is divided into macroblocks (MBs) — typically 16×16
// pixel units that are the atomic unit of encoding. Each macroblock is
// independently quantized (DCT coefficients are rounded), motion-compensated,
// and entropy-coded. When quantization is aggressive (low bitrate), three
// visible artifacts emerge:
//
//   1. BLOCKING: Each macroblock becomes a uniform patch of color because
//      high-frequency DCT coefficients (the ones that encode fine detail)
//      are quantized to zero. The block boundary becomes visible.
//
//   2. RINGING: At block boundaries, energy "leaks" from adjacent blocks
//      via the inverse DCT, causing oscillating halos around edges.
//
//   3. COLOR CHANNEL SEPARATION: Chroma (4:2:0) is processed at half
//      resolution and sometimes drifts out of alignment with luma.
//
// This shader makes all three effects INTENTIONAL and EXAGGERATED.
//
// Uniforms:
//   u_time       — Animation clock in seconds
//   u_resolution — Viewport dimensions in pixels
//   u_texture    — Source image/frame
//   u_block_size — Simulated macroblock size in pixels (8, 16, 32)
//   u_ringing    — DCT ringing intensity (0.0–1.0)
//   u_chroma_drift — Color channel separation per block (0.0–1.0)
// =============================================================================

#ifdef GL_ES
precision mediump float;
#endif

// ---------------------------------------------------------------------------
// Uniforms
// ---------------------------------------------------------------------------
uniform float     u_time;
uniform vec2      u_resolution;
uniform sampler2D u_texture;
uniform float     u_block_size;    // Macroblock size in pixels [8 .. 64]
uniform float     u_ringing;       // DCT ringing intensity [0.0 .. 1.0]
uniform float     u_chroma_drift;  // Per-block color channel offset [0.0 .. 1.0]

// ---------------------------------------------------------------------------
// Hash Primitives (same family as glitchcore.frag — consistent aesthetic)
// ---------------------------------------------------------------------------
float hash11(float n) {
    return fract(sin(n) * 43758.5453123);
}

float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

vec2 hash21v(vec2 p) {
    float h = hash21(p);
    return vec2(fract(h * 127.1), fract(h * 311.7)) * 2.0 - 1.0;
}

// ---------------------------------------------------------------------------
// Block Coordinate System
//
// Maps a pixel UV to its macroblock address (which block it's in) and
// its local sub-block coordinate (where it is within that block).
//
// This mirrors the H.264 partitioning scheme where each MB has a:
//   - mb_addr (macroblock address) = integer grid position
//   - sub_mb_part (partition within MB) = local pixel offset
// ---------------------------------------------------------------------------
struct BlockCoords {
    vec2  blockAddr;   // Integer grid cell of the macroblock
    vec2  localUV;     // Position within the block [0,1]²
    vec2  blockUV;     // UV of the block's top-left corner in [0,1]² space
    float blockID;     // Unique scalar ID for this block (for per-block randomness)
};

BlockCoords getBlockCoords(vec2 uv, float blockSizePx) {
    BlockCoords bc;

    // Pixel position
    vec2 pixelPos = uv * u_resolution;

    // Block address in pixel units (which block are we in?)
    bc.blockAddr = floor(pixelPos / blockSizePx);

    // Local UV within the block — position within the MB [0,1]²
    bc.localUV = fract(pixelPos / blockSizePx);

    // UV of the top-left corner of this block (in texture space)
    bc.blockUV = bc.blockAddr * blockSizePx / u_resolution;

    // Unique ID for this block — used to randomize per-block behavior
    // Analogous to mb_addr in H.264 slice headers
    bc.blockID = hash21(bc.blockAddr);

    return bc;
}

// ---------------------------------------------------------------------------
// DCT Quantization Ringing Simulation
//
// Real DCT ringing (Gibbs phenomenon / mosquito noise) occurs because:
//   1. The DCT represents a block as a sum of cosine basis functions
//   2. Quantization zeroes out high-frequency coefficients
//   3. The inverse DCT of the truncated series oscillates near sharp edges
//
// We simulate this by adding a small sinusoidal oscillation that is
// strongest near block boundaries and decays toward the center.
// The frequency of the oscillation corresponds to the DCT coefficient
// that was removed (N=8 block → 8th harmonic etc.)
// ---------------------------------------------------------------------------
float dctRinging(vec2 localUV, float blockSizePx, float intensity) {
    // Distance from nearest block edge, normalized [0, 0.5]
    vec2 edgeDist = 0.5 - abs(localUV - 0.5);
    float minEdgeDist = min(edgeDist.x, edgeDist.y);

    // Ringing decays exponentially away from the edge
    float edgeWeight = exp(-minEdgeDist * 8.0 * (8.0 / blockSizePx));

    // Oscillation frequency based on block size
    // 8px block → fast oscillation; 32px block → slower oscillation
    float freq = 3.14159 * (16.0 / blockSizePx);
    float ring = sin(localUV.x * freq * 2.0) * sin(localUV.y * freq * 2.0);

    return ring * edgeWeight * intensity * 0.08;
}

// ---------------------------------------------------------------------------
// Block Boundary Detection
//
// Returns a value near 1.0 at block boundaries, 0.0 in block interiors.
// Used to make the grid lines visible and to drive warping effects.
// ---------------------------------------------------------------------------
float blockBoundary(vec2 localUV, float lineWidth) {
    vec2 edgeDist = min(localUV, 1.0 - localUV);
    float border = min(edgeDist.x, edgeDist.y);
    return 1.0 - smoothstep(0.0, lineWidth, border);
}

// ---------------------------------------------------------------------------
// Per-Block Quantization Displacement
//
// Each macroblock gets its own quantization parameter (QP) in H.264.
// Higher QP = more aggressive quantization = more information lost.
// We model this as per-block random displacement — some blocks are
// "heavily quantized" and their content drifts significantly from
// neighboring blocks.
//
// This is most visible at scene transitions in compressed video:
// some MBs get QP=51 (maximum loss) while adjacent ones get QP=18
// (almost lossless), creating visible "patches" of quality.
// ---------------------------------------------------------------------------
vec2 blockQuantDisplacement(BlockCoords bc, float intensity) {
    // Per-block random motion direction
    vec2 dir = hash21v(bc.blockAddr) * intensity * 0.03;

    // Time-based jitter: quantization noise isn't static —
    // it varies frame-to-frame as the QP changes in each GOP
    float jitter = hash11(bc.blockID + floor(u_time * 12.0)) * 0.5 - 0.25;
    dir *= (1.0 + jitter * 0.3);

    return dir;
}

// ---------------------------------------------------------------------------
// Per-Block Color Channel Separation
//
// In 4:2:0 chroma subsampling, luma (Y) is full resolution but chroma
// (Cb, Cr) is stored at half resolution. Motion compensation is also
// done separately for luma and chroma. Under heavy compression or
// corruption, the chroma channels drift from the luma channel.
//
// We simulate this by applying different texture offsets to R, G, B
// channels, with the offset magnitude randomized per block.
// ---------------------------------------------------------------------------
vec4 perBlockChromaSplit(vec2 baseUV, BlockCoords bc, float driftIntensity) {
    // Per-block drift: each block has a unique chroma offset direction
    vec2 chromaDir = hash21v(bc.blockAddr + vec2(7.3, 13.7));
    float driftMag = hash11(bc.blockID * 3.7) * driftIntensity * 0.012;

    // Luma proxy (G channel) — no drift, represents Y component
    float g = texture2D(u_texture, baseUV).g;

    // Cb proxy (B channel) — chroma plane 1 drift
    float b = texture2D(u_texture, clamp(baseUV + chromaDir * driftMag, 0.001, 0.999)).b;

    // Cr proxy (R channel) — chroma plane 2 drift (opposite direction models 4:2:0 interpolation)
    float r = texture2D(u_texture, clamp(baseUV - chromaDir * driftMag * 0.7, 0.001, 0.999)).r;

    float a = texture2D(u_texture, baseUV).a;
    return vec4(r, g, b, a);
}

// ---------------------------------------------------------------------------
// Block Warp Animation
//
// Over time, each block independently shifts/drifts. This simulates
// the behavior seen when a decoder processes a corrupted bitstream:
// individual macroblocks "slip" from their correct position when
// the motion vector data is malformed or missing.
// ---------------------------------------------------------------------------
vec2 blockWarpOffset(BlockCoords bc, float t) {
    // Each block has a different temporal phase — they don't all move together
    float phase = bc.blockID * 6.283;

    // Low-frequency oscillation — blocks drift, not jitter
    float warpX = sin(t * 0.8 + phase) * 0.004;
    float warpY = cos(t * 0.6 + phase * 1.3) * 0.003;

    // Only some blocks warp (simulating selective MB corruption)
    // Threshold: ~30% of blocks get significant warp
    float warpMask = step(0.7, hash11(bc.blockID * 1.7 + floor(t * 0.5)));

    return vec2(warpX, warpY) * warpMask;
}

// ---------------------------------------------------------------------------
// Main Fragment
// ---------------------------------------------------------------------------
void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;

    // Ensure block size is a valid power-of-two-ish value (8, 16, 32, 64)
    float bSize = clamp(u_block_size, 4.0, 64.0);

    // Get block coordinate system for this fragment
    BlockCoords bc = getBlockCoords(uv, bSize);

    // -------------------------------------------------------------------------
    // Step 1: Compute per-block displacement
    // -------------------------------------------------------------------------
    vec2 quantDisp  = blockQuantDisplacement(bc, u_chroma_drift);
    vec2 warpOffset = blockWarpOffset(bc, u_time);
    vec2 totalDisp  = quantDisp + warpOffset;

    // Apply displacement to base UV
    vec2 displacedUV = clamp(uv + totalDisp, 0.001, 0.999);

    // -------------------------------------------------------------------------
    // Step 2: Sample with per-block chroma separation
    // -------------------------------------------------------------------------
    vec4 baseColor = perBlockChromaSplit(displacedUV, bc, u_chroma_drift);

    // -------------------------------------------------------------------------
    // Step 3: DCT ringing at block boundaries
    // -------------------------------------------------------------------------
    float ring = dctRinging(bc.localUV, bSize, u_ringing);
    baseColor.rgb += ring * vec3(0.8, 0.9, 1.0); // Ring is slightly blue-biased (matches codec artifacts)

    // -------------------------------------------------------------------------
    // Step 4: Block boundary visualization
    // Exaggerates the MB grid — a line that in normal video would be invisible
    // becomes the primary structural element of the image.
    // Line width scales with block size (larger blocks = thicker visible boundary)
    // -------------------------------------------------------------------------
    float lineWidth = 1.5 / bSize;
    float boundary  = blockBoundary(bc.localUV, lineWidth);

    // Boundary color: desaturated with slight luminance boost
    // (models the "ghosting" at block edges in heavily compressed MPEG video)
    vec3 boundaryColor = vec3(0.75, 0.8, 0.85) * (1.0 + ring * 0.5);
    baseColor.rgb = mix(baseColor.rgb, boundaryColor, boundary * 0.35 * u_ringing);

    // -------------------------------------------------------------------------
    // Step 5: Quantization posterization
    // Heavily-quantized macroblocks reduce to a small number of distinct values.
    // We simulate this with per-block posterization — the depth of the
    // posterization is randomized per block (models adaptive QP).
    // -------------------------------------------------------------------------
    float posterLevels = mix(32.0, 4.0, hash11(bc.blockID * 2.3) * u_chroma_drift);
    vec3 posterized = floor(baseColor.rgb * posterLevels + 0.5) / posterLevels;
    baseColor.rgb = mix(baseColor.rgb, posterized, u_chroma_drift * 0.6);

    // -------------------------------------------------------------------------
    // Step 6: Temporal flicker on "corrupted" blocks
    // Some blocks flicker as if they're being decoded from malformed data.
    // This approximates decode errors where a block's prediction mode
    // switches between frame and field coding unexpectedly.
    // -------------------------------------------------------------------------
    float flickerRate = 8.0 + hash11(bc.blockID) * 16.0;
    float flicker     = step(0.5, fract(u_time * flickerRate + bc.blockID));
    float flickerMask = step(0.85, hash11(bc.blockID * 5.1 + floor(u_time * 2.0)));
    baseColor.rgb = mix(baseColor.rgb, baseColor.gbr, flicker * flickerMask * 0.4);

    gl_FragColor = baseColor;
}
