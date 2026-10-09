import subprocess
import os
import json

ROOT = "/home/igan/Projects/SIKRIT"
DEMO_DIR = os.path.join(ROOT, "docs/video/demo")
AUDIO_DIR = os.path.join(ROOT, "docs/video/demo_audio")
SILENT_VIDEO = os.path.join(DEMO_DIR, "demo_silent.mp4")
OUTPUT_VIDEO = os.path.join(DEMO_DIR, "SIKRIT_Product_Demo_2026.mp4")

# Check silent video duration
cmd = ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", SILENT_VIDEO]
video_dur = float(subprocess.check_output(cmd).decode().strip())
print(f"Silent video duration: {video_dur:.2f}s")

# Audio files
audio_files = [
    ("demo-01-intro.mp3", 0.5),     # Home hero
    ("demo-02-derive.mp3", 13.5),   # Derive key
    ("demo-03-invite.mp3", 27.5),   # Invites
    ("demo-04-split.mp3", 38.5),    # Split & seed
    ("demo-05-seal.mp3", 49.5),     # Seal capsule
    ("demo-06-heartbeat.mp3", 63.0),# Heartbeat & inspector
    ("demo-07-claim-open.mp3", 84.0),# Heir opens claim (after silence)
    ("demo-08-confirm.mp3", 91.5),  # Guardians confirm
    ("demo-09-claimed.mp3", 106.0), # Heir claims (after grace)
    ("demo-10-release.mp3", 114.0), # Guardians release
    ("demo-11-unseal.mp3", 122.0),  # Recover seed phrase
]

# We need the video to run until at least 135s (so unseal finishes and holds)
target_dur = 135.0
extra_pad = max(0, target_dur - video_dur)
print(f"Target duration: {target_dur:.2f}s (padding end by {extra_pad:.2f}s)")

# Build ffmpeg filter_complex for audio mixing
inputs = ["-i", SILENT_VIDEO]
filter_parts = []
for idx, (filename, delay_s) in enumerate(audio_files):
    filepath = os.path.join(AUDIO_DIR, filename)
    inputs.extend(["-i", filepath])
    delay_ms = int(delay_s * 1000)
    filter_parts.append(f"[{idx+1}:a]adelay={delay_ms}|{delay_ms}[a{idx+1}]")

# Mix all audio streams
mix_inputs = "".join(f"[a{i+1}]" for i in range(len(audio_files)))
filter_parts.append(f"{mix_inputs}amix=inputs={len(audio_files)}:normalize=0[aout]")

# Video padding filter if needed
v_filter = f"[0:v]tpad=stop_mode=clone:stop_duration={extra_pad:.2f},fps=30,format=yuv420p[vout]"

filter_complex = ";".join(filter_parts) + f";{v_filter}"

cmd_final = [
    "ffmpeg", "-y", "-loglevel", "error",
    *inputs,
    "-filter_complex", filter_complex,
    "-map", "[vout]",
    "-map", "[aout]",
    "-c:v", "libx264", "-preset", "fast", "-crf", "18",
    "-c:a", "aac", "-b:a", "192k",
    "-shortest",
    OUTPUT_VIDEO
]

print("Rendering final synced product demo video...")
subprocess.run(cmd_final, check=True)

final_cmd = ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", OUTPUT_VIDEO]
final_dur = float(subprocess.check_output(final_cmd).decode().strip())
file_size_mb = os.path.getsize(OUTPUT_VIDEO) / (1024 * 1024)

print(f"\n✓ Product Demo Video Completed!")
print(f"  Duration: {final_dur:.2f}s ({int(final_dur//60)}m {int(final_dur%60)}s)")
print(f"  Size: {file_size_mb:.2f} MB")
print(f"  Path: {OUTPUT_VIDEO}")
