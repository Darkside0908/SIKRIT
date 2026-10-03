use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use curve25519_dalek::scalar::Scalar;
use sha2::{Digest, Sha512};

declare_id!("FJKqfFBf6Sw87eAfpgDbibiWUKhpmdVjFxexc9BTc45F");

pub const MAX_GUARDIANS: usize = 5;
pub const MAX_SHARES: usize = 10;
#[constant]
pub const MIN_HEARTBEAT_INTERVAL: i64 = 60; // 1 menit untuk testing devnet, produksi 30-90 hari
#[constant]
pub const MIN_GRACE_PERIOD: i64 = 60;
/// Bukti liveness paling lama berlaku 1 jam: relayer yang menahan bukti tidak bisa memakainya belakangan.
#[constant]
pub const MAX_PROOF_LIFETIME: i64 = 3600;

#[constant]
pub const CAPSULE_SEED: &[u8] = b"capsule";
/// Domain separation Fiat–Shamir: bukti registrasi dan bukti liveness tidak bisa saling dipakai ulang.
#[constant]
pub const REGISTER_DOMAIN: &[u8] = b"SIKRIT:register:v2";
#[constant]
pub const LIVENESS_DOMAIN: &[u8] = b"SIKRIT:liveness:v2";
#[constant]
pub const UPDATE_DOMAIN: &[u8] = b"SIKRIT:update:v1";
/// Komitmen anggota: SHA-256(MEMBER_DOMAIN ‖ P ‖ role ‖ wallet ‖ salt), lihat `member_commitment`.
#[constant]
pub const MEMBER_DOMAIN: &[u8] = b"SIKRIT:member:v1";
pub const ROLE_HEIR: u8 = 0;
pub const ROLE_GUARDIAN: u8 = 1;

// Persetujuan & veto guardian disimpan sebagai bitmap u8.
const _: () = assert!(MAX_GUARDIANS <= 8);

#[program]
pub mod sikrit {
    use super::*;

    /// Membuat Kapsul Rahasia baru dengan parameter time-lock, ahli waris, dan guardian.
    ///
    /// Kapsul diidentifikasi oleh `commitment` P = x·G (kunci publik liveness), BUKAN wallet pemilik:
    /// PDA = ["capsule", P] dan state tidak menyimpan `owner`. Siapa pun boleh membayar rent (`payer`);
    /// otorisasi pemilik adalah proof-of-possession Schnorr atas x yang mengikat seluruh `config`,
    /// sehingga pihak lain tidak bisa mendaftarkan (atau front-run) kapsul dengan P milik orang lain.
    ///
    /// Ahli waris dan guardian juga tidak tersimpan sebagai wallet, hanya komitmen bergaram: siapa
    /// keluarga pemilik baru terlihat ketika seorang anggota sendiri bertindak (konfirmasi, veto, klaim).
    pub fn create_capsule(
        ctx: Context<CreateCapsule>,
        commitment: [u8; 32],
        config: CapsuleConfig,
        proof: SchnorrProof,
    ) -> Result<()> {
        config.validate()?;
        schnorr::validate_commitment(&commitment)?;

        let capsule_key = ctx.accounts.capsule.key();
        let e = schnorr::challenge(
            &crate::ID,
            REGISTER_DOMAIN,
            &capsule_key,
            &commitment,
            &proof.r,
            &config.try_to_vec()?,
        );
        schnorr::verify(&commitment, &proof, &e)?;

        let clock = Clock::get()?;
        let capsule = &mut ctx.accounts.capsule;

        capsule.commitment = commitment;
        capsule.heir_commitment = config.heir_commitment;
        capsule.heir = Pubkey::default();
        capsule.guardian_commitments = config.guardian_commitments;
        capsule.guardian_threshold = config.guardian_threshold;
        capsule.approvals = 0;
        capsule.vetoes = 0;
        capsule.heartbeat_interval = config.heartbeat_interval;
        capsule.grace_period = config.grace_period;
        capsule.last_heartbeat = clock.unix_timestamp;
        capsule.claim_triggered_at = 0;
        capsule.heartbeat_nonce = 0;
        capsule.share_hashes = config.share_hashes;
        capsule.status = CapsuleStatus::Active;
        capsule.bump = ctx.bumps.capsule;

        emit!(CapsuleCreated {
            capsule: capsule_key,
            guardian_count: capsule.guardian_commitments.len() as u8,
            guardian_threshold: capsule.guardian_threshold,
            heartbeat_interval: capsule.heartbeat_interval,
            grace_period: capsule.grace_period,
        });

        Ok(())
    }

    /// Verifikasi ZK Proof of Liveness (Schnorr Identification + Fiat–Shamir).
    ///
    /// Tidak ada signer yang diwajibkan: bukti atas x adalah satu-satunya otorisasi, sehingga transaksi
    /// boleh di-relay oleh fee payer mana pun (burner/relayer) dan wallet pemilik tidak pernah muncul.
    /// Challenge terikat ke program, kapsul, `heartbeat_nonce` dan `expires_at`: setiap bukti hanya
    /// berlaku sekali, dan hanya sampai `expires_at` (paling lama `MAX_PROOF_LIFETIME` ke depan).
    /// Heartbeat valid saat `ClaimPending` membatalkan klaim (pemilik terbukti masih hidup).
    pub fn heartbeat(ctx: Context<Heartbeat>, proof: SchnorrProof, expires_at: i64) -> Result<()> {
        let capsule_key = ctx.accounts.capsule.key();
        let capsule = &mut ctx.accounts.capsule;
        require!(
            capsule.status != CapsuleStatus::Claimed,
            SikritError::CapsuleAlreadyClaimed
        );

        let clock = Clock::get()?;
        check_proof_expiry(&clock, expires_at)?;

        let nonce = capsule.heartbeat_nonce;
        let e = schnorr::challenge(
            &crate::ID,
            LIVENESS_DOMAIN,
            &capsule_key,
            &capsule.commitment,
            &proof.r,
            &schnorr::liveness_context(nonce, expires_at),
        );
        schnorr::verify(&capsule.commitment, &proof, &e)?;

        let claim_cancelled = capsule.status == CapsuleStatus::ClaimPending;

        capsule.heartbeat_nonce = nonce.checked_add(1).ok_or(SikritError::NonceOverflow)?;
        capsule.last_heartbeat = clock.unix_timestamp;
        capsule.status = CapsuleStatus::Active;
        capsule.claim_triggered_at = 0;
        capsule.approvals = 0;
        // Pemilik terbukti hidup → hak veto guardian dipulihkan.
        capsule.vetoes = 0;

        emit!(HeartbeatVerified {
            capsule: capsule_key,
            nonce,
            timestamp: clock.unix_timestamp,
            claim_cancelled,
        });

        Ok(())
    }

