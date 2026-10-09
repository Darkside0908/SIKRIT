import subprocess
import os

EDGE_TTS = "/home/igan/.hermes/installs/d7c1bd10e475f5f6/environments/c6b0faeecdfe48959090fcd4c0ab77cf/venv/bin/edge-tts"
AUDIO_DIR = "/home/igan/Projects/SIKRIT/docs/video/demo_audio"
VOICE = "en-US-ChristopherNeural"
os.makedirs(AUDIO_DIR, exist_ok=True)

scripts = [
    ("demo-01-intro.mp3", "This is SIKRIT running against a local Solana validator with the real program. Five demo wallets play one family: Pak Arif, his daughter Sari, and three guardians."),
    ("demo-02-derive.mp3", "Pak Arif's wallet signs a fixed message. SIKRIT hashes that signature into a separate secret, x. Only its public key goes on-chain, and he can re-derive it from his wallet any time."),
    ("demo-03-invite.mp3", "Sari and the guardians send invites: encryption keys signed by their own wallets. Every signature is checked, so nobody in the middle can swap in a key."),
    ("demo-04-split.mp3", "He pastes his seed phrase. It's encrypted here, in the browser. The key is split three-of-four: Sari's share alone reveals nothing."),
    ("demo-05-seal.mp3", "One transaction, paid by a relayer: the public key, the rules, a hash per share, and a sealed commitment per family member. No wallet of his, or of his family, is in it."),
    ("demo-06-heartbeat.mp3", "Now a heartbeat: a zero-knowledge proof made in the browser. Three accounts: relayer, capsule, program. Eighty bytes: R, s, and an expiry ten minutes out, so a relayer can't hold it back for later. His wallet: not present. Nor is his family's."),
    ("demo-07-claim-open.mp3", "He misses his interval. Anyone may now open a claim, here, Sari."),
    ("demo-08-confirm.mp3", "Two of three guardians confirm, each opening their sealed commitment with the salt from their kit: the chain sees them for the first time. If he were alive, a guardian could veto, or one more heartbeat would cancel the claim."),
    ("demo-09-claimed.mp3", "The grace period is over and the quorum is met. Sari opens the heir's commitment and claims on-chain."),
    ("demo-10-release.mp3", "Only now do the guardians release their shares, and only to the inbox key certified by the heir the capsule committed to."),
    ("demo-11-unseal.mp3", "Sari's browser checks every share against the hashes on-chain and rebuilds the seed phrase. It was never on a server, and never on the chain.")
]

for filename, text in scripts:
    out_path = os.path.join(AUDIO_DIR, filename)
    print(f"Generating {filename}...")
    subprocess.run([
        EDGE_TTS,
        "--voice", VOICE,
        "--rate", "-2%",
        "--text", text,
        "--write-media", out_path
    ], check=True)

print("All demo audio generated successfully!")
