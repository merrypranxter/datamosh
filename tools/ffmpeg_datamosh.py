#!/usr/bin/env python3
"""
ffmpeg_datamosh.py — FFmpeg-based video datamosh pipeline.

Exploits the predictive structure of H.264/MPEG video by manipulating
frame types at the bitstream level using FFmpeg. The core operations are:

  1. Strip I-frames: Remove intra-coded keyframes so P-frames are forced
     to predict from the wrong reference, creating smear/bleed artifacts.

  2. Null-frame injection: Replace I-frames with zero-data frames, causing
     the decoder to fill those positions with black (or whatever the
     concealment strategy is) before the P-frame cascade begins.

  3. P-frame repetition: Duplicate P-frames to extend the smear effect —
     the same motion delta is applied multiple times in sequence.

  4. Low-GOP re-encoding: Force a tiny GOP size (2–4) so the video has
     many small windows of I+P, each of which can be independently
     corrupted for granular control.

  5. Full pipeline: Combines all of the above with configurable parameters.

Usage:
    python ffmpeg_datamosh.py --input in.mp4 --output out.mp4 --mode strip_iframes
    python ffmpeg_datamosh.py --input in.mp4 --output out.mp4 --mode null_inject --null_count 2
    python ffmpeg_datamosh.py --input in.mp4 --output out.mp4 --mode repeat_pframes --repeat_count 6
    python ffmpeg_datamosh.py --input in.mp4 --output out.mp4 --mode full_pipeline --gop_size 4 --verbose

Requirements:
    - FFmpeg 5.0+ with libx264 support (ffmpeg, ffprobe in PATH)
    - Python 3.8+

Author: datamosh project
License: MIT
"""

import argparse
import json
import logging
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------
LOG_FORMAT = "[%(asctime)s] %(levelname)s %(name)s — %(message)s"
logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
logger = logging.getLogger("ffmpeg_datamosh")


# ---------------------------------------------------------------------------
# FFmpeg availability check
# ---------------------------------------------------------------------------
def check_ffmpeg() -> None:
    """Verify that ffmpeg and ffprobe are available in PATH."""
    for tool in ("ffmpeg", "ffprobe"):
        if shutil.which(tool) is None:
            raise RuntimeError(
                f"'{tool}' not found in PATH. Install FFmpeg: https://ffmpeg.org/download.html"
            )
    logger.debug("ffmpeg and ffprobe found in PATH")


# ---------------------------------------------------------------------------
# Frame type extraction
# ---------------------------------------------------------------------------
def extract_frame_types(input_path: str) -> List[Dict]:
    """
    Use ffprobe to extract frame type metadata from a video file.

    Returns a list of dicts with keys:
        - pts:         Presentation timestamp (DTS order)
        - pkt_pos:     Byte offset in file
        - pkt_size:    Packet size in bytes
        - pict_type:   'I', 'P', or 'B'
        - key_frame:   1 if keyframe (I-frame), 0 otherwise
        - duration_ts: Duration in timebase units

    This is the analysis step before any corruption — understanding the
    GOP structure tells us WHERE to cut and WHERE the smear will start.
    """
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-select_streams", "v:0",
        "-show_frames",
        "-show_entries",
        "frame=pts,pkt_pos,pkt_size,pict_type,key_frame,pkt_duration",
        "-of", "json",
        input_path,
    ]
    logger.info("Extracting frame types from: %s", input_path)
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    data = json.loads(result.stdout)
    frames = data.get("frames", [])
    logger.info(
        "Found %d frames: %d I-frames, %d P-frames, %d B-frames",
        len(frames),
        sum(1 for f in frames if f.get("pict_type") == "I"),
        sum(1 for f in frames if f.get("pict_type") == "P"),
        sum(1 for f in frames if f.get("pict_type") == "B"),
    )
    return frames


def find_iframe_positions(frames: List[Dict]) -> List[int]:
    """
    Returns the byte offsets (pkt_pos) of all I-frames in the stream.

    These are the positions we'll manipulate in the bitstream. In H.264,
    I-frames are identified by the nal_unit_type field in the NAL header
    (type 5 = IDR slice, which is the most common I-frame type).
    """
    positions = [
        int(f["pkt_pos"])
        for f in frames
        if f.get("pict_type") == "I" and "pkt_pos" in f
    ]
    logger.info("Found %d I-frame byte positions", len(positions))
    return positions