    /// Pemilik mengganti ahli waris, guardian, kuorum, timer dan share hash (kit baru) tanpa wallet apa pun.
    ///
    /// Otorisasinya bukti Schnorr atas x seperti heartbeat, dengan domain sendiri dan challenge yang mengikat
    /// `nonce ‖ expires_at ‖ Borsh(config)`: bukti hanya berlaku sekali, sebentar, dan hanya untuk konfigurasi itu.
    /// Update membuktikan pemilik hidup, jadi juga membatalkan klaim yang sedang berjalan. Komitmen dan share hash
    /// lama hilang dari chain, sehingga kit lama tidak lagi cocok dan guardian yang memegangnya menolak release.
    pub fn update_capsule(
        ctx: Context<UpdateCapsule>,
        config: CapsuleConfig,
        proof: SchnorrProof,
        expires_at: i64,
    ) -> Result<()> {
        config.validate()?;
        let capsule_key = ctx.accounts.capsule.key();
        let capsule = &mut ctx.accounts.capsule;
        require!(
            capsule.status != CapsuleStatus::Claimed,
            SikritError::CapsuleAlreadyClaimed
        );

        let clock = Clock::get()?;
        check_proof_expiry(&clock, expires_at)?;

        let nonce = capsule.heartbeat_nonce;
        let e = schnorr::challenge(
            &crate::ID,
            UPDATE_DOMAIN,
            &capsule_key,
            &capsule.commitment,
            &proof.r,
            &schnorr::update_context(nonce, expires_at, &config.try_to_vec()?),
        );
        schnorr::verify(&capsule.commitment, &proof, &e)?;

        let claim_cancelled = capsule.status == CapsuleStatus::ClaimPending;

        capsule.heir_commitment = config.heir_commitment;
        capsule.guardian_commitments = config.guardian_commitments;
        capsule.guardian_threshold = config.guardian_threshold;
        capsule.heartbeat_interval = config.heartbeat_interval;
        capsule.grace_period = config.grace_period;
        capsule.share_hashes = config.share_hashes;
        capsule.heartbeat_nonce = nonce.checked_add(1).ok_or(SikritError::NonceOverflow)?;
        capsule.last_heartbeat = clock.unix_timestamp;
        capsule.status = CapsuleStatus::Active;
        capsule.claim_triggered_at = 0;
        capsule.approvals = 0;
        capsule.vetoes = 0;

        emit!(CapsuleUpdated {
            capsule: capsule_key,
            nonce,
            guardian_count: capsule.guardian_commitments.len() as u8,
            guardian_threshold: capsule.guardian_threshold,
            heartbeat_interval: capsule.heartbeat_interval,
            grace_period: capsule.grace_period,
            claim_cancelled,
        });

        Ok(())
    }

    /// Siapapun dapat mentrigger proses klaim jika heartbeat telah kedaluwarsa
    pub fn trigger_claim(ctx: Context<TriggerClaim>) -> Result<()> {
        let clock = Clock::get()?;
        let capsule = &mut ctx.accounts.capsule;

        require!(capsule.status == CapsuleStatus::Active, SikritError::CapsuleNotActive);

        let elapsed = clock.unix_timestamp.saturating_sub(capsule.last_heartbeat);
        require!(elapsed >= capsule.heartbeat_interval, SikritError::HeartbeatNotExpired);

        capsule.status = CapsuleStatus::ClaimPending;
        capsule.claim_triggered_at = clock.unix_timestamp;
        capsule.approvals = 0;

        emit!(ClaimTriggered {
            capsule: capsule.key(),
            triggered_at: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Guardian memberikan persetujuan pelepasan kapsul (satu suara per guardian per klaim).
    ///
    /// Guardian membuktikan keanggotaannya dengan membuka komitmen di `slot` memakai `salt` dari kit;
    /// salt tanpa tanda tangan wallet yang sama tidak berguna bagi orang lain.
    pub fn guardian_confirm(ctx: Context<GuardianAction>, slot: u8, salt: [u8; 32]) -> Result<()> {
        let capsule = &mut ctx.accounts.capsule;
        let guardian_key = ctx.accounts.guardian.key();

        require!(capsule.status == CapsuleStatus::ClaimPending, SikritError::ClaimNotPending);
        let bit = capsule.guardian_bit(&guardian_key, slot, &salt)?;
        require!(capsule.approvals & bit == 0, SikritError::GuardianAlreadyApproved);

        capsule.approvals |= bit;

        emit!(GuardianConfirmed {
            capsule: capsule.key(),
            guardian: guardian_key,
            total_approvals: capsule.approvals.count_ones() as u8,
        });

        Ok(())
    }

    /// Guardian melakukan veto jika klaim terbukti palsu / pemilik masih hidup.
    ///
    /// Hanya berlaku selama grace period. Veto mengembalikan kapsul ke `Active` dan memberi pemilik
    /// satu interval heartbeat penuh. Tiap guardian hanya punya satu veto sampai pemilik membuktikan
    /// liveness lagi, sehingga guardian jahat hanya bisa menunda pewarisan secara terbatas, tidak selamanya.
    pub fn guardian_veto(ctx: Context<GuardianAction>, slot: u8, salt: [u8; 32]) -> Result<()> {
        let clock = Clock::get()?;
        let capsule = &mut ctx.accounts.capsule;
        let guardian_key = ctx.accounts.guardian.key();

        require!(capsule.status == CapsuleStatus::ClaimPending, SikritError::ClaimNotPending);
        let bit = capsule.guardian_bit(&guardian_key, slot, &salt)?;

        let elapsed_grace = clock.unix_timestamp.saturating_sub(capsule.claim_triggered_at);
        require!(elapsed_grace < capsule.grace_period, SikritError::VetoWindowClosed);
        require!(capsule.vetoes & bit == 0, SikritError::GuardianAlreadyVetoed);

        capsule.vetoes |= bit;
        capsule.status = CapsuleStatus::Active;
        capsule.last_heartbeat = clock.unix_timestamp;
        capsule.claim_triggered_at = 0;
        capsule.approvals = 0;

        emit!(ClaimVetoed {
            capsule: capsule.key(),
            guardian: guardian_key,
        });

        Ok(())
    }

    /// Ahli waris mencairkan/membuka kapsul setelah grace period dan threshold guardian terpenuhi.
    ///
    /// Ahli waris membuka `heir_commitment` dengan wallet-nya dan `salt` dari kit; wallet itu lalu
    /// disimpan di `heir`, tempat guardian mencocokkan tujuan pelepasan share.
    pub fn claim(ctx: Context<ClaimCapsule>, salt: [u8; 32]) -> Result<()> {
        let clock = Clock::get()?;
        let capsule = &mut ctx.accounts.capsule;
        let heir_key = ctx.accounts.heir.key();

        require!(
            capsule.heir_commitment == member_commitment(&capsule.commitment, ROLE_HEIR, &heir_key, &salt),
            SikritError::UnauthorizedHeir
        );
        require!(capsule.status == CapsuleStatus::ClaimPending, SikritError::ClaimNotPending);

        let elapsed_grace = clock.unix_timestamp.saturating_sub(capsule.claim_triggered_at);
        require!(elapsed_grace >= capsule.grace_period, SikritError::GracePeriodNotExpired);

        require!(
            capsule.approvals.count_ones() >= u32::from(capsule.guardian_threshold),
            SikritError::InsufficientGuardianApprovals
        );

        capsule.status = CapsuleStatus::Claimed;
        capsule.heir = heir_key;

        emit!(CapsuleClaimed {
            capsule: capsule.key(),
            heir: heir_key,
            claimed_at: clock.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// Account Contexts
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(commitment: [u8; 32])]
pub struct CreateCapsule<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Capsule::INIT_SPACE,
        seeds = [CAPSULE_SEED, commitment.as_ref()],
        bump
    )]
    pub capsule: Account<'info, Capsule>,
    /// Pembayar rent; boleh wallet burner/relayer dan tidak disimpan di state kapsul.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Heartbeat<'info> {
    #[account(
        mut,
        seeds = [CAPSULE_SEED, capsule.commitment.as_ref()],
        bump = capsule.bump,
    )]
    pub capsule: Account<'info, Capsule>,
}

#[derive(Accounts)]
pub struct UpdateCapsule<'info> {
    #[account(
        mut,
        seeds = [CAPSULE_SEED, capsule.commitment.as_ref()],
        bump = capsule.bump,
    )]
    pub capsule: Account<'info, Capsule>,
}

