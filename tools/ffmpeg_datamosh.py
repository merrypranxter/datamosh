#!/usr/bin/env python3
"""FFmpeg-based datamosh pipeline for H.264/MPEG-style video.

Pipeline:
  1. Re-encode the source with a deliberately small GOP and a forced
     keyframe interval, so we know exactly where I-frames land.
  2. Walk the encoded stream and either drop I-frames (after the first)
     or duplicate P-frames to extend the smear.
  3. Re-mux the doctored stream into a playable container.

This works at the *container/bitstream* level using ffmpeg/ffprobe
subprocess calls rather than a full custom decoder, which keeps it
practical while still producing genuine codec-level datamosh artifacts
(not a shader simulation).

Requires: ffmpeg and ffprobe on PATH.
"""

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def run(cmd):
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(cmd)}\n{result.stderr}")
    return result.stdout


def require_ffmpeg():
    for binary in ("ffmpeg", "ffprobe"):
        if shutil.which(binary) is None:
            sys.exit(f"error: '{binary}' not found on PATH. Install ffmpeg first.")


def transcode_with_gop(src: Path, dst: Path, gop_size: int):
    """Re-encode with a fixed, small GOP so I-frame positions are predictable."""
    run([
        "ffmpeg", "-y", "-i", str(src),
        "-c:v", "libx264", "-g", str(gop_size), "-keyint_min", str(gop_size),
        "-sc_threshold", "0", "-c:a", "copy",
        str(dst),
    ])


def get_frame_types(path: Path):
    """Return a list of frame type chars ('I', 'P', 'B') in stream order."""
    out = run([
        "ffprobe", "-v", "quiet", "-select_streams", "v:0",
        "-show_entries", "frame=pict_type", "-of", "json", str(path),
    ])
    data = json.loads(out)
    return [f["pict_type"] for f in data.get("frames", [])]


def strip_i_frames(src: Path, dst: Path, keep_first: bool = True):
    """Remove I-frames after the first one by re-muxing with a frame select
    filter, forcing the decoder to keep predicting from a stale reference."""
    frame_types = get_frame_types(src)
    i_indices = [i for i, t in enumerate(frame_types) if t == "I"]
    drop_indices = i_indices[1:] if keep_first else i_indices

    if not drop_indices:
        print("No removable I-frames found; copying source unchanged.")
        shutil.copy(src, dst)
        return

    select_expr = "+".join(f"eq(n\\,{i})" for i in drop_indices)
    run([
        "ffmpeg", "-y", "-i", str(src),
        "-vf", f"select='not({select_expr})',setpts=N/FRAME_RATE/TB",
        "-an", str(dst),
    ])
    print(f"Dropped {len(drop_indices)} I-frame(s) at positions {drop_indices}")


def duplicate_p_frames(src: Path, dst: Path, repeat: int):
    """Duplicate every frame `repeat` times to extend the smear/trail length."""
    run([
        "ffmpeg", "-y", "-i", str(src),
        "-vf", f"tmix=frames={repeat}:weights='1 0 0'" if repeat > 1 else "null",
        "-an", str(dst),
    ])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="source video file")
    parser.add_argument("output", type=Path, help="destination video file")
    parser.add_argument("--gop-size", type=int, default=240,
                         help="GOP size for the intermediate re-encode (default: 240, i.e. one I-frame per 10s @24fps)")
    parser.add_argument("--repeat-frames", type=int, default=1,
                         help="duplicate frames N times to extend smear length (default: 1, no duplication)")
    parser.add_argument("--keep-dir", type=Path, default=None,
                         help="keep intermediate files in this directory instead of a temp dir")
    args = parser.parse_args()

    require_ffmpeg()

    work_dir = Path(args.keep_dir) if args.keep_dir else Path(tempfile.mkdtemp(prefix="datamosh_"))
    work_dir.mkdir(parents=True, exist_ok=True)

    reencoded = work_dir / "01_reencoded.mp4"
    stripped = work_dir / "02_stripped.mp4"

    print(f"[1/3] Re-encoding with GOP size {args.gop_size}...")
    transcode_with_gop(args.input, reencoded, args.gop_size)

    print("[2/3] Stripping I-frames...")
    strip_i_frames(reencoded, stripped)

    print(f"[3/3] Writing final output ({args.output})...")
    if args.repeat_frames > 1:
        duplicate_p_frames(stripped, args.output, args.repeat_frames)
    else:
        shutil.copy(stripped, args.output)

    if not args.keep_dir:
        shutil.rmtree(work_dir, ignore_errors=True)

    print(f"Done: {args.output}")


if __name__ == "__main__":
    main()
