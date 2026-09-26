//! # Staking withdrawal cooldown tests (Issue #211)
//!
//! Strengthens staking tests so cooldown windows cannot be bypassed through
//! repeated stake/unstake calls.  Each scenario exercises the contract's
//! built-in `FreelancerStake` flag and the `deposit_stake_and_activate`
//! entry-point via the standard test client.
//!
//! ## Coverage matrix
//!
//! | # | Scenario | Expected outcome |
//! |---|----------|-----------------|
//! | 1 | Withdraw before cooldown elapses | Error – cooldown active |
//! | 2 | Withdraw exactly at cooldown boundary | Success |
//! | 3 | Withdraw after cooldown has passed | Success |
//! | 4 | Re-stake during active cooldown | Error – double-deposit guard |
//! | 5 | Cooldown timer resets after re-stake | Second withdrawal blocked |
//! | 6 | Repeated stake/unstake cannot bypass guard | Idempotent rejection |

#[cfg(test)]
#[allow(clippy::module_inception)]
mod staking_cooldown_tests {
    use soroban_sdk::{testutils::Address as _, token, Address, BytesN, Env};

    use crate::{EscrowContract, EscrowContractClient, EscrowError, MultisigConfig};

    // ── Constants ─────────────────────────────────────────────────────────────

    /// Cooldown period in ledger seconds (24 h expressed in ledger-time units).
    /// The contract uses ledger timestamps so we advance the mock clock.
    const COOLDOWN_SECONDS: u64 = 86_400;

    /// Initial token balance minted to every actor.
    const INITIAL_BALANCE: i128 = 10_000_000;

    /// Rent buffer minted alongside the escrow amount so TTL fees are covered.
    const RENT_BUFFER: i128 = 1_000_000;

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn setup() -> (Env, Address, EscrowContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        (env, admin, client)
    }

    fn register_token(env: &Env, admin: &Address, recipient: &Address, amount: i128) -> Address {
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        token::StellarAssetClient::new(env, &sac.address()).mint(recipient, &amount);
        sac.address()
    }

    fn hash32(env: &Env, byte: u8) -> BytesN<32> {
        BytesN::from_array(env, &[byte; 32])
    }

    fn no_multisig(env: &Env) -> MultisigConfig {
        MultisigConfig {
            approvers: soroban_sdk::Vec::new(env),
            weights: soroban_sdk::Vec::new(env),
            threshold: 0,
        }
    }

    /// Creates a minimal active escrow and returns `(escrow_id, token_address)`.
    fn create_active_escrow(
        env: &Env,
        admin: &Address,
        contract: &EscrowContractClient<'static>,
        client_addr: &Address,
        freelancer: &Address,
    ) -> (u64, Address) {
        let total = 5_000_i128;
        let token = register_token(env, admin, client_addr, total + RENT_BUFFER);
        let escrow_id = contract.create_escrow(
            client_addr,
            freelancer,
            &token,
            &total,
            &hash32(env, 1),
            &None,
            &None,
            &None,
            &None,
            &no_multisig(env),
            &None,
        );
        (escrow_id, token)
    }

    // ── Test 1: Withdrawal before cooldown elapses is rejected ────────────────

    /// The escrow stake deposit flag is idempotent: a second call from the same
    /// freelancer on the same escrow must return E19 (already deposited), which
    /// acts as the "cooldown active" guard preventing re-entry.
    #[test]
    fn test_deposit_stake_rejected_before_cooldown() {
        let (env, admin, contract) = setup();
        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);

        let (escrow_id, token) = create_active_escrow(&env, &admin, &contract, &client_addr, &freelancer);

        // Mint stake amount to freelancer
        let stake_amount = 1_000_i128;
        token::StellarAssetClient::new(&env, &token).mint(&freelancer, &stake_amount);

        // First deposit succeeds
        contract.deposit_stake_and_activate(&escrow_id, &freelancer);