#[derive(Accounts)]
pub struct TriggerClaim<'info> {
    #[account(
        mut,
        seeds = [CAPSULE_SEED, capsule.commitment.as_ref()],
        bump = capsule.bump,
    )]
    pub capsule: Account<'info, Capsule>,
}

#[derive(Accounts)]
pub struct GuardianAction<'info> {
    #[account(
        mut,
        seeds = [CAPSULE_SEED, capsule.commitment.as_ref()],
        bump = capsule.bump,
    )]
    pub capsule: Account<'info, Capsule>,
    pub guardian: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimCapsule<'info> {
    #[account(
        mut,
        seeds = [CAPSULE_SEED, capsule.commitment.as_ref()],
        bump = capsule.bump,
    )]
    pub capsule: Account<'info, Capsule>,
    /// Diotorisasi di handler dengan membuka `heir_commitment`.
    pub heir: Signer<'info>,
}

// -----------------------------------------------------------------------------
// State & Enums
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Capsule {
    /// Kunci publik liveness P = x·G, sekaligus seed PDA. Tidak ada identitas wallet pemilik.
    pub commitment: [u8; 32],
    /// `member_commitment(P, ROLE_HEIR, wallet ahli waris, salt)`: siapa ahli warisnya tersembunyi sampai klaim.
    pub heir_commitment: [u8; 32],
    /// Wallet yang membuka `heir_commitment` saat `claim`; `Pubkey::default()` sebelum itu.
    pub heir: Pubkey,
    /// `member_commitment(P, ROLE_GUARDIAN, wallet guardian, salt)` per slot.
    #[max_len(MAX_GUARDIANS)]
    pub guardian_commitments: Vec<[u8; 32]>,
    pub guardian_threshold: u8,
    /// Bit i menyala ⇔ guardian di slot i sudah menyetujui klaim yang sedang berjalan.
    pub approvals: u8,
    /// Bit i menyala ⇔ guardian di slot i sudah memakai vetonya sejak heartbeat terakhir pemilik.
    pub vetoes: u8,
    pub heartbeat_interval: i64,
    pub grace_period: i64,
    pub last_heartbeat: i64,
    pub claim_triggered_at: i64,
    /// Counter monoton yang diikat ke setiap bukti liveness (anti-replay).
    pub heartbeat_nonce: u64,
    #[max_len(MAX_SHARES)]
    pub share_hashes: Vec<[u8; 32]>,
    pub status: CapsuleStatus,
    pub bump: u8,
}

impl Capsule {
    /// Bit persetujuan/veto untuk `slot`, hanya jika `guardian` + `salt` membuka komitmen di slot itu.
    fn guardian_bit(&self, guardian: &Pubkey, slot: u8, salt: &[u8; 32]) -> Result<u8> {
        let committed = self
            .guardian_commitments
            .get(usize::from(slot))
            .ok_or_else(|| error!(SikritError::UnauthorizedGuardian))?;
        require!(
            *committed == member_commitment(&self.commitment, ROLE_GUARDIAN, guardian, salt),
            SikritError::UnauthorizedGuardian
        );
        Ok(1u8 << slot)
    }
}

/// Komitmen bergaram atas anggota kapsul: SHA-256(MEMBER_DOMAIN ‖ P ‖ role ‖ wallet ‖ salt).
///
/// `salt` acak 32 byte per anggota (dibuat pemilik, dibawa di kit) membuat komitmen menyembunyikan
/// wallet dari tebakan atas seluruh wallet Solana dan tidak bisa ditautkan antar kapsul; SHA-256
/// mengikatnya ke satu wallet. Semua field panjangnya tetap, jadi encoding-nya tidak ambigu.
pub fn member_commitment(capsule_commitment: &[u8; 32], role: u8, wallet: &Pubkey, salt: &[u8; 32]) -> [u8; 32] {
    hashv(&[MEMBER_DOMAIN, capsule_commitment, &[role], wallet.as_ref(), salt]).to_bytes()
}

/// Bukti heartbeat/update hanya diterima selama `now ≤ expires_at ≤ now + MAX_PROOF_LIFETIME` (jam cluster).
fn check_proof_expiry(clock: &Clock, expires_at: i64) -> Result<()> {
    require!(clock.unix_timestamp <= expires_at, SikritError::ProofExpired);
    require!(
        expires_at <= clock.unix_timestamp.saturating_add(MAX_PROOF_LIFETIME),
        SikritError::ProofExpiryTooFar
    );
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum CapsuleStatus {
    Active,
    ClaimPending,
    Claimed,
}

/// Parameter kapsul. Serialisasi Borsh-nya diikat ke proof-of-possession saat `create_capsule`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CapsuleConfig {
    pub heir_commitment: [u8; 32],
    pub heartbeat_interval: i64,
    pub grace_period: i64,
    pub guardian_commitments: Vec<[u8; 32]>,
    pub guardian_threshold: u8,
    pub share_hashes: Vec<[u8; 32]>,
}

