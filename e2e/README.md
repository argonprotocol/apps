# Running on mac
You need to install and run [XQuartz](https://www.xquartz.org/) and [Lima](https://github.com/lima-vm/lima).

## Create Lima VM
Run `./test-from-lima.sh` to create and start Lima VM.

## Running Test on Lima VM
You'll develop on your mac, and run `test-from-lima.sh` to sync files and re-run tests

## Customizing the runtime to boot with

You can customize the bootup runtime for the e2e argon by running the argon/chainspec.ts file as such
```bash
tsx argon/chainspec.ts /path/to/your/custom/wasm/file.wasm
or 
yarn docker:argon:chainspec /path/to/your/custom/wasm/file.wasm
```
This will create a custom chainspec file. You'll use this file as your `ARGON_CHAIN=/chainspec.raw.json` when booting the network (that's where it will be mounted). You can simplify this by just running 
```bash
yarn dev:docker:custom
```
