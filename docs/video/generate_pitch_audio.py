import subprocess
import os

EDGE_TTS = "/home/igan/.hermes/installs/d7c1bd10e475f5f6/environments/c6b0faeecdfe48959090fcd4c0ab77cf/venv/bin/edge-tts"
AUDIO_DIR = "/home/igan/Projects/SIKRIT/docs/video/audio"
VOICE = "en-US-ChristopherNeural"

scripts = [
    (
        "slide-01.mp3",
        "If I died tonight, my family couldn't touch a single coin I own. Not because they have no right to it — because self-custody has no next of kin. I'm Ghani, a fourth-year cryptography student at Indonesia's state polytechnic for cyber security and cryptography. This is SIKRIT."
    ),
    (
        "slide-02.mp3",
        "Between 2.3 and 3.7 million bitcoin are already locked forever. Some of it belonged to people who died without passing on access. Indonesia alone has almost 23 million crypto investors, and their families face the same tension: they must be able to open the wallet when you're gone, and must never be able to while you're alive."
    ),
    (
        "slide-03.mp3",
        "Dead man's switches solve this with a check-in. We reviewed eleven of them. Every one ties the check-in to your wallet. Every week you publish: this address is alive, and active, today. When you stop, the chain says that too. For anyone holding real value, that's a map for attackers."
    ),
    (
        "slide-04.mp3",
        "SIKRIT proves you're alive without saying who you are. You seal your seed phrase in the browser. Its key is split with Shamir's scheme: one share for your heir, one for each guardian. To check in, your browser makes a Schnorr zero-knowledge proof with a key that is not your wallet, and a relayer sends it. Your family isn't on-chain either: only sealed commitments, until they act."
    ),
    (
        "slide-05.mp3",
        "This is what the chain sees: a relayer, a capsule address, and a proof. Your wallet isn't there. Our end-to-end test plays a whole inheritance and re-reads every transaction: the owner's wallet appears in zero of them, and each family member only where they act. Verifying a heartbeat costs 41 thousand compute units. Thirty years of weekly check-ins cost less than a hundredth of a SOL."
    ),
    (
        "slide-06.mp3",
        "If you go silent, a claim opens. Two of three guardians confirm, the grace period passes, and only then do guardians release their shares. The seed phrase comes back together in your heir's browser."
    ),
    (
        "slide-07.mp3",
        "Under the hood, SIKRIT is built like it will be attacked. The Schnorr proof mirrors byte-for-byte between TypeScript and Rust syscalls. Member commitments use salted SHA-256 hashes, keeping heir and guardians completely invisible until they confirm."
    ),
    (
        "slide-08.mp3",
        "Looking across the landscape of eleven inheritance protocols, from Sarcophagus to Safe and DeathClock: inheritance exists, but private liveness does not. SIKRIT is the only dead man's switch where your heartbeats never point back to your funds."
    ),
    (
        "slide-09.mp3",
        "The protocol stays open source and has no token. We earn around it: an inheritance tab for Solana wallets built on our SDK, a watcher that warns you the moment a claim opens, and notaries as professional guardians, which is how wills already work in Indonesia. We start at home and grow through wallets."
    ),
    (
        "slide-10.mp3",
        "I study how secrets fail, so I built one that fails safely. Prove you're alive. Reveal nothing else. Thank you."
    )
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

print("All pitch audio generated successfully!")