impl CapsuleConfig {
    /// Wallet di balik komitmen tidak terlihat oleh program, jadi aturan identitas (ahli waris bukan
    /// guardian, guardian berbeda-beda) ditegakkan client saat sealing; di sini dicek bentuk komitmennya.
    fn validate(&self) -> Result<()> {
        require!(
            self.heartbeat_interval >= MIN_HEARTBEAT_INTERVAL,
            SikritError::HeartbeatIntervalTooShort
        );
        require!(self.grace_period >= MIN_GRACE_PERIOD, SikritError::GracePeriodTooShort);
        require!(self.heir_commitment != [0; 32], SikritError::InvalidHeir);
        require!(self.guardian_commitments.len() <= MAX_GUARDIANS, SikritError::TooManyGuardians);
        require!(
            self.guardian_threshold as usize <= self.guardian_commitments.len(),
            SikritError::InvalidGuardianThreshold
        );
        for (i, guardian) in self.guardian_commitments.iter().enumerate() {
            require!(*guardian != [0; 32], SikritError::InvalidGuardian);
            require!(*guardian != self.heir_commitment, SikritError::HeirCannotBeGuardian);
            require!(!self.guardian_commitments[..i].contains(guardian), SikritError::DuplicateGuardian);
        }
        require!(self.share_hashes.len() <= MAX_SHARES, SikritError::TooManyShares);
        Ok(())
    }
}

/// Bukti Schnorr non-interaktif (R, s).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct SchnorrProof {
    /// R = k·G, encoding Edwards terkompresi (harus kanonik).
    pub r: [u8; 32],
    /// s = k + e·x mod ℓ, little-endian (harus kanonik, s < ℓ).
    pub s: [u8; 32],
}

// -----------------------------------------------------------------------------
// ZK Proof-of-Liveness (Schnorr PoK di subgrup prima Ed25519)
// -----------------------------------------------------------------------------

/// Schnorr proof-of-knowledge (Σ-protocol + Fiat–Shamir) atas x di mana P = x·G.
///
/// Prover (client): k acak, R = k·G, e = H(transkrip) mod ℓ, s = k + e·x mod ℓ.
/// Verifier (program): terima iff s·G − e·P == R, dengan
///   e = SHA-512(domain ‖ program_id ‖ capsule ‖ P ‖ R ‖ context) mod ℓ
/// `context` = nonce heartbeat (u64 LE) ‖ expires_at (i64 LE) untuk liveness, Borsh(CapsuleConfig) untuk
/// registrasi, atau nonce ‖ expires_at ‖ Borsh(CapsuleConfig) untuk update.
pub mod schnorr {
    use super::*;
    use curve25519_dalek::constants::ED25519_BASEPOINT_COMPRESSED;
    use curve25519_dalek::edwards::CompressedEdwardsY;
    use curve25519_dalek::traits::Identity;

    pub fn liveness_context(nonce: u64, expires_at: i64) -> [u8; 16] {
        let mut context = [0u8; 16];
        context[..8].copy_from_slice(&nonce.to_le_bytes());
        context[8..].copy_from_slice(&expires_at.to_le_bytes());
        context
    }

    /// Prefiks berpanjang tetap (16 byte) lalu config: encoding-nya tidak ambigu.
    pub fn update_context(nonce: u64, expires_at: i64, config: &[u8]) -> Vec<u8> {
        [&liveness_context(nonce, expires_at)[..], config].concat()
    }

    pub fn challenge(
        program_id: &Pubkey,
        domain: &[u8],
        capsule: &Pubkey,
        commitment: &[u8; 32],
        r: &[u8; 32],
        context: &[u8],
    ) -> Scalar {
        let mut hasher = Sha512::new();
        hasher.update(domain);
        hasher.update(program_id.as_ref());
        hasher.update(capsule.as_ref());
        hasher.update(commitment);
        hasher.update(r);
        hasher.update(context);
        Scalar::from_bytes_mod_order_wide(&hasher.finalize().into())
    }

    /// Cek s·G − e·P == R, dibandingkan byte-per-byte dengan encoding kanonik hasilnya
    /// (encoding R yang tidak kanonik otomatis ditolak).
    pub fn verify(commitment: &[u8; 32], proof: &SchnorrProof, e: &Scalar) -> Result<()> {
        require!(curve::validate(&proof.r), SikritError::InvalidProofR);
        let s = Option::<Scalar>::from(Scalar::from_canonical_bytes(proof.s))
            .ok_or(SikritError::InvalidProofS)?;

        let lhs = curve::multiscalar_mul(
            &[s.to_bytes(), (-e).to_bytes()],
            &[ED25519_BASEPOINT_COMPRESSED.to_bytes(), *commitment],
        )
        .ok_or(SikritError::InvalidCommitment)?;

        require!(lhs == proof.r, SikritError::ProofVerificationFailed);
        Ok(())
    }

    /// P harus encoding kanonik dari titik non-identitas di subgrup berorde prima ℓ.
    /// Titik small-order (cofactor 8) membuat bukti bisa dipalsukan tanpa mengetahui x.
    pub fn validate_commitment(p: &[u8; 32]) -> Result<()> {
        let identity = CompressedEdwardsY::identity().to_bytes();
        require!(is_canonical(p) && *p != identity, SikritError::InvalidCommitment);

        // ℓ·P = (ℓ − 1)·P + P harus identitas (syscall hanya menerima skalar kanonik < ℓ).
        let l_minus_one = (-Scalar::ONE).to_bytes();
        let l_p = curve::mul(&l_minus_one, p)
            .and_then(|q| curve::add(&q, p))
            .ok_or(SikritError::InvalidCommitment)?;
        require!(l_p == identity, SikritError::InvalidCommitment);
        Ok(())
    }

    /// y (255 bit bawah, little-endian) harus < p = 2^255 − 19.
    pub fn is_canonical(point: &[u8; 32]) -> bool {
        let mut y = *point;
        y[31] &= 0x7f;
        !(y[0] >= 0xed && y[1..31].iter().all(|&b| b == 0xff) && y[31] == 0x7f)
    }
}

/// Operasi grup Edwards25519. On-chain memakai syscall curve25519 native Solana (murah, ribuan CU);
/// aritmetika titik curve25519-dalek di SBF melampaui batas stack frame 4 KiB. Di host (unit test,
/// IDL build) memakai curve25519-dalek dengan semantik yang sama (skalar kanonik, titik di-decompress).
mod curve {
    #[cfg(target_os = "solana")]
    mod imp {
        use anchor_lang::solana_program::syscalls::{
            sol_curve_group_op, sol_curve_multiscalar_mul, sol_curve_validate_point,
        };