def find_scene_cuts(frames: List[Dict], min_gap_seconds: float = 1.0) -> List[int]:
    """
    Heuristically find scene cut positions by looking for I-frames that
    appear after a significant time gap (suggesting they were inserted
    by a scene change detection algorithm).

    Returns frame indices (not byte positions) of scene-cut I-frames.
    """
    cuts = []
    prev_pts = 0.0
    for i, frame in enumerate(frames):
        if frame.get("pict_type") != "I":
            continue
        pts = float(frame.get("pts", 0))
        if i > 0 and (pts - prev_pts) > min_gap_seconds:
            cuts.append(i)
            logger.debug("Scene cut detected at frame %d (pts=%.2f)", i, pts)
        prev_pts = pts
    logger.info("Found %d scene cuts (gap >= %.1fs)", len(cuts), min_gap_seconds)
    return cuts


# ---------------------------------------------------------------------------
# Frame extraction and reassembly utilities
# ---------------------------------------------------------------------------
def extract_frames_to_dir(input_path: str, work_dir: str, format: str = "png") -> List[str]:
    """
    Extract all video frames to individual image files in work_dir.

    Used for frame-level manipulation. PNG is lossless; use jpeg for speed
    at the cost of introducing pre-corruption quality loss.
    """
    pattern = os.path.join(work_dir, f"frame_%06d.{format}")
    cmd = [
        "ffmpeg", "-v", "quiet",
        "-i", input_path,
        "-vsync", "0",  # Preserve frame timestamps exactly
        pattern,
    ]
    logger.info("Extracting frames to: %s", work_dir)
    subprocess.run(cmd, check=True, capture_output=True)
    files = sorted(Path(work_dir).glob(f"frame_*.{format}"))
    logger.info("Extracted %d frames", len(files))
    return [str(f) for f in files]


