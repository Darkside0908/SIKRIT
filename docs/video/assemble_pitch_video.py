import subprocess
import os
import json

ROOT = "/home/igan/Projects/SIKRIT"
SLIDES_DIR = os.path.join(ROOT, "docs/deck/slides")
AUDIO_DIR = os.path.join(ROOT, "docs/video/audio")
OUT_DIR = os.path.join(ROOT, "docs/video/pitch")
TEMP_DIR = os.path.join(OUT_DIR, "temp_clips")
os.makedirs(TEMP_DIR, exist_ok=True)

def get_duration(file_path):
    cmd = [
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", file_path
    ]
    res = subprocess.check_output(cmd).decode().strip()
    return float(res)

clip_files = []
for i in range(1, 11):
    num_str = f"{i:02d}"
    slide_png = os.path.join(SLIDES_DIR, f"slide-{num_str}.png")
    audio_mp3 = os.path.join(AUDIO_DIR, f"slide-{num_str}.mp3")
    clip_mp4 = os.path.join(TEMP_DIR, f"clip-{num_str}.mp4")
    
    aud_dur = get_duration(audio_mp3)
    total_dur = aud_dur + 0.8  # 0.8s breathing room
    
    print(f"Rendering Clip {num_str}: Audio {aud_dur:.2f}s -> Total {total_dur:.2f}s...")
    
    # Render static image with audio + subtle fade in/out
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-loop", "1", "-i", slide_png,
        "-i", audio_mp3,
        "-t", f"{total_dur:.3f}",
        "-vf", "scale=1920:1080,fps=30,format=yuv420p",
        "-af", f"apad=pad_dur=0.8,afade=t=in:st=0:d=0.2,afade=t=out:st={total_dur-0.2:.3f}:d=0.2",
        "-c:v", "libx264", "-tune", "stillimage", "-preset", "fast", "-crf", "18",
        "-c:a", "aac", "-b:a", "192k",
        clip_mp4
    ]
    subprocess.run(cmd, check=True)
    clip_files.append(clip_mp4)

# Concat all clips
concat_txt = os.path.join(TEMP_DIR, "concat.txt")
with open(concat_txt, "w") as f:
    for c in clip_files:
        f.write(f"file '{c}'\n")

final_output = os.path.join(OUT_DIR, "SIKRIT_Pitch_Presentation_2026.mp4")
print(f"Concatenating all clips to {final_output}...")
cmd_concat = [
    "ffmpeg", "-y", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", concat_txt,
    "-c", "copy",
    final_output
]
subprocess.run(cmd_concat, check=True)

final_dur = get_duration(final_output)
file_size_mb = os.path.getsize(final_output) / (1024 * 1024)
print(f"\n✓ Pitch Video Completed!")
print(f"  Duration: {final_dur:.2f}s ({int(final_dur//60)}m {int(final_dur%60)}s)")
print(f"  Size: {file_size_mb:.2f} MB")
print(f"  Path: {final_output}")
