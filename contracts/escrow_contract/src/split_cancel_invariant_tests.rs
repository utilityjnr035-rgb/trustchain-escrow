//! # Split escrow cancellation invariants (Issue #210)
//!
//! Validates that when a split escrow is cancelled each participant receives
//! only their intended refund share and no residue is lost.
//!
//! ## Coverage matrix
//!
//! | # | Scenario | Invariant checked |
//! |---|----------|-------------------|
//! | 1 | Two-way split, both children cancelled | Each child refunds only its own balance |
//! | 2 | Multi-party split (three children) | All three refund shares sum to parent unallocated |
//! | 3 | Partial release before cancellation | Already-released milestones not double-counted |
//! | 4 | Rounding residue | Integer residue stays in contract, not silently lost |
//! | 5 | Cancellation of child with no milestones | Full balance returned to client |
//! | 6 | Child cancelled while sibling is still active | Sibling unaffected |

#[cfg(test)]
#[allow(clippy::module_inception)]
mod split_cancel_invariant_tests {
    use soroban_sdk::{testutils::Address as _, token, Address, BytesN, Env, String};

    use crate::{EscrowContract, EscrowContractClient, EscrowStatus, MultisigConfig};

    // ── Constants ─────────────────────────────────────────────────────────────

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

    /// Creates a parent escrow with `total_amount` and one milestone of
    /// `milestone_amount` (leaving `total_amount - milestone_amount` unallocated
    /// and therefore splittable).  Returns `(escrow_id, token_address)`.
    fn parent_with_one_milestone(
        env: &Env,
        admin: &Address,
        contract: &EscrowContractClient<'static>,
        client_addr: &Address,
        freelancer: &Address,
        total_amount: i128,
        milestone_amount: i128,
    ) -> (u64, Address) {
        let token = register_token(env, admin, client_addr, total_amount + RENT_BUFFER);
        let escrow_id = contract.create_escrow(
            client_addr,
            freelancer,
            &token,
            &total_amount,
            &hash32(env, 1),
            &None,
            &None,
            &None,
            &None,
            &no_multisig(env),
            &None,
        );
        contract.add_milestone(
            client_addr,
            &escrow_id,
            &String::from_str(env, "Milestone 1"),
            &hash32(env, 2),
            &milestone_amount,
        );
        (escrow_id, token)
    }

    // ── Test 1: Two-way split — each child gets its own refund ───────────────

    /// After splitting the unallocated balance into two children, cancelling
    /// each child must refund exactly that child's `total_amount` to the client,
    /// with no leakage between the two children.
    #[test]
    fn test_two_way_split_cancel_each_refunds_correct_share() {
        let (env, admin, contract) = setup();
        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);

        // total = 1000, milestone = 400 → 600 unallocated
        let (parent_id, token) = parent_with_one_milestone(
            &env, &admin, &contract, &client_addr, &freelancer, 1_000, 400,
        );

        // Split: child1 = 250, child2 = 350 (must sum to 600)
        let (child1_id, child2_id) =
            contract.split_escrow(&client_addr, &parent_id, &250_i128, &hash32(&env, 3));

        let tok = token::Client::new(&env, &token);
        let balance_before = tok.balance(&client_addr);

        // Cancel child1 → refund 250
        contract.cancel_escrow(&client_addr, &child1_id);
        let balance_after_c1 = tok.balance(&client_addr);
        assert_eq!(
            balance_after_c1 - balance_before,
            250,
            "Cancelling child1 must refund exactly 250 to client"
        );

        // Cancel child2 → refund 350
        contract.cancel_escrow(&client_addr, &child2_id);
        let balance_after_c2 = tok.balance(&client_addr);
        assert_eq!(
            balance_after_c2 - balance_after_c1,
            350,
            "Cancelling child2 must refund exactly 350 to client"
        );

