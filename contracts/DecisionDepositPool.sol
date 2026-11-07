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

/// Version 2. One pool for one referendum's decision deposit, on any track.
///
/// Groups pay KSM in. The payment that fills the pool places the deposit on the
/// referendum from the contract's own account, in the same transaction; if that
/// attempt fails, anyone can place it later. When the referendum ends, anyone
/// reclaims it and every contributor is paid back to the address they paid from.
///
/// Changes from version 1 (the #676 pools):
/// - `reclaim` weighs the refund message inside a try, so a weighing failure can
///   no longer block a refund that already came back by another route.
/// - An address that withdraws and pays in again is listed once.
/// - `sweep` returns KSM that reached the contract without going through
///   `contribute` (a plain transfer runs no code) to `sweepTo`, fixed at
///   deployment, and only ever the excess over what contributors are owed.
/// - Pools are usually opened through `DecisionDepositPoolFactory`, which fixes
///   the chain settings so the person opening a pool cannot get them wrong.
///
/// No owner, no admin, no upgrade. Every parameter is fixed at deployment.
///
/// Amounts are in the EVM's 18-decimal units. One planck is `weiPerPlanck` wei
/// and every amount must be a whole number of planck.
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
    address public immutable sweepTo; // receives only KSM nobody is owed

    State public state;
    uint256 public total; // wei pledged and not yet paid back
    uint256 public balanceAfterPlacing; // contract balance right after placing
    address[] public contributors;
    mapping(address => uint256) public contributed; // wei still owed back to each address
    mapping(address => bool) public listed;

    bool private locked;

    event Contributed(address indexed from, uint256 amount, uint256 total);
    event Withdrawn(address indexed to, uint256 amount, uint256 total);
    event Placed(uint32 indexed referendum, uint256 amount, address by);
    event AutoPlaceFailed(uint32 indexed referendum, address by);
    event Reclaimed(uint32 indexed referendum, uint256 amount, address by);
    event Abandoned(address by);
    event Repaid(address indexed to, uint256 amount);
    event RepayFailed(address indexed to, uint256 amount);
    event Swept(address indexed to, uint256 amount);

    error WrongState();
    error BadAmount();
    error TooLate();
    error TooEarly();
    error NotFull();
    error DepositNotTaken();
    error NothingCameBack();
    error Reentrancy();
    error NotSelf();
    error NothingToSweep();

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
        uint256 weiPerPlanck_,
        address sweepTo_
    ) {
        require(weiPerPlanck_ > 0);
        require(depositPlanck > 0 && minContributionPlanck > 0 && minContributionPlanck <= depositPlanck);
        require(fundingDeadline_ > block.timestamp);
        require(sweepTo_ != address(0) && sweepTo_ != address(this));
        referendum = referendum_;
        deposit = depositPlanck * weiPerPlanck_;
        minContribution = minContributionPlanck * weiPerPlanck_;
        fundingDeadline = fundingDeadline_;
        referendaPallet = referendaPallet_;
        placeCallIndex = placeCallIndex_;
        refundCallIndex = refundCallIndex_;
        weiPerPlanck = weiPerPlanck_;
        sweepTo = sweepTo_;
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
        if (!listed[msg.sender]) {
            listed[msg.sender] = true;
            contributors.push(msg.sender);
        }
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
        bytes memory message = placeMessage();
        IXcm(XCM).execute(message, IXcm(XCM).weighMessage(message));
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
        bytes memory message = refundMessage();
        // Weighing and executing may both fail (still live, killed, a renumbered
        // call). Neither may stop a refund that already arrived: the balance decides.
        try IXcm(XCM).weighMessage(message) returns (IXcm.Weight memory w) {
            (bool ok, ) = XCM.call(abi.encodeCall(IXcm.execute, (message, w)));
            ok;
        } catch {}
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

    /// Anyone, once payouts are open: send `sweepTo` whatever the contract holds
    /// beyond what contributors are still owed. Never touches a contributor's share.
    function sweep() external nonReentrant {
        if (state != State.Returning) revert WrongState();
        uint256 bal = address(this).balance;
        if (bal <= total) revert NothingToSweep();
        uint256 amount = bal - total;
        amount -= amount % weiPerPlanck;
        if (amount == 0) revert NothingToSweep();
        emit Swept(sweepTo, amount);
        (bool ok, ) = sweepTo.call{value: amount}("");
        require(ok);
    }

    // ---------------------------------------------------------------- views

    function contributorCount() external view returns (uint256) {
        return contributors.length;
    }

    /// What `sweep` would send now (0 outside Returning).
    function excess() external view returns (uint256) {
        if (state != State.Returning || address(this).balance <= total) return 0;
        uint256 amount = address(this).balance - total;
        return amount - (amount % weiPerPlanck);
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
}