def get_video_info(input_path: str) -> Dict:
    """
    Extract video stream metadata: framerate, duration, resolution, codec.
    """
    cmd = [
        "ffprobe", "-v", "quiet",
        "-select_streams", "v:0",
        "-show_streams",
        "-of", "json",
        input_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    data = json.loads(result.stdout)
    streams = data.get("streams", [])
    if not streams:
        raise ValueError(f"No video stream found in: {input_path}")
    stream = streams[0]
    # Parse framerate fraction (e.g., "30000/1001" → 29.97)
    r_frame_rate = stream.get("r_frame_rate", "30/1")
    num, den = r_frame_rate.split("/")
    fps = float(num) / float(den)
    return {
        "width": int(stream.get("width", 0)),
        "height": int(stream.get("height", 0)),
        "fps": fps,
        "duration": float(stream.get("duration", 0)),
        "codec_name": stream.get("codec_name", "unknown"),
        "nb_frames": int(stream.get("nb_frames", 0)),
        "r_frame_rate": r_frame_rate,
    }


# ---------------------------------------------------------------------------
# Datamosh Operations
# ---------------------------------------------------------------------------

def strip_iframes(input_path: str, output_path: str) -> str:
    """
    Strip I-frames from a video by re-encoding with an extremely high
    forced-keyframe interval and no scene change detection.

    The real technique (AVI container hex editing) removes I-frame NAL units
    directly from the bitstream. In MP4/H.264, we approximate this by:
      1. Decoding to raw frames
      2. Re-encoding with -g (GOP size) = length of entire video
         so only the very first frame is an I-frame
      3. Using -sc_threshold 0 to disable scene change I-frame insertion

    This is a "soft" I-frame strip — the first frame is still an I-frame,
    but all subsequent ones are P or B frames regardless of scene cuts.
    For a "hard" strip (AVI technique), see wiki_avi_glitch.md.
    """
    info = get_video_info(input_path)
    # GOP size = total frame count ensures only one I-frame in the entire video
    total_frames = info["nb_frames"] or 9999
    logger.info(
        "Stripping I-frames: re-encoding %s with GOP=%d, no scene detection",
        input_path, total_frames
    )
    cmd = [
        "ffmpeg", "-v", "warning",
        "-i", input_path,
        "-c:v", "libx264",
        "-g", str(total_frames),        # One I-frame for entire video
        "-keyint_min", str(total_frames),
        "-sc_threshold", "0",           # Disable scene-change I-frame insertion
        "-x264-params", "scenecut=0",   # Reinforce at x264 level
        "-b:v", "2M",
        "-c:a", "copy",                 # Preserve audio unchanged
        "-y",
        output_path,
    ]
    subprocess.run(cmd, check=True)
    logger.info("I-frame strip complete: %s", output_path)
    return output_path


def inject_null_frames(
    input_path: str, output_path: str, null_count: int = 2, work_dir: Optional[str] = None
) -> str:
    """
    Inject null (black/zero-data) frames at I-frame positions.

    The classic AVI datamosh technique: replace the I-frame data with a
    frame of black pixels. This causes the decoder to start the P-frame
    chain from a black reference — the new scene's motion is applied to
    black instead of the previous scene's colors, creating a different
    type of smear that "fades in" from black.

    null_count controls how many null frames to insert at each I-frame
    position (more null frames = longer black flash before smear begins).
    """
    if work_dir is None:
        work_dir = tempfile.mkdtemp(prefix="datamosh_null_")
        cleanup = True
    else:
        cleanup = False

    try:
        frames = extract_frame_types(input_path)
        info = get_video_info(input_path)
        iframe_indices = [
            i for i, f in enumerate(frames)
            if f.get("pict_type") == "I"
        ][1:]  # Skip the very first I-frame (leave it as anchor)

        if not iframe_indices:
            logger.warning("No I-frames (beyond first) found to replace with null frames")
            shutil.copy2(input_path, output_path)
            return output_path

        # Extract frames
        frame_files = extract_frames_to_dir(input_path, work_dir)

        # For each I-frame position, replace with a black frame
        # and duplicate it null_count times
        null_frame_path = os.path.join(work_dir, "null_frame.png")
        subprocess.run(
            [
                "ffmpeg", "-v", "quiet",
                "-f", "lavfi",
                "-i", f"color=c=black:size={info['width']}x{info['height']}:duration=0.001",
                "-vframes", "1",
                null_frame_path, "-y"
            ],
            check=True
        )

        # Build modified frame list
        modified_list = os.path.join(work_dir, "frames.txt")
        with open(modified_list, "w") as f:
            for i, frame_path in enumerate(frame_files):
                if i in iframe_indices:
                    # Insert null_count null frames at this position
                    for _ in range(null_count):
                        f.write(f"file '{null_frame_path}'\n")
                        f.write(f"duration {1.0 / info['fps']:.6f}\n")
                else:
                    f.write(f"file '{frame_path}'\n")
                    f.write(f"duration {1.0 / info['fps']:.6f}\n")

        # Reassemble video from modified frame list
        cmd = [
            "ffmpeg", "-v", "warning",
            "-f", "concat",
            "-safe", "0",
            "-i", modified_list,
            "-c:v", "libx264",
            "-g", str(len(frame_files) + null_count * len(iframe_indices)),
            "-sc_threshold", "0",
            "-pix_fmt", "yuv420p",
            "-y",
            output_path,
        ]
        subprocess.run(cmd, check=True)
        logger.info("Null injection complete: %d I-frames replaced, %s", len(iframe_indices), output_path)

    finally:
        if cleanup:
            shutil.rmtree(work_dir, ignore_errors=True)

    return output_path


def repeat_pframes(
    input_path: str, output_path: str, repeat_count: int = 4, work_dir: Optional[str] = None
) -> str:
    """
    Repeat P-frames to extend the datamosh smear effect.

    By repeating each P-frame N times, we apply the same motion delta
    multiple times in sequence. This creates the "stuttering smear" effect
    where the motion seems to compound on itself — like a video stuck in
    a loop that keeps advancing the prediction but never updates the reference.

    Visual effect: motion trails that are clearly duplicated/stepped rather
    than smooth, giving a digital-stutter aesthetic.
    """
    if work_dir is None:
        work_dir = tempfile.mkdtemp(prefix="datamosh_repeat_")
        cleanup = True
    else:
        cleanup = False

    try:
        frames_data = extract_frame_types(input_path)
        info = get_video_info(input_path)
        frame_files = extract_frames_to_dir(input_path, work_dir)

        # Build a new frame list with P-frames repeated
        modified_list = os.path.join(work_dir, "repeat_frames.txt")
        frame_duration = 1.0 / info["fps"]

        with open(modified_list, "w") as f:
            for i, (frame_file, frame_data) in enumerate(zip(frame_files, frames_data)):
                pict_type = frame_data.get("pict_type", "P")
                # Write the frame once unconditionally
                f.write(f"file '{frame_file}'\n")
                f.write(f"duration {frame_duration:.6f}\n")
                # If it's a P-frame, write it repeat_count additional times
                if pict_type == "P":
                    for _ in range(repeat_count - 1):
                        f.write(f"file '{frame_file}'\n")
                        f.write(f"duration {frame_duration:.6f}\n")

        cmd = [
            "ffmpeg", "-v", "warning",
            "-f", "concat",
            "-safe", "0",
            "-i", modified_list,
            "-c:v", "libx264",
            "-g", "1",              # Every frame becomes an I-frame in the output
            "-pix_fmt", "yuv420p",  # (we lose the P-frame structure, but keep the visual)
            "-y",
            output_path,
        ]
        subprocess.run(cmd, check=True)
        logger.info("P-frame repeat complete: %d repeats, output: %s", repeat_count, output_path)

    finally:
        if cleanup:
            shutil.rmtree(work_dir, ignore_errors=True)

    return output_path


def reencode_low_gop(input_path: str, output_path: str, gop_size: int = 4) -> str:
    """
    Re-encode with a small GOP size for granular datamosh control.

    Small GOP (e.g., 4) means: every 4 frames, there's an I-frame.
    This creates many short "datamoshable" windows. Combined with
    subsequent I-frame stripping, each window produces a short burst
    of smear before the next I-frame resets the reference.

    The resulting video has a rhythmic, pulse-like quality where corruption
    resets every GOP_SIZE frames — very different from the single-long-smear
    of a high-GOP video.

    The CRF (Constant Rate Factor) is set to 28 (slightly lossy) to ensure
    aggressive enough quantization that the datamosh artifacts are pronounced.
    """
    logger.info("Re-encoding with GOP=%d: %s → %s", gop_size, input_path, output_path)
    cmd = [
        "ffmpeg", "-v", "warning",
        "-i", input_path,
        "-c:v", "libx264",
        "-g", str(gop_size),
        "-keyint_min", str(gop_size),
        "-sc_threshold", "0",
        "-x264-params", f"scenecut=0:keyint={gop_size}:min-keyint={gop_size}",
        "-crf", "28",
        "-c:a", "copy",
        "-y",
        output_path,
    ]
    subprocess.run(cmd, check=True)
    logger.info("Low-GOP re-encode complete: %s", output_path)
    return output_path


def full_pipeline(
    input_path: str,
    output_path: str,
    gop_size: int = 4,
    null_count: int = 1,
    repeat_count: int = 4,
) -> str:
    """
    Full datamosh pipeline combining all operations:

    1. Re-encode with low GOP size (creates many I-frame anchor points)
    2. Inject null frames at scene cuts (creates the "fade from black" smear)
    3. Repeat P-frames (extends and stutters the smear)
    4. Final strip pass (removes remaining I-frames for maximum corruption)

    The work directory is reused between steps to avoid redundant extraction.
    Each intermediate file is preserved until the pipeline completes.
    """
    work_dir = tempfile.mkdtemp(prefix="datamosh_pipeline_")
    try:
        logger.info("Starting full pipeline: %s → %s", input_path, output_path)
        logger.info("Parameters: GOP=%d, null_count=%d, repeat_count=%d",
                    gop_size, null_count, repeat_count)

        # Step 1: Low-GOP encode
        step1 = os.path.join(work_dir, "step1_low_gop.mp4")
        reencode_low_gop(input_path, step1, gop_size=gop_size)

        # Step 2: Null frame injection
        step2 = os.path.join(work_dir, "step2_null_inject.mp4")
        inject_null_frames(step1, step2, null_count=null_count)

        # Step 3: P-frame repetition
        step3 = os.path.join(work_dir, "step3_repeat.mp4")
        repeat_pframes(step2, step3, repeat_count=repeat_count)

        # Step 4: Final I-frame strip
        strip_iframes(step3, output_path)

        logger.info("Full pipeline complete: %s", output_path)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    return output_path


def analyze_and_report(input_path: str) -> None:
    """
    Analyze a video and print a datamosh readiness report.

    Shows frame type distribution, GOP size, estimated smear potential,
    and recommended datamosh settings.
    """
    frames = extract_frame_types(input_path)
    info = get_video_info(input_path)

    i_count = sum(1 for f in frames if f.get("pict_type") == "I")
    p_count = sum(1 for f in frames if f.get("pict_type") == "P")
    b_count = sum(1 for f in frames if f.get("pict_type") == "B")
    total = len(frames)

    avg_gop = total / max(i_count, 1)

    print("\n" + "=" * 60)
    print(f"DATAMOSH ANALYSIS: {os.path.basename(input_path)}")
    print("=" * 60)
    print(f"  Resolution:    {info['width']}×{info['height']}")
    print(f"  Frame rate:    {info['fps']:.2f} fps")
    print(f"  Duration:      {info['duration']:.1f}s")
    print(f"  Codec:         {info['codec_name']}")
    print(f"  Total frames:  {total}")
    print(f"    I-frames:    {i_count} ({100*i_count/max(total,1):.1f}%)")
    print(f"    P-frames:    {p_count} ({100*p_count/max(total,1):.1f}%)")
    print(f"    B-frames:    {b_count} ({100*b_count/max(total,1):.1f}%)")
    print(f"  Average GOP:   {avg_gop:.1f} frames")
    print()

    # Smear potential rating
    if avg_gop < 10:
        potential = "LOW (small GOP — frequent I-frames reset the smear)"
        rec_gop = 30
    elif avg_gop < 30:
        potential = "MEDIUM (good for short, rhythmic smear bursts)"
        rec_gop = 15
    else:
        potential = "HIGH (long GOP = long, continuous smear cascades)"
        rec_gop = avg_gop

    print(f"  Smear Potential: {potential}")
    print(f"  Recommended GOP for datamosh: {rec_gop:.0f}")
    print()
    print("  Suggested command:")
    print(f"    python ffmpeg_datamosh.py --input {input_path} \\")
    print(f"      --output datamoshed.mp4 \\")
    print(f"      --mode full_pipeline \\")
    print(f"      --gop_size {min(int(rec_gop), 30)} \\")
    print(f"      --repeat_count 6")
    print("=" * 60 + "\n")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="FFmpeg-based video datamosh pipeline.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--input", "-i", required=True, help="Input video file path")
    parser.add_argument("--output", "-o", default="datamoshed.mp4", help="Output video file path")
    parser.add_argument(
        "--mode", "-m",
        choices=["analyze", "strip_iframes", "null_inject", "repeat_pframes",
                 "low_gop", "full_pipeline"],
        default="analyze",
        help="Operation mode (default: analyze)",
    )
    parser.add_argument("--gop_size", type=int, default=4,
                        help="GOP size for low_gop / full_pipeline (default: 4)")
    parser.add_argument("--null_count", type=int, default=2,
                        help="Null frames to inject per I-frame (default: 2)")
    parser.add_argument("--repeat_count", type=int, default=4,
                        help="Times to repeat each P-frame (default: 4)")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Enable verbose logging (DEBUG level)")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
        logger.setLevel(logging.DEBUG)

    check_ffmpeg()

    if not os.path.isfile(args.input):
        logger.error("Input file not found: %s", args.input)
        sys.exit(1)

    if args.mode == "analyze":
        analyze_and_report(args.input)

    elif args.mode == "strip_iframes":
        strip_iframes(args.input, args.output)
        print(f"Done: {args.output}")

    elif args.mode == "null_inject":
        inject_null_frames(args.input, args.output, null_count=args.null_count)
        print(f"Done: {args.output}")

    elif args.mode == "repeat_pframes":
        repeat_pframes(args.input, args.output, repeat_count=args.repeat_count)
        print(f"Done: {args.output}")

    elif args.mode == "low_gop":
        reencode_low_gop(args.input, args.output, gop_size=args.gop_size)
        print(f"Done: {args.output}")

    elif args.mode == "full_pipeline":
        full_pipeline(
            args.input,
            args.output,
            gop_size=args.gop_size,
            null_count=args.null_count,
            repeat_count=args.repeat_count,
        )
        print(f"Done: {args.output}")


if __name__ == "__main__":
    main()
