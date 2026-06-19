#!/usr/bin/env python3
"""AV1/WebM-specific datamosh tool.

AV1 has no direct macroblock equivalent — instead it uses superblocks
(up to 128x128) subdivided into variable-size partitions, and its temporal
prediction units behave differently from H.264 motion compensation. This
script targets AV1's key frame ("KEY_FRAME") and inter frame
("INTER_FRAME") boundaries directly via ffprobe/ffmpeg, rather than
macroblock-grid logic.

Requires: ffmpeg and ffprobe built with libaom-av1 (or libsvtav1) support.
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


def run(cmd):
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(cmd)}\n{result.stderr}")
    return result.stdout


def require_tools():
    for binary in ("ffmpeg", "ffprobe"):
        if shutil.which(binary) is None:
            sys.exit(f"error: '{binary}' not found on PATH.")


def transcode_to_av1(src: Path, dst: Path, gop_size: int, crf: int):
    run([
        "ffmpeg", "-y", "-i", str(src),
        "-c:v", "libaom-av1", "-crf", str(crf), "-b:v", "0",
        "-g", str(gop_size), "-keyint_min", str(gop_size),
        "-an", str(dst),
    ])


def get_av1_frame_types(path: Path):
    """AV1 frames report as key_frame=1 for KEY_FRAME; other types are
    inferred from pict_type when available, otherwise treated as inter."""
    out = run([
        "ffprobe", "-v", "quiet", "-select_streams", "v:0",
        "-show_entries", "frame=key_frame,pict_type", "-of", "json", str(path),
    ])
    data = json.loads(out)
    frames = data.get("frames", [])
    return ["KEY" if f.get("key_frame") == 1 else "INTER" for f in frames]


def strip_key_frames(src: Path, dst: Path, keep_first: bool = True):
    frame_types = get_av1_frame_types(src)
    key_indices = [i for i, t in enumerate(frame_types) if t == "KEY"]
    drop_indices = key_indices[1:] if keep_first else key_indices

    if not drop_indices:
        print("No removable key frames found; copying source unchanged.")
        shutil.copy(src, dst)
        return

    select_expr = "+".join(f"eq(n\\,{i})" for i in drop_indices)
    run([
        "ffmpeg", "-y", "-i", str(src),
        "-vf", f"select='not({select_expr})',setpts=N/FRAME_RATE/TB",
        "-c:v", "libaom-av1", "-crf", "30", "-b:v", "0",
        "-an", str(dst),
    ])
    print(f"Dropped {len(drop_indices)} key frame(s) at positions {drop_indices}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="source video file (any ffmpeg-readable format)")
    parser.add_argument("output", type=Path, help="destination .webm/.mkv file")
    parser.add_argument("--gop-size", type=int, default=300,
                         help="key frame interval for the intermediate AV1 re-encode (default: 300)")
    parser.add_argument("--crf", type=int, default=28,
                         help="AV1 CRF for the intermediate encode, lower = higher quality (default: 28)")
    parser.add_argument("--keep-intermediate", type=Path, default=None,
                         help="optional path to save the intermediate AV1 re-encode")
    args = parser.parse_args()

    require_tools()

    intermediate = args.keep_intermediate or args.output.with_name(args.output.stem + "_intermediate.webm")

    print(f"[1/2] Re-encoding to AV1 with key frame interval {args.gop_size}...")
    transcode_to_av1(args.input, intermediate, args.gop_size, args.crf)

    print("[2/2] Stripping key frames...")
    strip_key_frames(intermediate, args.output)

    if not args.keep_intermediate:
        intermediate.unlink(missing_ok=True)

    print(f"Done: {args.output}")


if __name__ == "__main__":
    main()