        const CURVE25519_EDWARDS: u64 = 0;
        const ADD: u64 = 0;
        const MUL: u64 = 2;

        pub fn validate(point: &[u8; 32]) -> bool {
            let mut unused = 0u8;
            unsafe { sol_curve_validate_point(CURVE25519_EDWARDS, point.as_ptr(), &mut unused) == 0 }
        }

        pub fn add(left: &[u8; 32], right: &[u8; 32]) -> Option<[u8; 32]> {
            let mut out = [0u8; 32];
            let rc = unsafe {
                sol_curve_group_op(CURVE25519_EDWARDS, ADD, left.as_ptr(), right.as_ptr(), out.as_mut_ptr())
            };
            (rc == 0).then_some(out)
        }

        pub fn mul(scalar: &[u8; 32], point: &[u8; 32]) -> Option<[u8; 32]> {
            let mut out = [0u8; 32];
            let rc = unsafe {
                sol_curve_group_op(CURVE25519_EDWARDS, MUL, scalar.as_ptr(), point.as_ptr(), out.as_mut_ptr())
            };
            (rc == 0).then_some(out)
        }

        pub fn multiscalar_mul(scalars: &[[u8; 32]], points: &[[u8; 32]]) -> Option<[u8; 32]> {
            if scalars.len() != points.len() {
                return None;
            }
            let mut out = [0u8; 32];
            let rc = unsafe {
                sol_curve_multiscalar_mul(
                    CURVE25519_EDWARDS,
                    scalars.as_ptr() as *const u8,
                    points.as_ptr() as *const u8,
                    points.len() as u64,
                    out.as_mut_ptr(),
                )
            };
            (rc == 0).then_some(out)
        }
    }

    #[cfg(not(target_os = "solana"))]
    mod imp {
        use curve25519_dalek::edwards::{CompressedEdwardsY, EdwardsPoint};
        use curve25519_dalek::scalar::Scalar;
        use curve25519_dalek::traits::VartimeMultiscalarMul;

        fn point(bytes: &[u8; 32]) -> Option<EdwardsPoint> {
            CompressedEdwardsY(*bytes).decompress()
        }

        fn scalar(bytes: &[u8; 32]) -> Option<Scalar> {
            Option::from(Scalar::from_canonical_bytes(*bytes))
        }

        pub fn validate(p: &[u8; 32]) -> bool {
            point(p).is_some()
        }

        pub fn add(left: &[u8; 32], right: &[u8; 32]) -> Option<[u8; 32]> {
            Some((point(left)? + point(right)?).compress().to_bytes())
        }

        pub fn mul(s: &[u8; 32], p: &[u8; 32]) -> Option<[u8; 32]> {
            Some((scalar(s)? * point(p)?).compress().to_bytes())
        }

        pub fn multiscalar_mul(scalars: &[[u8; 32]], points: &[[u8; 32]]) -> Option<[u8; 32]> {
            if scalars.len() != points.len() {
                return None;
            }
            let scalars = scalars.iter().map(scalar).collect::<Option<Vec<_>>>()?;
            let points = points.iter().map(point).collect::<Option<Vec<_>>>()?;
            Some(EdwardsPoint::vartime_multiscalar_mul(scalars, points).compress().to_bytes())
        }
    }

    pub use imp::*;
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

#[event]
pub struct CapsuleCreated {
    pub capsule: Pubkey,
    pub guardian_count: u8,
    pub guardian_threshold: u8,
    pub heartbeat_interval: i64,
    pub grace_period: i64,
}

#[event]
pub struct HeartbeatVerified {
    pub capsule: Pubkey,
    pub nonce: u64,
    pub timestamp: i64,
    pub claim_cancelled: bool,
}

#[event]
pub struct CapsuleUpdated {
    pub capsule: Pubkey,
    pub nonce: u64,
    pub guardian_count: u8,
    pub guardian_threshold: u8,
    pub heartbeat_interval: i64,
    pub grace_period: i64,
    pub claim_cancelled: bool,
}

#[event]
pub struct ClaimTriggered {
    pub capsule: Pubkey,
    pub triggered_at: i64,
}

#[event]
pub struct GuardianConfirmed {
    pub capsule: Pubkey,
    pub guardian: Pubkey,
    pub total_approvals: u8,
}

#[event]
pub struct ClaimVetoed {
    pub capsule: Pubkey,
    pub guardian: Pubkey,
}

#[event]
pub struct CapsuleClaimed {
    pub capsule: Pubkey,
    pub heir: Pubkey,
    pub claimed_at: i64,
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

#[error_code]
pub enum SikritError {
    #[msg("Heartbeat interval terlalu singkat")]
    HeartbeatIntervalTooShort,
    #[msg("Grace period terlalu singkat")]
    GracePeriodTooShort,
    #[msg("Jumlah guardian melebihi batas maksimal")]
    TooManyGuardians,
    #[msg("Threshold guardian tidak valid")]
    InvalidGuardianThreshold,
    #[msg("Jumlah shares melebihi batas maksimal")]
    TooManyShares,
    #[msg("Kapsul tidak dalam status aktif")]
    CapsuleNotActive,
    #[msg("Public commitment curve25519 tidak valid")]
    InvalidCommitment,
    #[msg("Nilai R pada ZK proof tidak valid")]
    InvalidProofR,
    #[msg("Nilai skalar s pada ZK proof tidak valid")]
    InvalidProofS,
    #[msg("Verifikasi ZK Schnorr proof gagal!")]
    ProofVerificationFailed,
    #[msg("Interval heartbeat belum berakhir")]
    HeartbeatNotExpired,
    #[msg("Klaim belum dalam status pending")]
    ClaimNotPending,
    #[msg("Bukan guardian yang terdaftar (komitmen di slot ini tidak terbuka)")]
    UnauthorizedGuardian,
    #[msg("Grace period belum berakhir")]
    GracePeriodNotExpired,
    #[msg("Persetujuan guardian belum memenuhi threshold")]
    InsufficientGuardianApprovals,
    #[msg("Bukan ahli waris yang terdaftar pada kapsul ini (komitmen tidak terbuka)")]
    UnauthorizedHeir,
    #[msg("Komitmen ahli waris tidak valid")]
    InvalidHeir,
    #[msg("Komitmen guardian tidak valid")]
    InvalidGuardian,
    #[msg("Komitmen guardian terdaftar lebih dari sekali")]
    DuplicateGuardian,
    #[msg("Komitmen ahli waris tidak boleh dipakai sebagai guardian")]
    HeirCannotBeGuardian,
    #[msg("Guardian sudah menyetujui klaim ini")]
    GuardianAlreadyApproved,
    #[msg("Guardian sudah memakai vetonya")]
    GuardianAlreadyVetoed,
    #[msg("Grace period sudah berakhir, veto tidak lagi diizinkan")]
    VetoWindowClosed,
    #[msg("Kapsul sudah diklaim")]
    CapsuleAlreadyClaimed,
    #[msg("Nonce heartbeat overflow")]
    NonceOverflow,
    #[msg("Bukti liveness sudah kedaluwarsa")]
    ProofExpired,
    #[msg("Masa berlaku bukti liveness melebihi batas maksimal")]
    ProofExpiryTooFar,
}

// -----------------------------------------------------------------------------
// Unit tests (host): verifier Schnorr + validasi konfigurasi
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use curve25519_dalek::constants::EIGHT_TORSION;
    use curve25519_dalek::edwards::{CompressedEdwardsY, EdwardsPoint};