        // Verify children are now Cancelled
        assert_eq!(contract.get_escrow_meta(&child1_id).status, EscrowStatus::Cancelled);
        assert_eq!(contract.get_escrow_meta(&child2_id).status, EscrowStatus::Cancelled);
    }

    // ── Test 2: Multi-party split — three children ────────────────────────────

    /// Splitting unallocated balance into three tranches, then cancelling all
    /// three, must result in the sum of refunds equalling the original
    /// unallocated balance with zero residue.
    #[test]
    fn test_multi_party_split_cancel_sums_to_unallocated() {
        let (env, admin, contract) = setup();
        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);

        // total = 3000, milestone = 300 → 2700 unallocated
        let (parent_id, token) = parent_with_one_milestone(
            &env, &admin, &contract, &client_addr, &freelancer, 3_000, 300,
        );

        // First split: child_a = 900, remainder = 1800
        let (child_a_id, rem_id) =
            contract.split_escrow(&client_addr, &parent_id, &900_i128, &hash32(&env, 10));

        // Second split on remainder: child_b = 800, child_c = 1000
        let (child_b_id, child_c_id) =
            contract.split_escrow(&client_addr, &rem_id, &800_i128, &hash32(&env, 11));

        let tok = token::Client::new(&env, &token);
        let balance_before = tok.balance(&client_addr);

        contract.cancel_escrow(&client_addr, &child_a_id);
        contract.cancel_escrow(&client_addr, &child_b_id);
        contract.cancel_escrow(&client_addr, &child_c_id);

        let total_refund = tok.balance(&client_addr) - balance_before;
        // child_a(900) + child_b(800) + child_c(1000) = 2700
        assert_eq!(
            total_refund, 2_700,
            "Sum of all three child cancellations must equal the original unallocated balance"
        );
    }

    // ── Test 3: Partial release before cancellation ───────────────────────────

    /// When a milestone in a child escrow has been approved and released before
    /// the escrow is cancelled, the cancellation must not attempt to refund the
    /// already-released amount a second time.
    #[test]
    fn test_partial_release_before_cancellation_not_double_counted() {
        let (env, admin, contract) = setup();
        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);

        // Parent: total = 2000, milestone = 500 → 1500 unallocated
        let (parent_id, token) = parent_with_one_milestone(
            &env, &admin, &contract, &client_addr, &freelancer, 2_000, 500,
        );

        // Split: child1 = 700, child2 = 800
        let (child1_id, child2_id) =
            contract.split_escrow(&client_addr, &parent_id, &700_i128, &hash32(&env, 20));

        // Add a milestone of 300 to child1 and release it
        contract.add_milestone(
            &client_addr,
            &child1_id,
            &String::from_str(&env, "Sub-milestone"),
            &hash32(&env, 21),
            &300_i128,
        );

        let milestone_id: u32 = 0;
        contract.submit_milestone(&freelancer, &child1_id, &milestone_id);
        contract.approve_milestone(&client_addr, &child1_id, &milestone_id);
        contract.release_funds(&client_addr, &child1_id, &milestone_id);

        let tok = token::Client::new(&env, &token);
        let freelancer_balance_after_release = tok.balance(&freelancer);

        // Cancel child1 — remaining unallocated = 700 - 300 = 400
        let client_balance_before_cancel = tok.balance(&client_addr);
        contract.cancel_escrow(&client_addr, &child1_id);
        let client_refund = tok.balance(&client_addr) - client_balance_before_cancel;

        assert_eq!(
            client_refund, 400,
            "Cancellation refund must be 400 (700 total - 300 already released)"
        );

        // Freelancer's released amount must be unchanged (no double-release)
        assert_eq!(
            tok.balance(&freelancer),
            freelancer_balance_after_release,
            "Freelancer balance must not change during cancellation of child escrow"
        );

        // child2 is unaffected
        assert_eq!(contract.get_escrow_meta(&child2_id).status, EscrowStatus::Active);
    }

    // ── Test 4: Rounding residue stays in contract ────────────────────────────

    /// When the unallocated balance does not divide evenly between two children
    /// (due to integer truncation), the cancellations must sum to exactly the
    /// amount distributed during the split and no tokens are created from thin air.
    #[test]
    fn test_rounding_residue_not_lost_on_cancel() {
        let (env, admin, contract) = setup();
        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);

        // total = 1001, milestone = 1 → 1000 unallocated (even split: 499 + 501)
        let (parent_id, token) = parent_with_one_milestone(
            &env, &admin, &contract, &client_addr, &freelancer, 1_001, 1,
        );

        // Deliberately uneven: child1 = 499, child2 = 501
        let (child1_id, child2_id) =
            contract.split_escrow(&client_addr, &parent_id, &499_i128, &hash32(&env, 30));

        let tok = token::Client::new(&env, &token);
        let balance_before = tok.balance(&client_addr);

        contract.cancel_escrow(&client_addr, &child1_id);
        contract.cancel_escrow(&client_addr, &child2_id);

        let total_refund = tok.balance(&client_addr) - balance_before;
        // Both sides should sum to 1000 (the split amounts; not 1001 because
        // the milestone-allocated 1 unit is still in the parent)
        assert_eq!(
            total_refund, 1_000,
            "Integer rounding must not produce extra tokens; total refund = child1 + child2"
        );
    }

    // ── Test 5: Child with no milestones — full balance returned ─────────────

    /// A child escrow that has no milestones added (all balance unallocated)
    /// must refund its entire `total_amount` to the client upon cancellation.
    #[test]
    fn test_child_no_milestones_full_refund_on_cancel() {
        let (env, admin, contract) = setup();
        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);

        // Parent: total = 800, milestone = 200 → 600 unallocated
        let (parent_id, token) = parent_with_one_milestone(
            &env, &admin, &contract, &client_addr, &freelancer, 800, 200,
        );

        // Split: child with 300, no milestones added to it
        let (child_id, _sibling_id) =
            contract.split_escrow(&client_addr, &parent_id, &300_i128, &hash32(&env, 40));

        let tok = token::Client::new(&env, &token);
        let balance_before = tok.balance(&client_addr);

        contract.cancel_escrow(&client_addr, &child_id);
        let refund = tok.balance(&client_addr) - balance_before;

        assert_eq!(
            refund, 300,
            "Child with no milestones must refund its entire total_amount on cancel"
        );
    }

    // ── Test 6: Cancelling one child does not affect its sibling ─────────────

    /// The cancellation of child1 must leave child2's status, balance, and
    /// milestone data entirely untouched.
    #[test]
    fn test_cancel_one_child_does_not_affect_sibling() {
        let (env, admin, contract) = setup();
        let client_addr = Address::generate(&env);
        let freelancer = Address::generate(&env);

        // Parent: total = 2000, milestone = 500 → 1500 unallocated
        let (parent_id, _token) = parent_with_one_milestone(
            &env, &admin, &contract, &client_addr, &freelancer, 2_000, 500,
        );

        // Split: child1 = 600, child2 = 900
        let (child1_id, child2_id) =
            contract.split_escrow(&client_addr, &parent_id, &600_i128, &hash32(&env, 50));

        // Add a milestone to child2 so it has non-trivial state
        contract.add_milestone(
            &client_addr,
            &child2_id,
            &String::from_str(&env, "Child2 work"),
            &hash32(&env, 51),
            &400_i128,
        );

        // Cancel child1
        contract.cancel_escrow(&client_addr, &child1_id);

        // Child1 must be cancelled
        assert_eq!(contract.get_escrow_meta(&child1_id).status, EscrowStatus::Cancelled);

        // Child2 must still be Active with its balance and milestone count intact
        let child2_meta = contract.get_escrow_meta(&child2_id);
        assert_eq!(child2_meta.status, EscrowStatus::Active);
        assert_eq!(
            child2_meta.total_amount, 900,
            "Sibling total_amount must be unchanged after peer cancellation"
        );
        assert_eq!(
            child2_meta.milestone_count, 1,
            "Sibling milestone count must be unchanged after peer cancellation"
        );
    }
}
