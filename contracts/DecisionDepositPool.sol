// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// XCM precompile on Asset Hub (pallet-xcm). `execute` runs a message locally
/// with the calling contract's own account as origin.
interface IXcm {
    struct Weight {
        uint64 refTime;
        uint64 proofSize;
    }
    function execute(bytes calldata message, Weight calldata weight) external;
    function weighMessage(bytes calldata message) external view returns (Weight memory weight);
}

/// One pool for one referendum's decision deposit.
///
/// Groups pay KSM in. When the pool holds the full deposit, anyone can place it
/// on the referendum. The contract's own account is the depositor, so the
/// refund comes back here, and anyone can then reclaim it and pay every
/// contributor back to the address they paid from.
///
/// The payment that fills the pool also tries to place the deposit, in the same
/// transaction. If that attempt fails (someone else placed first, the
/// referendum is not ongoing, the call is refused) the payment still counts,
/// nothing leaves, and `place` stays open to anyone as the fallback.
///
/// No owner, no admin, no upgrade. Every parameter is fixed at deployment.
///
/// Amounts are in the EVM's 18-decimal units. KSM has 12 on the chain, so one
/// planck is 10^6 wei and every amount must be a whole number of planck. The
/// ratio is a constructor argument because test networks differ (PAS has 10).
///
/// If governance KILLS the referendum the deposit is slashed and nothing comes
/// back. Every other ending (approved, rejected, cancelled, timed out) refunds.
contract DecisionDepositPool {
    address public constant XCM = address(0xA0000);

    enum State {
        Open, // taking contributions, contributors may withdraw
        Placed, // deposit is on the referendum
        Returning // money is back (or never left): contributors are paid out
    }

    uint32 public immutable referendum;
    uint256 public immutable deposit; // wei
    uint256 public immutable minContribution; // wei
    uint64 public immutable fundingDeadline; // unix seconds; after it, Open pools can be abandoned
    uint8 public immutable referendaPallet;
    uint8 public immutable placeCallIndex;
    uint8 public immutable refundCallIndex;
    uint256 public immutable weiPerPlanck; // the chain's NativeToEthRatio: 1e6 on Kusama Asset Hub, 1e8 on Paseo's

    State public state;
    uint256 public total; // wei pledged and not yet paid back
    uint256 public balanceAfterPlacing; // contract balance right after placing
    address[] public contributors;
    mapping(address => uint256) public contributed; // wei still owed back to each address

    bool private locked;

    event Contributed(address indexed from, uint256 amount, uint256 total);
    event Withdrawn(address indexed to, uint256 amount, uint256 total);
    event Placed(uint32 indexed referendum, uint256 amount, address by);
    event AutoPlaceFailed(uint32 indexed referendum, address by);
    event Reclaimed(uint32 indexed referendum, uint256 amount, address by);
    event Abandoned(address by);
    event Repaid(address indexed to, uint256 amount);
    event RepayFailed(address indexed to, uint256 amount);

    error WrongState();
    error BadAmount();
    error TooLate();
    error TooEarly();
    error NotFull();
    error DepositNotTaken();
    error NothingCameBack();
    error Reentrancy();
    error NotSelf();

    modifier nonReentrant() {
        if (locked) revert Reentrancy();
        locked = true;
        _;
        locked = false;
    }

    constructor(
        uint32 referendum_,
        uint256 depositPlanck,
        uint256 minContributionPlanck,
        uint64 fundingDeadline_,
        uint8 referendaPallet_,
        uint8 placeCallIndex_,
        uint8 refundCallIndex_,
        uint256 weiPerPlanck_
    ) {
        require(weiPerPlanck_ > 0);
        require(depositPlanck > 0 && minContributionPlanck > 0 && minContributionPlanck <= depositPlanck);
        require(fundingDeadline_ > block.timestamp);
        referendum = referendum_;
        deposit = depositPlanck * weiPerPlanck_;
        minContribution = minContributionPlanck * weiPerPlanck_;
        fundingDeadline = fundingDeadline_;
        referendaPallet = referendaPallet_;
        placeCallIndex = placeCallIndex_;
        refundCallIndex = refundCallIndex_;
        weiPerPlanck = weiPerPlanck_;
    }

    // ---------------------------------------------------------------- funding

    /// Pay in. Repeat payments from one address add up. The pool never takes
    /// more than the deposit.
    function contribute() external payable nonReentrant {
        if (state != State.Open) revert WrongState();
        if (block.timestamp >= fundingDeadline) revert TooLate();
        uint256 amount = msg.value;
        if (amount % weiPerPlanck != 0 || amount == 0) revert BadAmount();
        if (total + amount > deposit) revert BadAmount();
        // The last payment may be smaller than the minimum, so a pool can always fill.
        if (amount < minContribution && total + amount != deposit) revert BadAmount();
        if (contributed[msg.sender] == 0) contributors.push(msg.sender);
        contributed[msg.sender] += amount;
        total += amount;
        emit Contributed(msg.sender, amount, total);
        if (total == deposit) {
            // A self-call, so a failed attempt reverts only its own frame: the
            // payment stands and nothing leaves the pool.
            try this.placeFromFill(msg.sender) {} catch {
                emit AutoPlaceFailed(referendum, msg.sender);
            }
        }
    }

    /// Take your own money back while the pool is still open.
    function withdraw() external nonReentrant {
        if (state != State.Open) revert WrongState();
        uint256 amount = contributed[msg.sender];
        if (amount == 0) revert BadAmount();
        contributed[msg.sender] = 0;
        total -= amount;
        emit Withdrawn(msg.sender, amount, total);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok);
    }

    // ---------------------------------------------------------------- deposit

    /// Anyone: place the full deposit on the referendum from this contract's account.
    function place() external nonReentrant {
        if (state != State.Open) revert WrongState();
        if (block.timestamp >= fundingDeadline) revert TooLate();
        if (total != deposit) revert NotFull();
        _place(msg.sender);
    }

    /// Only this contract, from the payment that fills the pool. Not guarded by
    /// nonReentrant because `contribute` already holds the lock.
    function placeFromFill(address by) external {
        if (msg.sender != address(this)) revert NotSelf();
        _place(by);
    }

    function _place(address by) internal {
        uint256 before = address(this).balance;
        _execute(placeMessage());
        // XCM may not surface a failed call, so trust the balance, not the reply.
        if (before - address(this).balance != deposit) revert DepositNotTaken();
        state = State.Placed;
        balanceAfterPlacing = address(this).balance;
        emit Placed(referendum, deposit, by);
    }

    /// Anyone, once the referendum has ended: get the deposit back and open payouts.
    /// Works whether the refund is claimed here or someone already claimed it
    /// directly on governance (the KSM lands in this contract either way).
    function reclaim() external nonReentrant {
        if (state != State.Placed) revert WrongState();
        // Low-level call: if governance refuses (still live, or killed), carry on
        // and let the balance decide.
        (bool ok, ) = XCM.call(
            abi.encodeCall(IXcm.execute, (refundMessage(), IXcm(XCM).weighMessage(refundMessage())))
        );
        ok;
        if (address(this).balance < balanceAfterPlacing + deposit) revert NothingCameBack();
        state = State.Returning;
        emit Reclaimed(referendum, deposit, msg.sender);
    }

    /// Anyone, after the funding deadline, if the deposit was never placed:
    /// open payouts so nobody has to come and withdraw by hand.
    function abandon() external nonReentrant {
        if (state != State.Open) revert WrongState();
        if (block.timestamp < fundingDeadline) revert TooEarly();
        state = State.Returning;
        emit Abandoned(msg.sender);
    }

    // ---------------------------------------------------------------- payouts

    /// Anyone: pay contributors [from, to) back to the address each paid from.
    /// A contributor whose address refuses the payment keeps their claim and
    /// can use `claim` later; one bad address never blocks the rest.
    function payout(uint256 from, uint256 to) external nonReentrant {
        if (state != State.Returning) revert WrongState();
        if (to > contributors.length) to = contributors.length;
        for (uint256 i = from; i < to; i++) {
            address who = contributors[i];
            uint256 amount = contributed[who];
            if (amount == 0) continue;
            contributed[who] = 0;
            total -= amount;
            (bool ok, ) = who.call{value: amount}("");
            if (ok) {
                emit Repaid(who, amount);
            } else {
                contributed[who] = amount;
                total += amount;
                emit RepayFailed(who, amount);
            }
        }
    }

    /// Pull your own share once payouts are open.
    function claim() external nonReentrant {
        if (state != State.Returning) revert WrongState();
        uint256 amount = contributed[msg.sender];
        if (amount == 0) revert BadAmount();
        contributed[msg.sender] = 0;
        total -= amount;
        emit Repaid(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok);
    }

    // ---------------------------------------------------------------- views

    function contributorCount() external view returns (uint256) {
        return contributors.length;
    }

    /// VersionedXcm::V5([Transact { origin_kind: SovereignAccount, fallback_max_weight: None, call }])
    function placeMessage() public view returns (bytes memory) {
        return _transact(placeCallIndex);
    }

    function refundMessage() public view returns (bytes memory) {
        return _transact(refundCallIndex);
    }

    function _transact(uint8 callIndex) internal view returns (bytes memory) {
        uint32 r = referendum;
        bytes memory call = abi.encodePacked(
            referendaPallet,
            callIndex,
            uint8(r),
            uint8(r >> 8),
            uint8(r >> 16),
            uint8(r >> 24)
        );
        return abi.encodePacked(
            uint8(0x05), // VersionedXcm::V5
            uint8(0x04), // one instruction
            uint8(0x06), // Transact
            uint8(0x01), // OriginKind::SovereignAccount
            uint8(0x00), // fallback_max_weight: None
            uint8(0x18), // compact length 6
            call
        );
    }

    function _execute(bytes memory message) internal {
        IXcm(XCM).execute(message, IXcm(XCM).weighMessage(message));
    }
}
