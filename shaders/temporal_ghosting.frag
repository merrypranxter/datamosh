// temporal_ghosting.frag
// Accumulates frame-to-frame residual error into a feedback buffer,
// mimicking how P-frames encode only the *difference* from a reference —
// and how those differences stack into trailing ghosts when the reference
// is wrong or stale. Requires a ping-pong framebuffer: u_previous_frame
// should be the output of this shader from the prior render pass.

precision highp float;

uniform float u_time;
uniform vec2  u_resolution;
uniform sampler2D u_texture;          // current "true" frame
uniform sampler2D u_previous_frame;   // this shader's own output, previous pass
uniform float u_decay;                // how fast ghosts fade, e.g. 0.85 - 0.98
uniform float u_residual_gain;        // amplification of frame-to-frame difference, e.g. 1.0 - 4.0

varying vec2 v_uv;

void main() {
    vec2 uv = v_uv;

    vec3 current = texture2D(u_texture, uv).rgb;
    vec3 previous = texture2D(u_previous_frame, uv).rgb;

    vec3 residual = (current - previous) * u_residual_gain;
    vec3 ghosted = previous * u_decay + residual;

    gl_FragColor = vec4(clamp(ghosted, 0.0, 1.0), 1.0);
}
