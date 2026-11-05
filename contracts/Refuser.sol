// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

interface IPool {
    function contribute() external payable;
}

/// Test-only contributor whose address refuses incoming payments, to prove one
/// bad address cannot block everyone else's repayment.
contract Refuser {
    function join(address pool) external payable {
        IPool(pool).contribute{value: msg.value}();
    }

    receive() external payable {
        revert("no thanks");
    }
}
