#!/usr/bin/env python3
"""Extract and visualize motion vectors from a video.

Uses ffmpeg's codec-level motion vector export (`-debug mv` /
`codec_debug=1`, exposed by the `ffprobe`-adjacent debug logging or the
`mestimate` filter when codec MVs aren't available) to pull per-block
motion data and render it as flow-field arrows over each frame. This is
useful for previewing which segments of a source will produce the most
dramatic smear before committing to a full datamosh pass.

Requires: ffmpeg (built with debug logging) and numpy. matplotlib is used
for the optional flow-field visualization (--visualize).

Note: ffmpeg does not expose raw motion vectors through a stable public
API. This script uses `-vf mestimate` to compute a motion-estimation
pass (independent of the source codec's own vectors) when source MVs
aren't extractable, which is a reasonable approximation for previewing
flow direction and magnitude.
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

import numpy as np


def require_ffmpeg():
    import shutil
    if shutil.which("ffmpeg") is None:
        sys.exit("error: 'ffmpeg' not found on PATH.")


def run_mestimate(src: Path, log_path: Path, method: str = "epzs", mb_size: int = 16):
    """Run ffmpeg's mestimate filter and capture per-block motion vector
    debug output to a log file."""
    cmd = [
        "ffmpeg", "-y", "-i", str(src),
        "-vf", f"mestimate=method={method}:mb_size={mb_size}",
        "-f", "null", "-",
    ]
    with open(log_path, "w") as log_file:
        subprocess.run(cmd, stderr=log_file, check=True)


MV_LINE_RE = re.compile(r"mv:\s*\(?(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)\)?")


def parse_motion_vectors(log_path: Path):
    """Parse (dx, dy) pairs out of ffmpeg's mestimate debug log.

    The exact log format varies by ffmpeg build; this regex is intentionally
    permissive and should be adapted if your build's debug output differs.
    """
    vectors = []
    with open(log_path) as f:
        for line in f:
            match = MV_LINE_RE.search(line)
            if match:
                dx, dy = float(match.group(1)), float(match.group(2))
                vectors.append((dx, dy))
    return np.array(vectors) if vectors else np.zeros((0, 2))


def summarize(vectors: np.ndarray):
    if len(vectors) == 0:
        print("No motion vectors parsed. Check that your ffmpeg build logs "
              "mestimate debug output, or adjust MV_LINE_RE for your build.")
        return
    magnitudes = np.linalg.norm(vectors, axis=1)
    angles = np.degrees(np.arctan2(vectors[:, 1], vectors[:, 0]))
    print(f"Parsed {len(vectors)} motion vectors")
    print(f"  mean magnitude:   {magnitudes.mean():.3f}")
    print(f"  max magnitude:    {magnitudes.max():.3f}")
    print(f"  dominant angle:   {angles.mean():.1f} deg")


def visualize(vectors: np.ndarray, out_path: Path, grid_hint: int = 32):
    import matplotlib.pyplot as plt

    n = len(vectors)
    side = max(int(np.sqrt(n)), 1)
    grid = vectors[: side * side].reshape(side, side, 2)

    fig, ax = plt.subplots(figsize=(6, 6))
    x, y = np.meshgrid(np.arange(side), np.arange(side))
    ax.quiver(x, y, grid[..., 0], -grid[..., 1], angles="xy", scale_units="xy", scale=1)
    ax.set_title("Motion vector flow field")
    ax.invert_yaxis()
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    print(f"Saved flow field visualization to {out_path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="source video file")
    parser.add_argument("--method", default="epzs",
                         choices=["esa", "tss", "tdls", "ntss", "fss", "ds", "hexbs", "epzs", "umh"],
                         help="ffmpeg mestimate motion estimation method (default: epzs)")
    parser.add_argument("--mb-size", type=int, default=16, help="macroblock size for estimation (default: 16)")
    parser.add_argument("--visualize", type=Path, default=None,
                         help="optional path to save a flow-field PNG visualization")
    parser.add_argument("--keep-log", type=Path, default=None,
                         help="optional path to keep the raw ffmpeg debug log")
    args = parser.parse_args()

    require_ffmpeg()

    log_path = args.keep_log or Path("/tmp/mv_debug.log")
    print(f"Running motion estimation ({args.method}, mb_size={args.mb_size})...")
    run_mestimate(args.input, log_path, args.method, args.mb_size)

    vectors = parse_motion_vectors(log_path)
    summarize(vectors)

    if args.visualize:
        visualize(vectors, args.visualize)

    if not args.keep_log:
        log_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
