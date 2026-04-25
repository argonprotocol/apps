# Server Architecture

This folder contains the dockerized services installed onto a server.

The main architectural idea is:

- keep one small, easy-to-boot HTTP surface for installation and operational checks
- keep long-running chain watchers and worker processes out of that edge layer
- avoid exploding the stack into many tiny services

Today, `router` is that bootable edge service. `bot` is the main long-running worker daemon.

## Current Runtime Topology

The stack currently consists of:

- `nginx`
- `router`
- `bot`
- `argon-miner`
- `bitcoin-node`
- `bitcoin-data` as an optional helper image

At a high level:

- `nginx` is the HTTPS gateway into the stack
- `router` is the first HTTP surface we can depend on during startup
- `bot` is the always-on background process
- `argon-miner` and `bitcoin-node` are the local chain services

## Why Router Exists

The router is not just an application API. It is also the operational entrypoint for the server.

That matters because the installer needs something simple it can talk to while the rest of the stack is still booting or syncing. The router is a good fit for that because it:

- boots quickly
- exposes basic HTTP endpoints
- can report on the state of internal services
- acts as the authenticated policy layer for the nginx gateway

Because of that, using the router for policy and narrow HTTP entrypoints makes sense.

## Why Bot Exists

The bot is already more than a bidding process. It is the main long-running daemon in the stack.

Today it already owns:

- mining block sync
- mining history
- block watching
- the websocket/http API used by the app
- bidding execution
- persistent worker state under `/data`

So conceptually, the bot is the right home for stateful background services that:

- poll chain state
- watch blocks continuously
- maintain queues
- reconcile submitted transactions
- recover in-progress work after restart

## Current Responsibilities

### Router

Current router responsibilities:

- provide a stable bootstrap HTTP surface
- expose basic Argon and Bitcoin status over HTTP
- support installer and service readiness checks
- hold lightweight server-side application state
- serve invite/bootstrap style flows
- own treasury invite and bitcoin lock coupon records

### Bot

Current bot responsibilities:

- run the mining sync pipeline
- persist mining worker state
- expose bot state/history/bids over its service API
- run the autobidder
- own long-running worker-style runtime behavior
- own delegated bitcoin lock relay execution and recovery

Important nuance:

- the bot is always deployed and started in docker
- today it still assumes bidding rules exist at startup, so it is not yet a perfectly clean dormant multi-service daemon

## Intended Direction

The architecture we want is not "one new service per feature." It is:

- `router` as the bootable edge and policy layer behind nginx
- `bot` as the internal daemon that hosts long-running worker services

That means the likely future shape is:

### Router as operational edge/policy

Router should be the place for:

- bootstrap and health endpoints
- stable external HTTP entrypoints
- authenticated routing
- lightweight policy decisions
- user, invite, and permission ownership
- treasury invite and bitcoin lock coupon ownership
- proxying requests to internal worker services

### Bot as multi-service worker daemon

Bot should grow from "mining bot" into "server worker daemon."

That means it can reasonably host multiple internal worker-style services, for example:

- mining services
- transaction relay services
- chain polling and reconciliation services
- other long-running operational jobs

The important rule is that these are daemon-like responsibilities, not public edge responsibilities.

## What Belongs Where

As a rule of thumb:

### Put it on `router` if it is mostly:

- easy-to-boot HTTP
- installation/readiness/status reporting
- authentication or authorization
- request validation or policy enforcement
- light persistence around users, access, or configuration
- treasury invite or coupon lifecycle state
- proxying to an internal service

### Put it on `bot` if it is mostly:

- a long-running watcher
- queue management
- retry/recovery logic
- transaction reconciliation
- chain polling
- stateful background execution
- work that should survive process restart and resume safely
- delegated transaction execution after router-side policy checks

## Persistence Direction

We likely want two different persistence styles in this stack.

### Router persistence

Router is a good home for lighter application state, such as:

- profiles
- invites
- bitcoin lock coupons
- access and permission state
- lightweight router auth and session records

### Bot persistence

Bot already persists worker state under `/data`.

For more execution-oriented services, a relational store in the bot is likely a better fit than ad hoc JSON files. Worker domains that have:

- queues
- reservations
- retries
- in-flight job recovery
- transaction lifecycle state

will likely want sqlite in the bot data directory.

This does not mean all state should move into bot. It means worker state should live where the worker runs.

## Startup Model

The current and intended startup ladder is:

1. installer uploads config and server files
2. `router` becomes reachable first
3. `router` provides basic readiness and sync visibility
4. chain services come up and sync
5. `bot` starts and attaches to those services
6. router can proxy or report on internal worker state once bot is ready

This ordering is important and should be preserved.

## Treasury Coupon Boundary

For treasury flows, the split is:

- `router` owns treasury users, invites, permissions, and bitcoin lock coupon records
- `router` decides whether a coupon or invite can be used
- `bot` is the better home for any long-running bitcoin lock relay worker behavior

That means the coupon itself belongs with the invite and access model on `router`, while any queued or reconciled delegated transaction execution belongs with `bot`.

This keeps the user and permission source of truth in one place and avoids splitting coupon lifecycle ownership across services.

## Gateway Routing

This section describes the server bundle wiring.

Public host ports:

- `nginx` publishes `${GATEWAY_PORT:-443}:443` as the public HTTPS gateway
- `argon-miner` publishes only `${ARGON_P2P_PORT}:${ARGON_P2P_PORT}`
- `bitcoin-node` publishes only `${BITCOIN_P2P_PORT}:${BITCOIN_P2P_PORT}`

Internal Docker-network endpoints:

- `router` listens as `router:8080`
- `bot` listens as `bot:8080`
- `argon-miner` unsafe RPC listens as `argon-miner:9944`
- `argon-miner` safe RPC listens as `argon-miner:9945`
- Bitcoin RPC stays internal to the Docker network

nginx routes:

- `/auth/*` and `/` proxy to `router:8080`
- `/bot/*` requires `/auth/verify/bot`, then proxies websocket traffic to `bot:8080`
- `/substrate/*` requires `/auth/verify/substrate`, then proxies safe websocket traffic to `argon-miner:9945`

The bot uses `LOCAL_RPC_URL=ws://argon-miner:9944` because mining key registration still needs unsafe RPC methods such
as `author.insertKey` and `author.hasKey`. App traffic uses the nginx-routed safe RPC endpoint instead.

Certificate material is prepared before nginx starts and copied into `config/nginx-certs`, which compose mounts at
`/etc/nginx/certs`. Local development uses `yarn dev:gateway-certs` to generate the localhost certificate into that
folder. Production certificate provisioning uses Certbot standalone to write `fullchain.pem` and `privkey.pem` for nginx
to serve.

When a script needs the router's host-local port, it should ask Docker for the selected mapping:

```sh
docker compose port router 8080
```

Leaving `ROUTER_PORT` unset, or setting it to `0`, lets Docker choose a free loopback port for local development and CI.
Set `ROUTER_PORT` only when local diagnostics need a stable host-local router port.

## Fresh Server Notes

Typical local/manual flow:

```sh
# Install docker (modify as needed, e.g. sudo)
curl -fsSL get.docker.com | bash
usermod -aG docker $USER

# Optionally pre-seed bitcoin state
docker compose run --remove-orphans --pull=always bitcoin-data

# Start the stack
docker compose up -d

# Or choose a specific network env
docker compose --env-file=.env.testnet up -d

# Inspect progress
docker compose logs -f
docker compose logs -f router
docker compose logs -f bitcoin-node
docker compose logs -f argon-miner
docker compose logs -f bot

# Stop the stack
docker compose down
```
