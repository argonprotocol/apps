# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Argon Operations** is a desktop application built with Tauri 2 (Rust backend) and Vue 3 (TypeScript frontend) for interacting with the Argon blockchain. It provides mining automation, Bitcoin vault operations, and treasury pool management.

## Architecture

### Monorepo Structure
- **Frontend**: Vue 3 + TypeScript in `/src-vue/` (main desktop app UI)
- **Backend**: Rust/Tauri in `/src-tauri/` (desktop app backend)
- **Bot**: Express.js API server in `/bot/` (mining automation server)
- **Calculator**: Shared bidding logic in `/calculator/` (used by both frontend and bot)

### Key Dependencies
- **External dependency**: `@argonprotocol/mainchain` from `../mainchain/client/nodejs` (Argon blockchain client)
- **Frontend**: Vue 3, Pinia for state, Tailwind CSS 4.0, Chart.js for visualizations
- **Backend**: Tauri 2 with SQL plugin (SQLite), SSH client (russh), Bitcoin integration
- **Bot**: Express.js with CORS, uses calculator workspace for bidding logic

## Development Commands

### Primary Workflow
```bash
# Install dependencies
yarn install

# Development mode (frontend + backend)
yarn dev

# Build desktop application
yarn tauri build

# Type checking (all workspaces)
yarn typecheck

# Code formatting
yarn lint

# Update Bitcoin data
yarn update-data
```

### Bot Development
```bash
# Run bot server
cd bot && yarn start

# Run bot tests (requires ARGON_PROJECT_ROOT=../../mainchain)
cd bot && yarn test
```

### Tauri Commands
```bash
# Development with Tauri
yarn tauri dev

# Direct Tauri CLI access
yarn tauri [command]
```

## Testing

- **Bot**: Vitest with 2-minute timeout, requires `ARGON_PROJECT_ROOT=../../mainchain` environment variable
- **Main app**: No dedicated test framework; relies on TypeScript checking via `yarn typecheck`

## Build Configuration

### Environment Requirements
- **Node.js**: Yarn 4.10.3 package manager
- **Rust**: Version 1.86.0 (specified in `rust-toolchain.toml`)
- **Tauri CLI**: v2 for desktop development

### Key Files
- `package.json`: Main project scripts and workspace configuration
- `src-tauri/Cargo.toml`: Rust dependencies and Tauri setup
- `src-tauri/tauri.conf.json`: Desktop app configuration
- `vite.config.ts`: Frontend build with SVG loader and port 1420
- `tailwind.config.js`: CSS framework setup

## State Management & Data Flow

### Frontend Architecture
- **State**: Regular state stores using Vue.reactive in `/src-vue/stores/` (bitcoin, blockchain, config, stats, vaults)
- **Database**: SQLite via Tauri SQL plugin with migrations in `/src-tauri/migrations/`
- **Security**: Keyring integration for credential storage
- **External APIs**: HTTP plugin for web requests, SSH for server management

### Backend Services
- **Bitcoin integration**: Custom Bitcoin library at `argon-bitcoin` from mainchain project
- **SSH management**: Server provisioning and configuration via russh
- **Database**: SQLite with migration system for local data persistence

## Deployment

### Desktop Distribution
- Cross-platform builds for Windows/macOS
- Unsigned binaries (require manual security approval)
- GitHub Actions for automated builds on `version` branch pushes

### Cloud Services
- Docker Compose configuration in `/server/`
- Services: Bitcoin node, Argon miner, Bot API, Bitcoin data container
- Bot can be deployed independently as Express.js server

## Development Notes

- **Workspace dependencies**: Calculator logic shared between frontend and bot
- **External project dependency**: Requires `../mainchain` directory with Argon blockchain client
- **Data generators**: Bitcoin fee/price data fetching in `/data-generators/`
- **UI components**: Tailwind-based Vue components with SVG icon integration
- **Security**: Never commit sensitive data; uses keyring for secure storage
