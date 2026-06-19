// i_frame_repeater.frag
// Simulates the "frozen keyframe, continuing motion" datamosh effect:
// I-frame removal forces the decoder to keep displaying a stale reference
// while P-frame motion vectors keep dragging pixels around it.

precision highp float;

uniform float u_time;
uniform vec2  u_resolution;
uniform sampler2D u_texture;
uniform float u_freeze_interval;  // seconds between forced "I-frame" captures, e.g. 2.0 - 6.0
uniform float u_motion_strength;  // displacement applied while frozen, e.g. 0.0 - 0.05

varying vec2 v_uv;

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453123);
}

float noise(vec2 p, float t) {
    vec2 i = floor(p * 8.0);
    return hash(i + floor(t * 3.0));
}

void main() {
    vec2 uv = v_uv;

    // Quantizing time to the freeze interval is the equivalent of "the
    // decoder hasn't seen a fresh I-frame since the last capture point."
    float frozenTime = floor(u_time / u_freeze_interval) * u_freeze_interval;
    float sinceFreeze = u_time - frozenTime;

    float angle = noise(uv, frozenTime) * 6.2831853;
    vec2 driftDir = vec2(cos(angle), sin(angle));
    vec2 drift = driftDir * sinceFreeze * u_motion_strength;

    vec3 color = texture2D(u_texture, uv + drift).rgb;
    gl_FragColor = vec4(color, 1.0);
}
