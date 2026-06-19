// block_artifact_bleed.frag
// Simulates visible macroblock boundaries (as in over-compressed H.264/VP9)
// and lets them warp, shift, and split color channels per block — turning
// the DCT quantization grid into the primary visual element instead of a
// flaw to hide.

precision highp float;

uniform float u_time;
uniform vec2  u_resolution;
uniform sampler2D u_texture;
uniform float u_block_size;        // 8.0, 16.0, or 32.0 px, matching real macroblock sizes
uniform float u_channel_split;     // per-block RGB misalignment strength, e.g. 0.0 - 0.02
uniform float u_warp_strength;     // how much each block's sample point drifts, e.g. 0.0 - 1.0

varying vec2 v_uv;

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(269.5, 183.3))) * 43758.5453123);
}

void main() {
    vec2 px = v_uv * u_resolution;
    vec2 blockId = floor(px / u_block_size);
    vec2 blockUv = (blockId * u_block_size) / u_resolution;

    float jitterSeed = hash(blockId + floor(u_time * 4.0));
    vec2 jitter = (vec2(hash(blockId), hash(blockId + 7.3)) - 0.5) * u_warp_strength * (u_block_size / u_resolution);

    vec2 sampleUv = blockUv + jitter;

    float rShift = (hash(blockId + 1.0) - 0.5) * u_channel_split;
    float gShift = (hash(blockId + 2.0) - 0.5) * u_channel_split;
    float bShift = (hash(blockId + 3.0) - 0.5) * u_channel_split;

    float r = texture2D(u_texture, sampleUv + vec2(rShift, 0.0)).r;
    float g = texture2D(u_texture, sampleUv + vec2(gShift, 0.0)).g;
    float b = texture2D(u_texture, sampleUv + vec2(bShift, 0.0)).b;

    // Visible grid line at block boundaries, intensity rises with jitter.
    vec2 frac = fract(px / u_block_size);
    float edge = step(frac.x, 0.04) + step(frac.y, 0.04);
    float edgeGlow = clamp(edge, 0.0, 1.0) * jitterSeed * 0.15;

    vec3 color = vec3(r, g, b) + edgeGlow;
    gl_FragColor = vec4(color, 1.0);
}
