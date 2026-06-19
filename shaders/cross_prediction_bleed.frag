// cross_prediction_bleed.frag
// Two-texture shader simulating the classic datamosh failure mode: a
// P-frame's motion vectors (derived here from u_texture_a) are applied to
// the wrong reference image (u_texture_b), so scene B's pixel data gets
// dragged along scene A's motion field.

precision highp float;

uniform float u_time;
uniform vec2  u_resolution;
uniform sampler2D u_texture_a; // source of the motion field (the "old" scene)
uniform sampler2D u_texture_b; // source of the pixel data being mispredicted (the "new" scene)
uniform float u_blend_ratio;        // 0.0 = pure B, 1.0 = pure A, e.g. 0.5 typical
uniform float u_displacement_scale; // how strongly A's gradient displaces B's sampling, e.g. 0.0 - 0.1

varying vec2 v_uv;

vec2 motionFromLuma(vec2 uv) {
    float eps = 1.0 / u_resolution.x;
    float lx1 = dot(texture2D(u_texture_a, uv + vec2(eps, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
    float lx0 = dot(texture2D(u_texture_a, uv - vec2(eps, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
    float ly1 = dot(texture2D(u_texture_a, uv + vec2(0.0, eps)).rgb, vec3(0.299, 0.587, 0.114));
    float ly0 = dot(texture2D(u_texture_a, uv - vec2(0.0, eps)).rgb, vec3(0.299, 0.587, 0.114));
    return vec2(lx1 - lx0, ly1 - ly0);
}

void main() {
    vec2 uv = v_uv;

    vec2 motion = motionFromLuma(uv) * u_displacement_scale;
    vec3 predicted = texture2D(u_texture_b, uv + motion * sin(u_time * 0.5)).rgb;
    vec3 reference = texture2D(u_texture_a, uv).rgb;

    vec3 color = mix(predicted, reference, u_blend_ratio);
    gl_FragColor = vec4(color, 1.0);
}
