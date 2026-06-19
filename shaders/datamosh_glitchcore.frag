// datamosh_glitchcore.frag
// Simulates P-frame motion vector smear using a Perlin-ish flow field,
// without any real video codec involvement. The "compression level"
// uniform drives both the apparent block size and color quantization,
// echoing how real datamosh artifacts intensify as bitrate drops.

precision highp float;

uniform float u_time;
uniform vec2  u_resolution;
uniform sampler2D u_texture;
uniform float u_flow_intensity;   // strength of the directional smear, e.g. 0.0 - 2.0
uniform float u_smear_length;     // how many samples the smear trail accumulates, e.g. 1.0 - 16.0
uniform float u_compression_level; // 0.0 (clean) - 1.0 (heavily moshed)

varying vec2 v_uv;

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

vec2 flowField(vec2 uv, float t) {
    float angle = noise(uv * 3.0 + t * 0.15) * 6.2831853;
    return vec2(cos(angle), sin(angle));
}

vec3 quantize(vec3 color, float level) {
    float steps = mix(64.0, 6.0, level);
    return floor(color * steps + 0.5) / steps;
}

void main() {
    vec2 uv = v_uv;
    float blockSize = mix(1.0, 32.0, u_compression_level) / u_resolution.x;
    vec2 blockUv = floor(uv / blockSize) * blockSize;

    vec2 dir = flowField(blockUv, u_time);
    vec3 accum = vec3(0.0);
    float total = 0.0;

    for (float i = 0.0; i < 16.0; i += 1.0) {
        if (i >= u_smear_length) break;
        float t = i / max(u_smear_length - 1.0, 1.0);
        vec2 offset = dir * t * u_flow_intensity * 0.05;
        float weight = 1.0 - t;
        accum += texture2D(u_texture, uv - offset).rgb * weight;
        total += weight;
    }

    vec3 color = accum / max(total, 0.0001);
    color = quantize(color, u_compression_level);

    gl_FragColor = vec4(color, 1.0);
}