    const PROGRAM: Pubkey = Pubkey::new_from_array([0x11; 32]);
    const CAPSULE: Pubkey = Pubkey::new_from_array([0x22; 32]);

    fn hash_scalar(tag: &str) -> Scalar {
        Scalar::from_bytes_mod_order_wide(&Sha512::digest(tag.as_bytes()).into())
    }

    fn commit(x: &Scalar) -> [u8; 32] {
        EdwardsPoint::mul_base(x).compress().to_bytes()
    }

    fn prove(x: &Scalar, domain: &[u8], capsule: &Pubkey, context: &[u8]) -> SchnorrProof {
        let k = hash_scalar("unit-test nonce") + x;
        let r = commit(&k);
        let e = schnorr::challenge(&PROGRAM, domain, capsule, &commit(x), &r, context);
        SchnorrProof { r, s: (k + e * x).to_bytes() }
    }

    fn verify(
        commitment: &[u8; 32],
        proof: &SchnorrProof,
        domain: &[u8],
        capsule: &Pubkey,
        context: &[u8],
    ) -> Result<()> {
        let e = schnorr::challenge(&PROGRAM, domain, capsule, commitment, &proof.r, context);
        schnorr::verify(commitment, proof, &e)
    }

    fn assert_err(result: Result<()>, expected: SikritError) {
        match result {
            Err(Error::AnchorError(e)) => assert_eq!(e.error_code_number, u32::from(expected)),
            other => panic!("expected {expected:?}, got {other:?}"),
        }
    }

    fn hex32(hex: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap();
        }
        out
    }

    const EXPIRES_AT: i64 = 1_790_000_600;

    #[test]
    fn valid_liveness_proof_verifies() {
        let x = hash_scalar("owner");
        let p = commit(&x);
        let context = schnorr::liveness_context(0, EXPIRES_AT);
        let proof = prove(&x, LIVENESS_DOMAIN, &CAPSULE, &context);
        verify(&p, &proof, LIVENESS_DOMAIN, &CAPSULE, &context).unwrap();
    }

    #[test]
    fn proof_is_bound_to_nonce_expiry_capsule_domain_and_program() {
        let x = hash_scalar("owner");
        let p = commit(&x);
        let context = schnorr::liveness_context(0, EXPIRES_AT);
        let proof = prove(&x, LIVENESS_DOMAIN, &CAPSULE, &context);

        // Replay setelah nonce naik.
        assert_err(
            verify(&p, &proof, LIVENESS_DOMAIN, &CAPSULE, &schnorr::liveness_context(1, EXPIRES_AT)),
            SikritError::ProofVerificationFailed,
        );
        // Masa berlaku diperpanjang oleh pihak yang menahan bukti.
        assert_err(
            verify(&p, &proof, LIVENESS_DOMAIN, &CAPSULE, &schnorr::liveness_context(0, EXPIRES_AT + 3600)),
            SikritError::ProofVerificationFailed,
        );
        // Kapsul lain dengan commitment yang sama.
        assert_err(
            verify(&p, &proof, LIVENESS_DOMAIN, &Pubkey::new_unique(), &context),
            SikritError::ProofVerificationFailed,
        );
        // Bukti liveness dipakai sebagai bukti registrasi.
        assert_err(
            verify(&p, &proof, REGISTER_DOMAIN, &CAPSULE, &context),
            SikritError::ProofVerificationFailed,
        );
        // Deployment program lain.
        let e = schnorr::challenge(&crate::ID, LIVENESS_DOMAIN, &CAPSULE, &p, &proof.r, &context);
        assert_err(schnorr::verify(&p, &proof, &e), SikritError::ProofVerificationFailed);
    }

    #[test]
    fn wrong_secret_is_rejected() {
        let p = commit(&hash_scalar("owner"));
        let forged = prove(&hash_scalar("attacker"), LIVENESS_DOMAIN, &CAPSULE, &[0; 8]);
        assert_err(
            verify(&p, &forged, LIVENESS_DOMAIN, &CAPSULE, &[0; 8]),
            SikritError::ProofVerificationFailed,
        );
    }

    #[test]
    fn tampered_or_non_canonical_s_is_rejected() {
        let x = hash_scalar("owner");
        let p = commit(&x);
        let proof = prove(&x, LIVENESS_DOMAIN, &CAPSULE, &[0; 8]);

        let tampered = SchnorrProof { s: (Scalar::from_canonical_bytes(proof.s).unwrap() + Scalar::ONE).to_bytes(), ..proof };
        assert_err(
            verify(&p, &tampered, LIVENESS_DOMAIN, &CAPSULE, &[0; 8]),
            SikritError::ProofVerificationFailed,
        );

        // s = ℓ (encoding non-kanonik dari 0) dan s dengan bit tertinggi menyala.
        let mut ell = (-Scalar::ONE).to_bytes();
        ell[0] += 1;
        for s in [ell, [0xff; 32]] {
            assert_err(
                verify(&p, &SchnorrProof { s, ..proof }, LIVENESS_DOMAIN, &CAPSULE, &[0; 8]),
                SikritError::InvalidProofS,
            );
        }
    }

    #[test]
    fn invalid_or_mismatched_r_is_rejected() {
        let x = hash_scalar("owner");
        let p = commit(&x);
        let proof = prove(&x, LIVENESS_DOMAIN, &CAPSULE, &[0; 8]);

        let not_a_point = (2u8..)
            .map(|y| {
                let mut bytes = [0u8; 32];
                bytes[0] = y;
                bytes
            })
            .find(|bytes| CompressedEdwardsY(*bytes).decompress().is_none())
            .unwrap();
        assert_err(
            verify(&p, &SchnorrProof { r: not_a_point, ..proof }, LIVENESS_DOMAIN, &CAPSULE, &[0; 8]),
            SikritError::InvalidProofR,
        );

        // −R: titik valid, tapi persamaan Schnorr tidak terpenuhi.
        let mut negated = proof.r;
        negated[31] ^= 0x80;
        assert_err(
            verify(&p, &SchnorrProof { r: negated, ..proof }, LIVENESS_DOMAIN, &CAPSULE, &[0; 8]),
            SikritError::ProofVerificationFailed,
        );
    }