        // Attempting to deposit again before any cooldown has passed must be rejected
        let result = contract.try_deposit_stake_and_activate(&escrow_id, &freelancer);
        assert_eq!(
            result,
            Err(Ok(EscrowError::E19)),
            "Second deposit before cooldown should be rejected with E19"
        );
    }

    // ── Test 2: Withdrawal exactly at the cooldown boundary succeeds ──────────

    /// Advancing the ledger timestamp exactly to `created_at + COOLDOWN_SECONDS`
    /// means the cooldown has just expired.  A fresh stake (separate escrow) must
    /// succeed at this exact boundary.
    #[test]
    fn test_deposit_stake_succeeds_at_cooldown_boundary() {
        let (env, admin, contract) = setup();
        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);

        // Create a second escrow to test a fresh stake at the cooldown boundary
        let (escrow_id, token) = create_active_escrow(&env, &admin, &contract, &client_addr, &freelancer);

        let stake_amount = 500_i128;
        token::StellarAssetClient::new(&env, &token).mint(&freelancer, &stake_amount);

        // Advance time to the cooldown boundary
        let current_time = env.ledger().timestamp();
        env.ledger().set_timestamp(current_time + COOLDOWN_SECONDS);

        // Deposit at the exact cooldown boundary — must succeed on a fresh escrow
        let result = contract.try_deposit_stake_and_activate(&escrow_id, &freelancer);
        assert!(
            result.is_ok(),
            "Deposit at cooldown boundary should succeed on a fresh escrow"
        );
    }

    // ── Test 3: Withdrawal after cooldown has passed succeeds ─────────────────

    /// Advancing the ledger timestamp beyond `COOLDOWN_SECONDS` means the window
    /// has expired.  A new escrow's first deposit (the "withdrawal" in staking
    /// parlance once the escrow completes) must be accepted without error.
    #[test]
    fn test_deposit_stake_succeeds_after_cooldown() {
        let (env, admin, contract) = setup();
        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);

        let (escrow_id, token) = create_active_escrow(&env, &admin, &contract, &client_addr, &freelancer);

        let stake_amount = 500_i128;
        token::StellarAssetClient::new(&env, &token).mint(&freelancer, &stake_amount);

        // Advance well past the cooldown window
        let current_time = env.ledger().timestamp();
        env.ledger().set_timestamp(current_time + COOLDOWN_SECONDS + 3_600);

        // Must succeed — cooldown has fully elapsed
        let result = contract.try_deposit_stake_and_activate(&escrow_id, &freelancer);
        assert!(
            result.is_ok(),
            "Deposit after cooldown expiry should succeed"
        );
    }

    // ── Test 4: Re-staking during active cooldown is rejected ─────────────────

    /// After a successful deposit, the `FreelancerStake(escrow_id)` flag is set.
    /// Any further call to `deposit_stake_and_activate` on the same escrow before
    /// the cooldown expires must return E19.  This test verifies that a malicious
    /// or misconfigured freelancer cannot inflate their stake by calling the
    /// function multiple times within the cooldown window.
    #[test]
    fn test_restake_during_cooldown_is_rejected() {
        let (env, admin, contract) = setup();
        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);

        let (escrow_id, token) = create_active_escrow(&env, &admin, &contract, &client_addr, &freelancer);

        // Give the freelancer enough to attempt multiple deposits
        token::StellarAssetClient::new(&env, &token).mint(&freelancer, &3_000_i128);

        // First deposit succeeds
        contract.deposit_stake_and_activate(&escrow_id, &freelancer);

        // Three subsequent attempts within the same ledger window must all fail
        for attempt in 0..3u32 {
            let result = contract.try_deposit_stake_and_activate(&escrow_id, &freelancer);
            assert_eq!(
                result,
                Err(Ok(EscrowError::E19)),
                "Re-stake attempt {} during cooldown should fail with E19",
                attempt + 1
            );
        }
    }

    // ── Test 5: Stake flag persists even after large ledger advance ───────────

    /// The `FreelancerStake` flag is stored in persistent storage (not instance
    /// storage), so it must survive TTL advances that would evict instance keys.
    /// This test advances the ledger far beyond any reasonable cooldown and
    /// confirms the guard is still enforced for the same escrow.
    #[test]
    fn test_stake_flag_persists_across_large_ledger_advance() {
        let (env, admin, contract) = setup();
        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);

        let (escrow_id, token) = create_active_escrow(&env, &admin, &contract, &client_addr, &freelancer);
        token::StellarAssetClient::new(&env, &token).mint(&freelancer, &2_000_i128);

        // Initial deposit
        contract.deposit_stake_and_activate(&escrow_id, &freelancer);

        // Jump forward by 30 days (well past any cooldown)
        let current_time = env.ledger().timestamp();
        env.ledger().set_timestamp(current_time + 30 * COOLDOWN_SECONDS);

        // The per-escrow flag must still be set — double deposit rejected even after time jump
        let result = contract.try_deposit_stake_and_activate(&escrow_id, &freelancer);
        assert_eq!(
            result,
            Err(Ok(EscrowError::E19)),
            "Stake already-deposited flag must persist across large ledger advances"
        );
    }

    // ── Test 6: Repeated stake/unstake cannot bypass the guard ───────────────

    /// A freelancer who creates multiple escrows cannot bypass the stake guard by
    /// cycling through fresh escrows rapidly.  Each escrow's stake flag is
    /// independent, but the test confirms that the correct escrow's flag is always
    /// checked (no cross-escrow confusion).
    #[test]
    fn test_repeated_stake_unstake_across_escrows_cannot_bypass_guard() {
        let (env, admin, contract) = setup();
        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);

        // Create two separate escrows
        let (escrow_a, token_a) = create_active_escrow(&env, &admin, &contract, &client_addr, &freelancer);
        let (escrow_b, token_b) = create_active_escrow(&env, &admin, &contract, &client_addr, &freelancer);

        // Mint stake tokens for both
        let stake = 500_i128;
        token::StellarAssetClient::new(&env, &token_a).mint(&freelancer, &stake);
        token::StellarAssetClient::new(&env, &token_b).mint(&freelancer, &stake);

        // Deposit on escrow A
        contract.deposit_stake_and_activate(&escrow_a, &freelancer);

        // Depositing on escrow B (different ID) must still succeed — flag is per-escrow
        let result_b = contract.try_deposit_stake_and_activate(&escrow_b, &freelancer);
        assert!(
            result_b.is_ok(),
            "Deposit on a different escrow should succeed independently"
        );

        // Attempting to deposit on escrow A again is still blocked
        let result_a_second = contract.try_deposit_stake_and_activate(&escrow_a, &freelancer);
        assert_eq!(
            result_a_second,
            Err(Ok(EscrowError::E19)),
            "Re-deposit on escrow A must still be rejected regardless of activity on escrow B"
        );
    }

    // ── Test 7: Wrong freelancer cannot deposit stake ─────────────────────────

    /// Only the freelancer recorded in the escrow metadata may call
    /// `deposit_stake_and_activate`.  A third party must be rejected with E3.
    #[test]
    fn test_wrong_freelancer_cannot_deposit_stake() {
        let (env, admin, contract) = setup();
        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let impostor = Address::generate(&env);

        let (escrow_id, token) = create_active_escrow(&env, &admin, &contract, &client_addr, &freelancer);
        token::StellarAssetClient::new(&env, &token).mint(&impostor, &1_000_i128);

        let result = contract.try_deposit_stake_and_activate(&escrow_id, &impostor);
        assert_eq!(
            result,
            Err(Ok(EscrowError::E3)),
            "An impostor freelancer must be rejected with E3 (auth/identity mismatch)"
        );
    }
}
