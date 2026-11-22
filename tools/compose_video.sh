#!/usr/bin/env bash
# 智路使用视频合成：帧序列 → 无声 MP4（东爷明确不要配乐，2026-11-21）
set -e
cd "$(dirname "$0")/.."
FRAMES=".chrome-tmp/video/frames"
OUT="zhilu-demo.mp4"

echo "[1/1] 合成帧序列 → 无声视频（30fps, H.264 CRF20）"
ffmpeg -y -framerate 30 -i "$FRAMES/%05d.png" \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
  -vf "scale=1280:720:flags=lanczos" \
  -an -movflags +faststart \
  "$OUT" 2>&1 | tail -3

echo "=== 成品 ==="
ls -lh "$OUT"
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_type,codec_name,width,height,r_frame_rate -of default=noprint_wrappers=1 "$OUT"
