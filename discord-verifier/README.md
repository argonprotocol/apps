# Argon Discord Verifier

Users run `/connect-desktop-app`, copy its private one-time code into Argon Desktop, and submit one signed request to
`POST /role-proofs`. Once connected, Desktop can submit signed role updates to `POST /role-updates` without another
Discord command. The verifier adds newly proven roles and never removes an earned role. There is no OAuth, browser
callback, polling, or background role monitoring.

Users can verify another account from its user menu, a message's Apps menu, or `/verify-argon-role`. Verification shows
the account's highest proven Argon role. The bot does not monitor messages, inspect links, moderate channels, or read
message content.

## Configuration

Copy `.env.example` to `.env`. The service reads that file directly; deployment-provided environment variables take
precedence. Never commit the bot token or live database.

The public Discord application identity, official guild, role IDs and display names, recognized developer IDs, and
service URL live in `core/src/DiscordVerification.ts`. Both the bot and Desktop use that committed configuration.

The role-proof endpoint accepts only public cryptographic material: the one-time Discord code, operational account ID,
operational account signature, and (when available) the upstream operator's existing access proof. It does not accept
invite codes, router sessions, default or treasury account details, wallet derivation data, balances, or certification
history. Codes and signatures are validated in memory and are not written to SQLite.

## Deployment

Build from the repository root:

```sh
docker build -f discord-verifier/Dockerfile -t argon-discord-verifier .
```

Mount `/var/lib/argon-discord-verifier` on persistent storage. Run the container on a keyless RPC host or separate
application server, never on a validator or GRANDPA authority holding signing material.
