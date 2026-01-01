# Argon's Management Console Deploy

This folder contains everything argon command will run on a vm. Everything will run in docker (or podman).


## Bitcoin
This will run bitcoin on the node which is needed for argon to work. For this to work nothing needs to be exposed and all communication with argon will happen internally (inside docker isolated network).

## Argon
Does exactly what you expect: run argon miner.


## Bitcoin state image
Image that will periodically get updated and will contain bitcoin state so we can speed up loading quite a bit. Github has limit on docker images of 10GB per layer, so to work around that we make layers of 5GB.

Build image and push:
```sh
docker compose build bitcoin-data
docker compose push bitcoin-data

```

TODO's here:
- Automate this in ci/cd
- Link images in github project

## How run this on a fresh server

```sh
# Install docker (modify as need, eg sudo)
curl -fsSL get.docker.com | bash
usermod -aG docker $USER

# Copy bitcoin state to speed up loading by hours/days
# Be careful this will override data that is already there
docker compose run --remove-orphans --pull=always bitcoin-data
docker compose run --remove-orphans --pull=always argon-data


# Start argon and bitcoin
docker compose up -d
# To start using testnet config make sure to use this env file
docker compose --env-file=.env.testnet up -d


# View logs for progress
docker compose logs -f
docker compose logs -f bitcoin
docker compose logs -f argon-miner
...

# To stop it
docker compose down
```
