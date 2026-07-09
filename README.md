# Gas Flow

Gas Flow is an EIP-7702 gas sponsorship system that lets users execute on-chain
actions without holding native gas tokens. Users sign an execution intent,
relayers submit the transaction and pay ETH gas, and the protocol compensates
relayers from a staking vault using supported ERC-20 fee tokens.

This repository contains:

- `contracts/`: Solidity contracts for the Delegator, Config, and StakeVault.
- `relayer/`: TypeScript relayer service for fee estimation, signature
  validation, simulation, and sponsored transaction submission.
- `docs/`: Architecture and protocol notes.

The project is currently in active development and testing on Sepolia.