    #[test]
    fn commitment_must_be_canonical_prime_order_point() {
        let p = EdwardsPoint::mul_base(&hash_scalar("owner"));
        schnorr::validate_commitment(&p.compress().to_bytes()).unwrap();

        // Identitas + seluruh titik torsi orde ≤ 8 (termasuk encoding all-zero, orde 4).
        for torsion in EIGHT_TORSION {
            assert_err(
                schnorr::validate_commitment(&torsion.compress().to_bytes()),
                SikritError::InvalidCommitment,
            );
        }
        assert_err(schnorr::validate_commitment(&[0; 32]), SikritError::InvalidCommitment);

        // Titik mixed-torsion P + T: kunci pemilik sendiri hanya bisa membuktikan dengan peluang 1/8.
        for torsion in &EIGHT_TORSION[1..] {
            assert_err(
                schnorr::validate_commitment(&(p + torsion).compress().to_bytes()),
                SikritError::InvalidCommitment,
            );
        }

        // y ≥ 2^255 − 19 bukan encoding kanonik.
        let mut field_modulus = [0xff; 32];
        field_modulus[0] = 0xed;
        field_modulus[31] = 0x7f;
        assert!(!schnorr::is_canonical(&field_modulus));
        field_modulus[0] = 0xec;
        assert!(schnorr::is_canonical(&field_modulus));
    }

    /// Vektor dari sdk/liveness.ts (x, aux = 0³², nonce = 7, expires_at = 1 790 000 600,
    /// program = 0x11³², capsule = 0x22³²). Mengunci format transkrip Fiat–Shamir lintas bahasa
    /// (TS prover ↔ Rust verifier).
    #[test]
    fn known_answer_vector_from_typescript_sdk() {
        let x = Scalar::from_canonical_bytes(hex32(
            "cc06ce634561e95bfc9b213fde6df570604f9e98e971825808f84ddcac1ffc00",
        ))
        .unwrap();
        let p = hex32("bf8a3946a4fa347da1c7998a0847d8c7adc04d2a4fc2a6ad184745ee1a3109ef");
        let proof = SchnorrProof {
            r: hex32("0debb193d37e14f122354eefb14a6542da19c37d5297ac9085651ea87ecae994"),
            s: hex32("c47c8c123ecda4316a7433533f57a48da2e9d1390b3e3fda7669d3c5d0f0af00"),
        };
        assert_eq!(commit(&x), p);
        schnorr::validate_commitment(&p).unwrap();
        verify(&p, &proof, LIVENESS_DOMAIN, &CAPSULE, &schnorr::liveness_context(7, EXPIRES_AT)).unwrap();
        for context in [schnorr::liveness_context(8, EXPIRES_AT), schnorr::liveness_context(7, EXPIRES_AT + 1)] {
            assert_err(
                verify(&p, &proof, LIVENESS_DOMAIN, &CAPSULE, &context),
                SikritError::ProofVerificationFailed,
            );
        }
    }

    /// Vektor `proveUpdate` dari sdk/liveness.ts (x, aux, program, capsule dan expires_at seperti di atas, nonce = 7;
    /// config: heir 0x44³², interval 60, grace 120, guardian 0x55³² dan 0x66³², kuorum 1, share hash 0x77³²/0x88³²/0x99³²).
    /// Mengunci transkrip update (prefiks nonce ‖ expires_at lalu Borsh config) lintas bahasa.
    #[test]
    fn update_known_answer_vector_from_typescript_sdk() {
        let p = hex32("bf8a3946a4fa347da1c7998a0847d8c7adc04d2a4fc2a6ad184745ee1a3109ef");
        let config = CapsuleConfig {
            heir_commitment: [0x44; 32],
            heartbeat_interval: 60,
            grace_period: 120,
            guardian_commitments: vec![[0x55; 32], [0x66; 32]],
            guardian_threshold: 1,
            share_hashes: vec![[0x77; 32], [0x88; 32], [0x99; 32]],
        };
        let proof = SchnorrProof {
            r: hex32("6da114eef0357c0097840bb0b0a3017eb156aa0291eff6b050dd97678cdccda8"),
            s: hex32("c6b4e426c112793392968595d48ee21ad20561565e430b333512661f6b59a303"),
        };
        let context = schnorr::update_context(7, EXPIRES_AT, &config.try_to_vec().unwrap());
        assert_eq!(context.len(), 16 + 32 + 8 + 8 + (4 + 2 * 32) + 1 + (4 + 3 * 32));
        verify(&p, &proof, UPDATE_DOMAIN, &CAPSULE, &context).unwrap();
        assert_err(
            verify(&p, &proof, LIVENESS_DOMAIN, &CAPSULE, &context),
            SikritError::ProofVerificationFailed,
        );
    }

    /// Vektor yang dihitung ulang dengan `hashlib` Python: P = 0x33³², wallet = 0x44³², salt = 0x55³².
    #[test]
    fn member_commitment_known_answer_and_binding() {
        let (p, wallet, salt) = ([0x33; 32], Pubkey::new_from_array([0x44; 32]), [0x55; 32]);
        let guardian = member_commitment(&p, ROLE_GUARDIAN, &wallet, &salt);
        assert_eq!(guardian, hex32("e34bf422e0d0e276e1519a96931ee0574e6a0b8b9629048ebc5e3690453820d8"));
        assert_eq!(
            member_commitment(&p, ROLE_HEIR, &wallet, &salt),
            hex32("cadedb6934386496c3d769d40f491534b2e682333e674ac18b9a66625e18a709")
        );
        // Kapsul lain, wallet lain, atau salt lain → komitmen lain.
        assert_ne!(member_commitment(&[0x34; 32], ROLE_GUARDIAN, &wallet, &salt), guardian);
        assert_ne!(member_commitment(&p, ROLE_GUARDIAN, &Pubkey::new_unique(), &salt), guardian);
        assert_ne!(member_commitment(&p, ROLE_GUARDIAN, &wallet, &[0x56; 32]), guardian);
    }

    fn opening(role: u8) -> (Pubkey, [u8; 32], [u8; 32]) {
        let wallet = Pubkey::new_unique();
        let salt = Sha512::digest(wallet.as_ref())[..32].try_into().unwrap();
        (wallet, salt, member_commitment(&[0x33; 32], role, &wallet, &salt))
    }

