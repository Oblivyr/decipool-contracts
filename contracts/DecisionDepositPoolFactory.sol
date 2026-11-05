// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "./DecisionDepositPool.sol";

/// Creates decision deposit pools and keeps the list of every pool it created.
///
/// A pool created here runs exactly the DecisionDepositPool code compiled into this
/// factory, so `isPool(x)` is the proof a page needs that `x` is a real pool and not
/// a look-alike contract. The chain-specific parameters (Referenda pallet index, call
/// indices, wei per planck) are fixed when the factory is deployed, so a pool created
/// here cannot be pointed at a different call.
///
/// Anyone can create a pool. The factory has no owner and no power over its pools:
/// it only deploys them and remembers them. So that nobody can create a pool that
/// looks right but nobody can use, the smallest payment is at most a tenth of the
/// deposit and funding closes within 30 days. Lists are readable in pages
/// (`poolsForRange`), so many pools for one referendum cannot make reading them fail.
///
/// A pool with the wrong deposit for its track can never place it (the pool checks the exact amount), so its contributors
/// withdraw or are paid back after the deadline; a page should still compare the
/// deposit with the track's before anyone pays in.
contract DecisionDepositPoolFactory {
    uint8 public immutable referendaPallet;
    uint8 public immutable placeCallIndex;
    uint8 public immutable refundCallIndex;
    uint256 public immutable weiPerPlanck;

    address[] public pools;
    mapping(address => bool) public isPool;
    mapping(uint32 => address[]) private byReferendum;
    // The same pools, also listed by (referendum, deposit): a page asks for the track's exact deposit,
    // so pools made with any other deposit (which can never place it) never crowd the real ones out.
    mapping(uint32 => mapping(uint256 => address[])) private byReferendumDeposit;

    uint256 public constant MAX_FUNDING_PERIOD = 30 days;

    event PoolCreated(
        address indexed pool,
        uint32 indexed referendum,
        address indexed creator,
        uint256 deposit,
        uint256 minContribution,
        uint64 fundingDeadline
    );

    constructor(uint8 referendaPallet_, uint8 placeCallIndex_, uint8 refundCallIndex_, uint256 weiPerPlanck_) {
        require(weiPerPlanck_ > 0);
        referendaPallet = referendaPallet_;
        placeCallIndex = placeCallIndex_;
        refundCallIndex = refundCallIndex_;
        weiPerPlanck = weiPerPlanck_;
    }

    /// Anyone: create a pool for one referendum. Amounts in planck, deadline in unix seconds.
    function create(uint32 referendum, uint256 depositPlanck, uint256 minContributionPlanck, uint64 fundingDeadline)
        external
        returns (address pool)
    {
        // A pool whose smallest payment is most of the deposit, or that stays open for months,
        // could sit on a referendum and turn people away. The pool itself checks the rest.
        require(minContributionPlanck * 10 <= depositPlanck, "min above 10% of deposit");
        require(fundingDeadline <= block.timestamp + MAX_FUNDING_PERIOD, "funding period above 30 days");
        pool = address(
            new DecisionDepositPool(
                referendum,
                depositPlanck,
                minContributionPlanck,
                fundingDeadline,
                referendaPallet,
                placeCallIndex,
                refundCallIndex,
                weiPerPlanck
            )
        );
        pools.push(pool);
        isPool[pool] = true;
        byReferendum[referendum].push(pool);
        byReferendumDeposit[referendum][depositPlanck].push(pool);
        emit PoolCreated(
            pool,
            referendum,
            msg.sender,
            depositPlanck * weiPerPlanck,
            minContributionPlanck * weiPerPlanck,
            fundingDeadline
        );
    }

    function poolCount() external view returns (uint256) {
        return pools.length;
    }

    /// Every pool created for one referendum, oldest first. For long lists, use poolsForRange.
    function poolsFor(uint32 referendum) external view returns (address[] memory) {
        return byReferendum[referendum];
    }

    function poolCountFor(uint32 referendum) external view returns (uint256) {
        return byReferendum[referendum].length;
    }

    /// Up to `limit` pools for one referendum, starting at `offset` (oldest first).
    function poolsForRange(uint32 referendum, uint256 offset, uint256 limit) external view returns (address[] memory) {
        return _slice(byReferendum[referendum], offset, limit);
    }

    /// Pools for one referendum with exactly this deposit (planck): the ones that can place the track's deposit.
    function poolCountForDeposit(uint32 referendum, uint256 depositPlanck) external view returns (uint256) {
        return byReferendumDeposit[referendum][depositPlanck].length;
    }

    function poolsForDepositRange(uint32 referendum, uint256 depositPlanck, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory)
    {
        return _slice(byReferendumDeposit[referendum][depositPlanck], offset, limit);
    }

    // Written so that no argument can overflow: a huge `limit` simply means "to the end".
    function _slice(address[] storage all, uint256 offset, uint256 limit) private view returns (address[] memory out) {
        if (offset >= all.length) return new address[](0);
        uint256 end = limit >= all.length - offset ? all.length : offset + limit;
        out = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) out[i - offset] = all[i];
    }
}
