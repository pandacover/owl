#!/usr/bin/env bash
# Makes the small sample files the end-to-end tests use.
# Usage: scripts/sample-media.sh [folder]   (default: ./.samples)
set -euo pipefail
out="${1:-.samples}"
mkdir -p "$out"
cd "$out"
q=(-hide_banner -loglevel error -y)

# 12s, four 3s scenes with hard cuts, and a click on every beat at 120 BPM.
ffmpeg "${q[@]}" \
  -f lavfi -i "smptebars=s=1280x720:r=30:d=3" \
  -f lavfi -i "testsrc2=s=1280x720:r=30:d=3" \
  -f lavfi -i "color=c=0x2255aa:s=1280x720:r=30:d=3" \
  -f lavfi -i "mandelbrot=s=1280x720:r=30,trim=duration=3" \
  -f lavfi -i "sine=f=1000:d=0.04:r=44100,apad=pad_dur=0.46,aloop=loop=23:size=22050,atrim=duration=12,volume=0.3" \
  -filter_complex "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,format=yuv420p[v];[4:a]adelay=460:all=1,atrim=duration=12[a]" \
  -map "[v]" -map "[a]" -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k scenes.mp4

# 5s portrait clip without audio.
ffmpeg "${q[@]}" -f lavfi -i "testsrc=s=1080x1920:r=30:d=5" -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p vertical.mp4

# A logo-like still image.
ffmpeg "${q[@]}" -f lavfi -i "color=c=0xd62d20:s=800x600:d=1" -frames:v 1 logo.png

# Real footage with music, from the mediaelement test files.
if [ ! -s echo-hereweare.mp4 ]; then
  curl -fsSL -o echo-hereweare.mp4 https://raw.githubusercontent.com/mediaelement/mediaelement-files/master/echo-hereweare.mp4
fi
echo "Sample media in $(pwd)"