    fn config() -> CapsuleConfig {
        CapsuleConfig {
            heir_commitment: opening(ROLE_HEIR).2,
            heartbeat_interval: MIN_HEARTBEAT_INTERVAL,
            grace_period: MIN_GRACE_PERIOD,
            guardian_commitments: (0..3).map(|_| opening(ROLE_GUARDIAN).2).collect(),
            guardian_threshold: 2,
            share_hashes: vec![[7; 32]; 3],
        }
    }

    #[test]
    fn registration_proof_binds_the_whole_config() {
        let x = hash_scalar("owner");
        let p = commit(&x);
        let original = config();
        let proof = prove(&x, REGISTER_DOMAIN, &CAPSULE, &original.try_to_vec().unwrap());
        verify(&p, &proof, REGISTER_DOMAIN, &CAPSULE, &original.try_to_vec().unwrap()).unwrap();

        let swapped_heir = CapsuleConfig { heir_commitment: opening(ROLE_HEIR).2, ..original.clone() };
        let no_guardians = CapsuleConfig { guardian_commitments: vec![], guardian_threshold: 0, ..original };
        for tampered in [swapped_heir, no_guardians] {
            assert_err(
                verify(&p, &proof, REGISTER_DOMAIN, &CAPSULE, &tampered.try_to_vec().unwrap()),
                SikritError::ProofVerificationFailed,
            );
        }
    }

    #[test]
    fn update_proof_binds_nonce_expiry_and_the_whole_config() {
        let x = hash_scalar("owner");
        let p = commit(&x);
        let original = config().try_to_vec().unwrap();
        let context = schnorr::update_context(3, EXPIRES_AT, &original);
        let proof = prove(&x, UPDATE_DOMAIN, &CAPSULE, &context);
        verify(&p, &proof, UPDATE_DOMAIN, &CAPSULE, &context).unwrap();

        let other_heir = CapsuleConfig { heir_commitment: opening(ROLE_HEIR).2, ..config() }.try_to_vec().unwrap();
        for (domain, tampered) in [
            (UPDATE_DOMAIN, schnorr::update_context(4, EXPIRES_AT, &original)), // replay after the nonce moved on
            (UPDATE_DOMAIN, schnorr::update_context(3, EXPIRES_AT + 3600, &original)), // expiry stretched
            (UPDATE_DOMAIN, schnorr::update_context(3, EXPIRES_AT, &other_heir)), // another heir swapped in
            (LIVENESS_DOMAIN, context.clone()), // replayed as a heartbeat
            (REGISTER_DOMAIN, context.clone()), // replayed as a registration
        ] {
            assert_err(
                verify(&p, &proof, domain, &CAPSULE, &tampered),
                SikritError::ProofVerificationFailed,
            );
        }
        // A heartbeat for the same nonce and expiry authorizes no update.
        let beat = prove(&x, LIVENESS_DOMAIN, &CAPSULE, &schnorr::liveness_context(3, EXPIRES_AT));
        assert_err(
            verify(&p, &beat, UPDATE_DOMAIN, &CAPSULE, &context),
            SikritError::ProofVerificationFailed,
        );
    }

    #[test]
    fn config_validation() {
        config().validate().unwrap();
        CapsuleConfig { guardian_commitments: vec![], guardian_threshold: 0, ..config() }.validate().unwrap();

        let base = config();
        let cases = [
            (CapsuleConfig { heartbeat_interval: MIN_HEARTBEAT_INTERVAL - 1, ..config() }, SikritError::HeartbeatIntervalTooShort),
            (CapsuleConfig { grace_period: MIN_GRACE_PERIOD - 1, ..config() }, SikritError::GracePeriodTooShort),
            (CapsuleConfig { heir_commitment: [0; 32], ..config() }, SikritError::InvalidHeir),
            (CapsuleConfig { guardian_commitments: (0..6).map(|_| opening(ROLE_GUARDIAN).2).collect(), ..config() }, SikritError::TooManyGuardians),
            (CapsuleConfig { guardian_threshold: 4, ..config() }, SikritError::InvalidGuardianThreshold),
            (CapsuleConfig { guardian_commitments: vec![[0; 32]], guardian_threshold: 1, ..config() }, SikritError::InvalidGuardian),
            (CapsuleConfig { guardian_commitments: vec![base.heir_commitment], guardian_threshold: 1, ..base.clone() }, SikritError::HeirCannotBeGuardian),
            (CapsuleConfig { guardian_commitments: vec![base.guardian_commitments[0]; 2], ..base.clone() }, SikritError::DuplicateGuardian),
            (CapsuleConfig { share_hashes: vec![[0; 32]; MAX_SHARES + 1], ..config() }, SikritError::TooManyShares),
        ];
        for (cfg, expected) in cases {
            assert_err(cfg.validate(), expected);
        }
    }

    #[test]
    fn guardian_must_open_its_own_slot() {
        let (wallet, salt, committed) = opening(ROLE_GUARDIAN);
        let (other, other_salt, other_committed) = opening(ROLE_GUARDIAN);
        let capsule = Capsule {
            commitment: [0x33; 32],
            heir_commitment: opening(ROLE_HEIR).2,
            heir: Pubkey::default(),
            guardian_commitments: vec![other_committed, committed],
            guardian_threshold: 1,
            approvals: 0,
            vetoes: 0,
            heartbeat_interval: MIN_HEARTBEAT_INTERVAL,
            grace_period: MIN_GRACE_PERIOD,
            last_heartbeat: 0,
            claim_triggered_at: 0,
            heartbeat_nonce: 0,
            share_hashes: vec![],
            status: CapsuleStatus::ClaimPending,
            bump: 255,
        };
        assert_eq!(capsule.guardian_bit(&wallet, 1, &salt).unwrap(), 0b10);
        assert_eq!(capsule.guardian_bit(&other, 0, &other_salt).unwrap(), 0b01);
        for (who, slot, salt) in [
            (&wallet, 0, &salt),             // slot orang lain
            (&wallet, 1, &other_salt),       // salt salah
            (&other, 1, &salt),              // salt yang terlihat di transaksi guardian lain, signer lain
            (&wallet, 2, &salt),             // di luar jumlah guardian
        ] {
            assert_err(capsule.guardian_bit(who, slot, salt).map(|_| ()), SikritError::UnauthorizedGuardian);
        }
        // Komitmen guardian tidak bisa dibuka sebagai ahli waris (role berbeda).
        assert_ne!(member_commitment(&capsule.commitment, ROLE_HEIR, &wallet, &salt), committed);
    }
}
